ALTER TABLE `master_product_sync_records`
  ADD COLUMN `status` ENUM('running', 'success', 'failed') NOT NULL DEFAULT 'running' AFTER `source_file_name`,
  ADD COLUMN `finished_at` DATETIME(3) NULL AFTER `executed_at`,
  ADD COLUMN `error_message` VARCHAR(255) NULL AFTER `finished_at`;

CREATE INDEX `idx_master_product_sync_records_status_executed_at`
  ON `master_product_sync_records`(`status`, `executed_at`);

UPDATE `master_product_sync_records`
SET `status` = 'success'
WHERE `status` = 'running';
