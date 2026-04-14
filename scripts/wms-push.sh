#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_CHECKS=1

for arg in "$@"; do
  case "$arg" in
    --skip-checks)
      RUN_CHECKS=0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"
[[ -n "$BRANCH" ]] || { printf 'Error: unable to determine current branch\n' >&2; exit 1; }

if [[ "$BRANCH" == "main" ]]; then
  printf 'Error: current branch is main. Use scripts/wms-deploy-main.sh for deployment pushes.\n' >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT_DIR" status --short)" ]]; then
  printf 'Error: working tree is not clean. Commit or stash changes before pushing.\n' >&2
  git -C "$ROOT_DIR" status --short
  exit 1
fi

if [[ "$RUN_CHECKS" -eq 1 ]]; then
  cd "$ROOT_DIR"
  npm run prisma:generate:api
  npm run ci:verify
fi

if git -C "$ROOT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git -C "$ROOT_DIR" push
else
  git -C "$ROOT_DIR" push -u origin "$BRANCH"
fi
