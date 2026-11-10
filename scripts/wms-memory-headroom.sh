#!/usr/bin/env bash
# Add overflow swap without stopping services or disabling the existing swap.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Requires root'; exit 1; }
file=/swapfile.wms-reserve
bytes=1073741824
printf '\n== Before ==\n'
free -m
swapon --show --bytes
api_before=$(docker inspect --format '{{.State.StartedAt}}' wms_api)
db_before=$(docker inspect --format '{{.State.StartedAt}}' wms_db)
if ! swapon --noheadings --raw --show=NAME | awk -v path="$file" '$0==path{found=1} END{exit !found}'; then
  [[ ! -e "$file" ]] || { echo 'Reserve file already exists but is inactive; refusing to overwrite'; exit 1; }
  filesystem=$(findmnt -n -o FSTYPE -T /)
  [[ "$filesystem" == ext4 || "$filesystem" == xfs ]] || { echo 'Unsupported filesystem for reserve swap'; exit 1; }
  available=$(df -B1 --output=avail / | tail -n1 | tr -d ' ')
  (( available >= bytes + 3221225472 )) || { echo 'Not enough free disk to retain 3 GiB reserve'; exit 1; }
  fallocate -l "$bytes" "$file"
  chmod 600 "$file"
  mkswap "$file"
  # Existing swap remains active; the lower priority makes this overflow capacity.
  swapon "$file"
fi
if ! awk -v path="$file" '$1==path{found=1} END{exit !found}' /etc/fstab; then
  backup="/etc/fstab.before-wms-reserve-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p /etc/fstab "$backup"
  printf '\n%s none swap sw 0 0\n' "$file" >> /etc/fstab
  echo 'Reserved swap persisted in fstab; previous fstab backed up'
fi
[[ "$api_before" == "$(docker inspect --format '{{.State.StartedAt}}' wms_api)" ]]
[[ "$db_before" == "$(docker inspect --format '{{.State.StartedAt}}' wms_db)" ]]
printf '\n== After ==\n'
free -m
swapon --show --bytes
vmstat 1 6
for resource in memory io; do cat "/proc/pressure/$resource"; done
curl --max-time 10 -fsS -o /dev/null -w 'root_http=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:3000/
curl --max-time 10 -sS -o /dev/null -w 'auth_http=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:3000/api/auth/me
echo 'API and database start times unchanged; no service restarted'
