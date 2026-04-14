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

if [[ "$BRANCH" != "develop" ]]; then
  printf 'Error: current branch is %s. Switch to develop before releasing main.\n' "$BRANCH" >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT_DIR" status --short)" ]]; then
  printf 'Error: working tree is not clean. Commit or stash changes before releasing.\n' >&2
  git -C "$ROOT_DIR" status --short
  exit 1
fi

git -C "$ROOT_DIR" fetch origin

if ! git -C "$ROOT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  printf 'Error: develop has no upstream branch. Push develop first.\n' >&2
  exit 1
fi

read -r BEHIND AHEAD <<< "$(git -C "$ROOT_DIR" rev-list --left-right --count '@{u}'...HEAD)"
if [[ "$BEHIND" != "0" || "$AHEAD" != "0" ]]; then
  printf 'Error: develop is not in sync with its upstream (behind=%s, ahead=%s).\n' "$BEHIND" "$AHEAD" >&2
  printf 'Run npm run push:branch or pull the latest develop changes first.\n' >&2
  exit 1
fi

if ! git -C "$ROOT_DIR" merge-base --is-ancestor origin/main HEAD; then
  printf 'Error: develop does not contain the latest origin/main.\n' >&2
  printf 'Run npm run branch:sync-develop first.\n' >&2
  exit 1
fi

if [[ "$RUN_CHECKS" -eq 1 ]]; then
  cd "$ROOT_DIR"
  npm run prisma:generate:api
  npm run ci:verify
fi

if [[ "$AUTO_YES" -ne 1 ]]; then
  printf 'This will fast-forward main to the current develop commit and push origin/main. Continue? [y/N] '
  read -r reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    printf 'Aborted.\n'
    exit 1
  fi
fi

DEVELOP_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"

git -C "$ROOT_DIR" checkout main
git -C "$ROOT_DIR" merge --ff-only origin/main
git -C "$ROOT_DIR" merge --ff-only "$DEVELOP_SHA"
git -C "$ROOT_DIR" push origin main
git -C "$ROOT_DIR" checkout develop

printf '\n'
printf 'main has been updated from develop and pushed.\n'
printf 'GitHub Actions deployment should start automatically.\n'
