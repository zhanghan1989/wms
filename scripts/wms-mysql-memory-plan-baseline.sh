#!/usr/bin/env bash
# Read-only metadata for a maintenance proposal; no SQL text or business rows.
set -euo pipefail
docker inspect --format 'DB image={{.Config.Image}} Started={{.State.StartedAt}}' wms_db
docker exec -i wms_db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot --batch wms_v1' <<'SQL'
SELECT VERSION() AS mysql_version;
SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','table_open_cache','table_definition_cache','table_open_cache_instances','performance_schema_digests_size','performance_schema_events_statements_history_long_size','performance_schema_max_table_handles','performance_schema_max_table_instances','performance_schema_max_thread_instances','performance_schema_events_waits_history_long_size','performance_schema_events_stages_history_long_size','performance_schema_events_transactions_history_long_size','innodb_buffer_pool_size','innodb_buffer_pool_dump_at_shutdown','innodb_buffer_pool_load_at_startup','innodb_fast_shutdown','temptable_max_ram','temptable_max_mmap');
SELECT SUBSTRING_INDEX(event_name,'/',2) AS category, ROUND(SUM(current_number_of_bytes_used)/1048576,1) AS current_mib FROM performance_schema.memory_summary_global_by_event_name GROUP BY SUBSTRING_INDEX(event_name,'/',2) ORDER BY SUM(current_number_of_bytes_used) DESC LIMIT 10;
SELECT event_name, ROUND(current_number_of_bytes_used/1048576,2) AS current_mib FROM performance_schema.memory_summary_global_by_event_name WHERE event_name LIKE 'memory/performance_schema/%' ORDER BY current_number_of_bytes_used DESC LIMIT 25;
SELECT COUNT(*) AS instrumented_table_handles FROM performance_schema.table_handles;
SELECT COUNT(*) AS digest_entries FROM performance_schema.events_statements_summary_by_digest;
SELECT COUNT(*) AS base_tables FROM information_schema.tables WHERE table_schema='wms_v1' AND table_type='BASE TABLE';
SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections','Innodb_buffer_pool_pages_dirty','Innodb_buffer_pool_pages_total','Innodb_buffer_pool_pages_free','Innodb_buffer_pool_load_status','Innodb_buffer_pool_dump_status');
SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.persisted_variables WHERE VARIABLE_NAME IN ('max_connections','table_open_cache','table_definition_cache','table_open_cache_instances','performance_schema_digests_size','performance_schema_events_statements_history_long_size','temptable_max_ram');
SQL
free -m
