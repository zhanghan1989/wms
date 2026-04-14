#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOP_DB=0

say() {
  printf '%s\n' "$1"
}

for arg in "$@"; do
  case "$arg" in
    --stop-db)
      STOP_DB=1
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

rm -f "$ROOT_DIR/.wms-dev/api.pid" "$ROOT_DIR/.wms-dev/api.log"

if [[ "$STOP_DB" -eq 1 ]]; then
  if command -v mysql-wms-stop >/dev/null 2>&1; then
    mysql-wms-stop
  else
    say "mysql-wms-stop is not available. Stop MySQL manually if needed."
  fi
else
  say "API should already be stopped by Ctrl+C in the work:start terminal."
  say "MySQL was left running."
fi

git -C "$ROOT_DIR" status --short --branch
