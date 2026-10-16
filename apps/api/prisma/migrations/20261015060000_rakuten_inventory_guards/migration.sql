ALTER TABLE `rakuten_rms_connections`
  ADD COLUMN `inventory_pause_reason` TEXT NULL,
  ADD COLUMN `inventory_failure_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `inventory_baseline_count` INTEGER NOT NULL DEFAULT 0;
