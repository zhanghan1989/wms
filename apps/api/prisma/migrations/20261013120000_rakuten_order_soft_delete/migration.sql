ALTER TABLE `rakuten_order_records`
  ADD COLUMN `deleted_at` DATETIME(3) NULL,
  ADD COLUMN `deleted_by` BIGINT UNSIGNED NULL;
CREATE INDEX `idx_rakuten_order_deleted` ON `rakuten_order_records` (`deleted_at`, `order_id`);
