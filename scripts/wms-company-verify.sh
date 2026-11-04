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
    [[ "$after" -eq "$((before + COMPANY_PENDING_MIGRATIONS))" ]]
  elif [[ "$table" == brands || "$table" == department_options ]]; then
    [[ "$after" -ge "$before" ]]
  else
    [[ "$after" == "$before" ]] || { echo "Row count changed unexpectedly: $table" >&2; exit 1; }
  fi
done < "$COMPANY_BACKUP_DIR/counts.before.tsv"
NAME="$(printf 'SELECT name FROM companies WHERE id=1 AND status=1;\n' | query)"
[[ "$NAME" == XYJG ]] || { echo 'Company 1 is not active XYJG.' >&2; exit 1; }
invalid_accounts="$(printf "SELECT COUNT(*) FROM users WHERE ((role='system_admin' OR department='overseas_warehouse') AND company_id IS NOT NULL) OR (role<>'system_admin' AND department<>'overseas_warehouse' AND company_id IS NULL);\n" | query)"
[[ "$invalid_accounts" == 0 ]] || { echo 'Account affiliation verification failed.' >&2; exit 1; }
printf "SELECT id,company_id FROM users WHERE role<>'system_admin' AND department<>'overseas_warehouse' ORDER BY id;\n" | query > "$COMPANY_BACKUP_DIR/business-users.after.tsv"
cmp "$COMPANY_BACKUP_DIR/business-users.before.tsv" "$COMPANY_BACKUP_DIR/business-users.after.tsv"
: > "$COMPANY_BACKUP_DIR/ownership.after.tsv"
while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]] || exit 1
  printf "SELECT '%s',company_id,COUNT(*) FROM \`%s\` GROUP BY company_id ORDER BY company_id;\n" "$table" "$table" | query >> "$COMPANY_BACKUP_DIR/ownership.after.tsv"
done < "$COMPANY_BACKUP_DIR/scoped-tables.before.txt"
cmp "$COMPANY_BACKUP_DIR/ownership.before.tsv" "$COMPANY_BACKUP_DIR/ownership.after.tsv"
printf 'SELECT COALESCE(SUM(stock_qty),0) FROM master_products;\n' | query > "$COMPANY_BACKUP_DIR/stock.after.txt"
cmp "$COMPANY_BACKUP_DIR/stock.before.txt" "$COMPANY_BACKUP_DIR/stock.after.txt"
printf 'Verified: historical rows retained, stock totals unchanged, business ownership retained, warehouse accounts are shared and system administrators have no company.\n' | tee "$COMPANY_BACKUP_DIR/migration-verification.txt"
