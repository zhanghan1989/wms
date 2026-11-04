#!/usr/bin/env bash
# Runs on ECS immediately before the first company-isolation migration.
set -euo pipefail
umask 077
RECEIPT="${1:?Usage: wms-company-backup.sh RECEIPT_FILE}"
MIGRATION=20261104100000_company_isolation
query() {
  docker exec -i wms_db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot --batch --raw --skip-column-names wms_v1'
}
PENDING="$(printf "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='%s' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;\n" "$MIGRATION" | query)"
printf 'COMPANY_BACKUP_PENDING=0\n' > "$RECEIPT"
if [[ "$PENDING" == 1 ]]; then
  echo 'Company isolation migration is already applied.'
  exit 0
fi
FAILED="$(printf 'SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;\n' | query)"
[[ "$FAILED" == 0 ]] || { echo 'An unresolved migration exists; database was not changed.' >&2; exit 1; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${WMS_BACKUP_ROOT:-$HOME/.wms-pre-migration-backups}/company-isolation-${STAMP}-${DEPLOY_REF:-manual}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
DB_BYTES="$(printf "SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema='wms_v1';\n" | query)"
[[ "$DB_BYTES" =~ ^[0-9]+$ ]] || { echo 'Unable to estimate database backup space.' >&2; exit 1; }
# Reserve room for the SQL dump, isolated restore and temporary database files,
# on top of the deployment's normal free-space reserve, before pausing the API.
bash scripts/wms-disk-check.sh "$BACKUP_DIR" "$((DB_BYTES * 4 + 536870912))"
BACKUP_FILE="$BACKUP_DIR/wms_v1-before-company-isolation.sql.gz"
VERIFY_CONTAINER="wms-company-restore-${STAMP,,}"
API_WAS_RUNNING="$(docker inspect --format '{{.State.Running}}' wms_api)"
SUCCESS=0
cleanup() {
  result=$?
  trap - EXIT
  docker rm -f -v "$VERIFY_CONTAINER" >/dev/null 2>&1 || true
  if [[ "$SUCCESS" != 1 && "$API_WAS_RUNNING" == true ]]; then
    echo 'Backup verification failed; restarting the unchanged API.' >&2
    docker start wms_api >/dev/null || true
  fi
  exit "$result"
}
trap cleanup EXIT
if [[ "$API_WAS_RUNNING" == true ]]; then
  echo 'Pausing API writers for the backup and migration window.'
  docker stop --time 60 wms_api >/dev/null
fi
printf "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema='wms_v1' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;\n" | query > "$BACKUP_DIR/tables.txt"
while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]] || exit 1
  printf "SELECT '%s',COUNT(*) FROM \`%s\`;\n" "$table" "$table"
done < "$BACKUP_DIR/tables.txt" > "$BACKUP_DIR/counts.sql"
query < "$BACKUP_DIR/counts.sql" > "$BACKUP_DIR/counts.before.tsv"
printf 'SELECT COALESCE(SUM(stock_qty),0) FROM master_products;\n' | query > "$BACKUP_DIR/stock.before.txt"
while IFS= read -r table; do printf 'CHECKSUM TABLE `%s` EXTENDED;\n' "$table"; done < "$BACKUP_DIR/tables.txt" > "$BACKUP_DIR/checksums.sql"
query < "$BACKUP_DIR/checksums.sql" > "$BACKUP_DIR/checksums.before.tsv"
echo 'Creating the full production database backup.'
docker exec wms_db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump -uroot --single-transaction --quick --routines --triggers --events --hex-blob --no-tablespaces --set-gtid-purged=OFF wms_v1' | gzip -1 > "$BACKUP_FILE.partial"
gzip -t "$BACKUP_FILE.partial"
gzip -dc "$BACKUP_FILE.partial" | tail -n 8 > "$BACKUP_DIR/dump-footer.txt"
grep -q -- '-- Dump completed on' "$BACKUP_DIR/dump-footer.txt"
mv "$BACKUP_FILE.partial" "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
MYSQL_IMAGE="$(docker inspect --format '{{.Image}}' wms_db)"
echo 'Restoring the backup in an isolated MySQL container (no network, no production volumes).'
docker run --detach --rm --network none --memory 512m --pids-limit 128 --name "$VERIFY_CONTAINER" \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --env MYSQL_DATABASE=wms_v1 \
  "$MYSQL_IMAGE" --innodb-buffer-pool-size=64M --performance-schema=OFF --max-connections=10 --skip-log-bin >/dev/null
READY=0
for _ in $(seq 1 90); do
  if docker exec "$VERIFY_CONTAINER" mysql --protocol=tcp -h127.0.0.1 -uroot -N -e 'SELECT 1' wms_v1 >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[[ "$READY" == 1 ]] || { echo 'Isolated restore database did not become ready.' >&2; exit 1; }
gzip -dc "$BACKUP_FILE" | docker exec -i "$VERIFY_CONTAINER" mysql -uroot wms_v1
docker exec -i "$VERIFY_CONTAINER" mysql -uroot --batch --raw --skip-column-names wms_v1 < "$BACKUP_DIR/counts.sql" > "$BACKUP_DIR/counts.restored.tsv"
docker exec -i "$VERIFY_CONTAINER" mysql -uroot --batch --raw --skip-column-names wms_v1 < "$BACKUP_DIR/checksums.sql" > "$BACKUP_DIR/checksums.restored.tsv"
cmp "$BACKUP_DIR/counts.before.tsv" "$BACKUP_DIR/counts.restored.tsv"
cmp "$BACKUP_DIR/checksums.before.tsv" "$BACKUP_DIR/checksums.restored.tsv"
# Metadata only: never upload the SQL dump or production row data to CI artifacts.
{
  printf 'COMPANY_BACKUP_PENDING=1\n'
  printf 'COMPANY_BACKUP_DIR=%q\n' "$BACKUP_DIR"
  printf 'COMPANY_BACKUP_FILE=%q\n' "$BACKUP_FILE"
  printf 'COMPANY_BACKUP_API_WAS_RUNNING=%q\n' "$API_WAS_RUNNING"
} > "$RECEIPT"
printf 'Backup and isolated restore verified. Backup: %s\n' "$BACKUP_FILE"
sha256sum "$BACKUP_FILE"
SUCCESS=1
