ALTER TABLE `amazon_sp_api_connections`
  ADD COLUMN `sync_lock_token` VARCHAR(64) NULL,
  ADD COLUMN `sync_locked_at` DATETIME(3) NULL,
  ADD INDEX `idx_amazon_connection_sync_lock` (`sync_locked_at`);

ALTER TABLE `amazon_sp_api_sync_runs`
  ADD COLUMN `trigger` VARCHAR(16) NOT NULL DEFAULT 'manual',
  ADD COLUMN `unchanged_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `frozen_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `excluded_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `conflict_count` INTEGER NOT NULL DEFAULT 0;
