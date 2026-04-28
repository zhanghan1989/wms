ALTER TABLE `manual_order_records`
  ADD COLUMN `blogger_cooperation_id` VARCHAR(128) NULL AFTER `shop_name`,
  ADD COLUMN `xyjg_push_status` VARCHAR(32) NULL AFTER `xiya_exported_at`,
  ADD COLUMN `xyjg_push_mode` VARCHAR(32) NULL AFTER `xyjg_push_status`,
  ADD COLUMN `xyjg_push_tracking_no` VARCHAR(128) NULL AFTER `xyjg_push_mode`,
  ADD COLUMN `xyjg_pushed_at` DATETIME(3) NULL AFTER `xyjg_push_tracking_no`,
  ADD COLUMN `xyjg_push_error` TEXT NULL AFTER `xyjg_pushed_at`,
  ADD COLUMN `xyjg_push_response` JSON NULL AFTER `xyjg_push_error`,
  ADD INDEX `manual_order_records_blogger_cooperation_id_idx` (`blogger_cooperation_id`),
  ADD INDEX `manual_order_records_xyjg_push_status_idx` (`xyjg_push_status`);
