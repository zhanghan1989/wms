#!/usr/bin/env bash
# Read-only production diagnostics. Never print process arguments or environment secrets.
set -euo pipefail
printf '\n== Host memory and paging ==\n'
date -u
uptime
free -m
swapon --show --bytes
sysctl vm.swappiness vm.vfs_cache_pressure
for resource in memory io; do cat "/proc/pressure/$resource"; done
vmstat 1 6
printf '\n== Process RSS and swap (KiB; no command arguments) ==\n'
python3 - <<'PY'
from pathlib import Path
rows = []
for path in Path('/proc').glob('[0-9]*/status'):
    try:
        fields = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
        rss = int(fields.get('VmRSS', '0 kB').split()[0])
        swap = int(fields.get('VmSwap', '0 kB').split()[0])
        rows.append((rss, swap, path.parent.name, fields['Name'].strip()))
    except (OSError, ValueError, KeyError):
        continue
print('RSS_KiB SWAP_KiB PID NAME')
for row in sorted(rows, reverse=True)[:20]: print(*row)
print('SWAP SORTED:')
for row in sorted(rows, key=lambda r:r[1], reverse=True)[:15]: print(*row)
print('TOTAL_PROCESS_SWAP_KiB', sum(r[1] for r in rows))
PY
printf '\n== Container memory, restart and OOM counters ==\n'
docker stats --no-stream --format '{{.Name}} memory={{.MemUsage}} percent={{.MemPerc}} cpu={{.CPUPerc}} pids={{.PIDs}}'
for container in wms_api wms_db wms_rakuten_egress wms_redis; do
  docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}} Started={{.State.StartedAt}} MemoryLimit={{.HostConfig.Memory}} SwapLimit={{.HostConfig.MemorySwap}}' "$container"
  pid=$(docker inspect --format '{{.State.Pid}}' "$container")
  group=$(awk -F: '$1=="0"{print $3}' "/proc/$pid/cgroup")
  for file in memory.current memory.swap.current memory.events memory.pressure; do
    if [[ -r "/sys/fs/cgroup$group/$file" ]]; then
      printf '%s %s\n' "$container" "$file"
      cat "/sys/fs/cgroup$group/$file"
    fi
  done
done
printf '\n== Kernel OOM events (last 7 days) ==\n'
journalctl -k --since '7 days ago' --no-pager 2>/dev/null | awk 'tolower($0) ~ /out of memory|oom-kill|killed process/' | tail -n 25 || true
printf '\n== MySQL memory settings and utilization (no business rows) ==\n'
docker exec -i wms_db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot --batch wms_v1' <<'SQL'
SHOW GLOBAL VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size','innodb_buffer_pool_instances','max_connections','thread_cache_size','table_open_cache','table_definition_cache','performance_schema','tmp_table_size','max_heap_table_size','sort_buffer_size','join_buffer_size','read_buffer_size','read_rnd_buffer_size');
SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Created_tmp_tables','Created_tmp_disk_tables','Innodb_buffer_pool_pages_total','Innodb_buffer_pool_pages_data','Innodb_buffer_pool_pages_free','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests');
SELECT event_name, current_number_of_bytes_used FROM performance_schema.memory_summary_global_by_event_name ORDER BY current_number_of_bytes_used DESC LIMIT 12;
SQL
printf '\n== Public service local health ==\n'
curl --max-time 10 -sS -o /dev/null -w 'root_http=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:3000/
curl --max-time 10 -sS -o /dev/null -w 'auth_http=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:3000/api/auth/me
