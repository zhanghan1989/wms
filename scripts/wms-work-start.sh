#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="http://127.0.0.1:3000"
API_CMD="$ROOT_DIR/node_modules/.bin/ts-node-dev"

say() {
  printf '%s\n' "$1"
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

ensure_not_main() {
  local branch
  branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || true)"
  if [[ "$branch" == "main" ]]; then
    fail "Current branch is main. Switch to develop or a feature branch before starting work."
  fi
}

ensure_env() {
  [[ -f "$ROOT_DIR/apps/api/.env" ]] || fail "Missing apps/api/.env"
  [[ -d "$ROOT_DIR/node_modules" ]] || fail "Missing node_modules. Run: npm install"
  [[ -x "$API_CMD" ]] || fail "Missing ts-node-dev executable. Run: npm install"
}

ensure_mysql() {
  if command -v mysql-wms-start >/dev/null 2>&1; then
    mysql-wms-start >/dev/null
    return
  fi

  if command -v mysqladmin >/dev/null 2>&1 && mysqladmin --protocol=tcp -h127.0.0.1 -P3306 -uroot -proot ping >/dev/null 2>&1; then
    return
  fi

  fail "MySQL is not reachable on 127.0.0.1:3306. Start local MySQL first."
}

api_is_running() {
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/auth/me" || true)"
  [[ "$http_code" == "200" || "$http_code" == "401" ]]
}

ensure_not_main
ensure_env
ensure_mysql

if api_is_running; then
  fail "Another service is already responding on port 3000. Stop it before running work:start."
fi

say "Work environment is ready."
say "MySQL is ready on 127.0.0.1:3306"
say "Starting API with hot reload on $API_URL"
say "Default login: admin / Admin@123"

cd "$ROOT_DIR"
exec npm run start:api
