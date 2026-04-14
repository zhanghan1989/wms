#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_CHECKS=1
AUTO_YES=0

for arg in "$@"; do
  case "$arg" in
    --skip-checks)
      RUN_CHECKS=0
      ;;
    --yes)
      AUTO_YES=1
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"

if [[ "$BRANCH" != "main" ]]; then
  printf 'Error: current branch is %s. Switch to main before deploying.\n' "$BRANCH" >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT_DIR" status --short)" ]]; then
  printf 'Error: working tree is not clean. Commit or stash changes before deploying.\n' >&2
  git -C "$ROOT_DIR" status --short
  exit 1
fi

if [[ "$RUN_CHECKS" -eq 1 ]]; then
  cd "$ROOT_DIR"
  npm run prisma:generate:api
  npm run ci:verify
fi

if [[ "$AUTO_YES" -ne 1 ]]; then
  printf 'This will push main and trigger GitHub Actions deployment. Continue? [y/N] '
  read -r reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    printf 'Aborted.\n'
    exit 1
  fi
fi

git -C "$ROOT_DIR" push origin main
