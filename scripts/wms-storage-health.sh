#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
state_dir=${WMS_STORAGE_STATE_DIR:-/var/lib/wms-storage-health}
disk_path=${WMS_STORAGE_DISK_PATH:-/}
warn_percent=${WMS_STORAGE_WARN_PERCENT:-75}
critical_percent=${WMS_STORAGE_CRITICAL_PERCENT:-90}
minimum_bytes=${WMS_STORAGE_MIN_FREE_BYTES:-5368709120}
for value in "$warn_percent" "$critical_percent" "$minimum_bytes"; do
  [[ "$value" =~ ^[0-9]{1,12}$ ]] || { echo 'Invalid storage monitor threshold' >&2; exit 1; }
done
warn_percent=$((10#$warn_percent)); critical_percent=$((10#$critical_percent)); minimum_bytes=$((10#$minimum_bytes))
(( warn_percent > 0 && warn_percent < critical_percent && critical_percent <= 100 )) || exit 1
read -r available_kib used_percent < <(df -Pk -- "$disk_path" | awk 'NR == 2 {gsub(/%/, "", $5); print $4, $5}')
[[ "$available_kib" =~ ^[0-9]+$ && "$used_percent" =~ ^[0-9]+$ ]] || exit 1
available_bytes=$((available_kib * 1024))
now=$(date +%s)
umask 077
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || exit 0
rate=0
remaining_days='unknown'
if [[ -r "$state_dir/baseline" ]]; then
  read -r previous_time previous_free < "$state_dir/baseline" || true
  if [[ "${previous_time:-}" =~ ^[0-9]+$ && "${previous_free:-}" =~ ^[0-9]+$ ]]; then
    elapsed=$((now - previous_time))
    if (( elapsed >= 3600 )); then
      consumed=$((previous_free - available_bytes))
      if (( consumed > 0 )); then
        rate=$((consumed * 86400 / elapsed))
        (( rate == 0 )) || remaining_days=$((available_bytes / rate))
      fi
      # Use at least a day for the growth baseline to damp deployment spikes.
      if (( elapsed >= 86400 )); then
        printf '%s %s\n' "$now" "$available_bytes" > "$state_dir/baseline.tmp"
        mv -- "$state_dir/baseline.tmp" "$state_dir/baseline"
      fi
    fi
  fi
fi
if [[ ! -s "$state_dir/baseline" ]]; then
  printf '%s %s\n' "$now" "$available_bytes" > "$state_dir/baseline"
fi
severity=OK
if (( used_percent >= critical_percent )); then severity=CRITICAL
elif (( used_percent >= 85 )); then severity=HIGH
elif (( used_percent >= warn_percent || available_bytes < minimum_bytes )); then severity=WARNING
fi
if [[ "$remaining_days" != unknown ]] && (( remaining_days < 7 )) && [[ "$severity" == OK ]]; then severity=WARNING; fi
binlog_bytes=0
binlog_path=${WMS_MYSQL_DATA_PATH:-/var/lib/docker/volumes/wms_mysql_data/_data}
if [[ -d "$binlog_path" ]]; then
  binlog_bytes=$(find "$binlog_path" -maxdepth 1 -type f -name 'binlog.[0-9]*' -printf '%s\n' | awk '{sum+=$1} END {printf "%.0f",sum}')
fi
printf 'time=%s severity=%s used_percent=%s free_bytes=%s growth_bytes_per_day=%s estimated_days=%s binlog_bytes=%s\n' \
  "$now" "$severity" "$used_percent" "$available_bytes" "$rate" "$remaining_days" "$binlog_bytes"
printf '%s %s %s %s\n' "$now" "$available_bytes" "$binlog_bytes" "$severity" > "$state_dir/latest.tmp"
mv -- "$state_dir/latest.tmp" "$state_dir/latest"
previous_severity=$(cat "$state_dir/severity" 2>/dev/null || true)
if [[ "$severity" != "$previous_severity" ]]; then
  logger -t wms-storage-health "severity=$severity used=$used_percent% free_bytes=$available_bytes binlog_bytes=$binlog_bytes estimated_days=$remaining_days"
  printf '%s\n' "$severity" > "$state_dir/severity"
fi
# systemd marks real capacity alerts as failed and records details in journal.
[[ "$severity" == OK ]]
