#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/apps/api/node_modules/@prisma/client"
GENERATED_DIR="$ROOT_DIR/apps/api/node_modules/.prisma"
CLIENT_LINK="$CLIENT_DIR/.prisma"

# npm may hoist both packages to the workspace root. In that layout Node resolves
# `.prisma/client` from the same root node_modules directory without a symlink.
if [[ ! -d "$CLIENT_DIR" \
  && -d "$ROOT_DIR/node_modules/@prisma/client" \
  && -d "$ROOT_DIR/node_modules/.prisma/client" ]]; then
  printf 'Prisma client is hoisted; no workspace link is required.\n'
  exit 0
fi

if [[ ! -d "$CLIENT_DIR" ]]; then
  printf 'Error: Prisma client package is missing. Run npm install first.\n' >&2
  exit 1
fi

if [[ ! -d "$GENERATED_DIR" ]]; then
  printf 'Error: Generated Prisma client is missing. Run npm run -w api prisma:generate first.\n' >&2
  exit 1
fi

if [[ -L "$CLIENT_LINK" ]]; then
  exit 0
fi

if [[ -e "$CLIENT_LINK" ]]; then
  printf 'Error: %s exists and is not a symlink.\n' "$CLIENT_LINK" >&2
  exit 1
fi

ln -s ../.prisma "$CLIENT_LINK"
printf 'Created Prisma client link: %s -> ../.prisma\n' "$CLIENT_LINK"
