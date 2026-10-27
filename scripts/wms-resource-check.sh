#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "$0")/wms-disk-check.sh" "${WMS_DEPLOY_DISK_PATH:-/var/lib/docker}"
# Fail before starting another memory-intensive deployment stage.
available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
minimum_kib=${WMS_DEPLOY_MIN_AVAILABLE_KIB:-307200}
if ! [[ "$minimum_kib" =~ ^[0-9]+$ ]]; then
  echo 'Invalid deployment memory threshold' >&2
  exit 1
fi
free -m
for resource in memory io; do
  if [[ -r "/proc/pressure/$resource" ]]; then
    cat "/proc/pressure/$resource"
    if ! awk -v limit=10 '$1 == "full" {split($3, value, "="); if (value[2] + 0 >= limit) exit 1}' "/proc/pressure/$resource"; then
      echo "Deployment postponed: sustained $resource pressure" >&2
      exit 1
    fi
  fi
done
if (( available_kib < minimum_kib )); then
  echo "Deployment postponed: available memory ${available_kib} KiB below ${minimum_kib} KiB" >&2
  exit 1
fi
