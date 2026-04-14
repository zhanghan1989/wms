#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "$(git -C "$ROOT_DIR" status --short)" ]]; then
  printf 'Error: working tree is not clean. Commit or stash changes before syncing develop.\n' >&2
  git -C "$ROOT_DIR" status --short
  exit 1
fi

git -C "$ROOT_DIR" fetch origin

if ! git -C "$ROOT_DIR" show-ref --verify --quiet refs/heads/develop; then
  printf 'Error: local develop branch does not exist.\n' >&2
  exit 1
fi

git -C "$ROOT_DIR" checkout develop

if git -C "$ROOT_DIR" rev-parse --verify origin/develop >/dev/null 2>&1; then
  git -C "$ROOT_DIR" merge --ff-only origin/develop
fi

if ! git -C "$ROOT_DIR" rev-parse --verify origin/main >/dev/null 2>&1; then
  printf 'Error: origin/main not found. Check remote configuration.\n' >&2
  exit 1
fi

git -C "$ROOT_DIR" merge --no-edit origin/main

printf '\n'
printf 'develop is ready for daily work.\n'
printf 'Next step: npm run work:start\n'
