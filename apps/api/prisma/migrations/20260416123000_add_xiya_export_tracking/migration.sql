ALTER TABLE `rakuten_order_records`
  ADD COLUMN `xiya_exported_at` DATETIME(3) NULL AFTER `dispatch_mode`,
  ADD INDEX `rakuten_order_records_xiya_exported_at_idx`(`xiya_exported_at`);

ALTER TABLE `amazon_order_records`
  ADD COLUMN `xiya_exported_at` DATETIME(3) NULL AFTER `dispatch_mode`,
  ADD INDEX `amazon_order_records_xiya_exported_at_idx`(`xiya_exported_at`);
