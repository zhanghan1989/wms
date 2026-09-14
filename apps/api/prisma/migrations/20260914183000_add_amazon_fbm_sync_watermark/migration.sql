ALTER TABLE `amazon_sp_api_connections`
  ADD COLUMN `last_fbm_orders_synced_at` DATETIME(3) NULL,
  ADD COLUMN `dashboard_tracking_started_at` DATETIME(3) NULL;

ALTER TABLE `amazon_sp_api_sync_runs`
  ADD COLUMN `progress_stage` VARCHAR(32) NULL;
