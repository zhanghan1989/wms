#!/usr/bin/env bash
set -euo pipefail
# Reserve free space in addition to this operation's transient working set.
disk_path=${1:-/var/lib/docker}
operation_bytes=${2:-0}
minimum_bytes=${WMS_DEPLOY_MIN_DISK_BYTES:-2147483648}
for value in "$minimum_bytes" "$operation_bytes"; do
  if ! [[ "$value" =~ ^[0-9]{1,12}$ ]]; then
    echo 'Invalid deployment disk threshold' >&2
    exit 1
  fi
done
minimum_bytes=$((10#$minimum_bytes))
operation_bytes=$((10#$operation_bytes))
available_kib=$(df -Pk -- "$disk_path" | awk 'NR == 2 {print $4}')
if ! [[ "$available_kib" =~ ^[0-9]+$ ]]; then
  echo 'Unable to determine available disk space' >&2
  exit 1
fi
available_bytes=$((available_kib * 1024))
required_bytes=$((minimum_bytes + operation_bytes))
echo "Disk check: path=$disk_path available=$available_bytes required=$required_bytes bytes"
if (( available_bytes < required_bytes )); then
  echo 'Deployment postponed: insufficient disk space' >&2
  exit 1
fi
