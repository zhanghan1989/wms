#!/usr/bin/env bash
# Run from the Compose project directory before the first deployment with /app/data mounted.
set -euo pipefail
mkdir -p data
if ! docker container inspect wms_api >/dev/null 2>&1; then
  exit 0
fi
if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' wms_api | grep -qx /app/data; then
  exit 0
fi
# Stop writes while copying the old container layer. On failure, resume the old API.
was_running="$(docker inspect --format '{{.State.Running}}' wms_api)"
resume_on_failure() {
  result=$?
  if [ "$result" -ne 0 ] && [ "$was_running" = true ]; then
    docker start wms_api >/dev/null || true
  fi
  exit "$result"
}
trap resume_on_failure EXIT
if [ "$was_running" = true ]; then docker stop wms_api >/dev/null; fi
docker cp wms_api:/app/data/. ./data/
printf '%s\n' 'Preserved API data for the persistent /app/data mount.'
