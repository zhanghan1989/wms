ALTER TABLE `rakuten_order_records`
  ADD COLUMN `is_combo_order` BOOLEAN NOT NULL DEFAULT false AFTER `sku_code`,
  ADD COLUMN `combo_order_sku` VARCHAR(128) NULL AFTER `is_combo_order`;
