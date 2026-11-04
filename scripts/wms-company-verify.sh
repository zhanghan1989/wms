#!/usr/bin/env bash
set -euo pipefail
RECEIPT="${1:?Usage: wms-company-verify.sh RECEIPT_FILE}"
# Receipt was generated locally by wms-company-backup.sh, with shell-escaped values.
source "$RECEIPT"
[[ "$COMPANY_BACKUP_PENDING" == 1 ]] || exit 0
query() {
  docker exec -i wms_db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot --batch --raw --skip-column-names wms_v1'
}
sha256sum -c "$COMPANY_BACKUP_FILE.sha256"
while IFS=$'\t' read -r table before; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ && "$before" =~ ^[0-9]+$ ]] || exit 1
  after="$(printf 'SELECT COUNT(*) FROM `%s`;\n' "$table" | query)"
  if [[ "$table" == _prisma_migrations ]]; then
    [[ "$after" -eq "$((before + 1))" ]]
  elif [[ "$table" == brands || "$table" == department_options ]]; then
    [[ "$after" -ge "$before" ]]
  else
    [[ "$after" == "$before" ]] || { echo "Row count changed unexpectedly: $table" >&2; exit 1; }
  fi
done < "$COMPANY_BACKUP_DIR/counts.before.tsv"
NAME="$(printf 'SELECT name FROM companies WHERE id=1 AND status=1;\n' | query)"
[[ "$NAME" == XYJG ]] || { echo 'Company 1 is not active XYJG.' >&2; exit 1; }
printf "SELECT TABLE_NAME FROM information_schema.columns WHERE table_schema='wms_v1' AND COLUMN_NAME='company_id' ORDER BY TABLE_NAME;\n" | query > "$COMPANY_BACKUP_DIR/scoped-tables.txt"
while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]] || exit 1
  wrong="$(printf 'SELECT COUNT(*) FROM `%s` WHERE company_id IS NULL OR company_id<>1;\n' "$table" | query)"
  [[ "$wrong" == 0 ]] || { echo "Historical company ownership mismatch: $table" >&2; exit 1; }
done < "$COMPANY_BACKUP_DIR/scoped-tables.txt"
printf 'SELECT COALESCE(SUM(stock_qty),0) FROM master_products;\n' | query > "$COMPANY_BACKUP_DIR/stock.after.txt"
cmp "$COMPANY_BACKUP_DIR/stock.before.txt" "$COMPANY_BACKUP_DIR/stock.after.txt"
printf 'Verified: historical rows retained, stock totals unchanged, all existing business data belongs to XYJG.\n' | tee "$COMPANY_BACKUP_DIR/migration-verification.txt"
