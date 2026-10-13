CREATE TABLE `shop_platforms` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(64) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `shop_platforms_key_key` (`key`),
  UNIQUE INDEX `shop_platforms_name_key` (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `shop_platforms` (`key`, `name`) VALUES ('amazon', 'Amazon'), ('rakuten', 'Rakuten');

ALTER TABLE `shops` MODIFY COLUMN `platform` VARCHAR(64) NOT NULL DEFAULT 'amazon';
CREATE INDEX `shops_platform_idx` ON `shops` (`platform`);
ALTER TABLE `shops` ADD CONSTRAINT `shops_platform_fkey`
  FOREIGN KEY (`platform`) REFERENCES `shop_platforms` (`key`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `operation_audit_logs` MODIFY `event_type` ENUM(
  'box_created',
  'box_field_updated',
  'box_renamed',
  'box_disabled',
  'box_deleted',
  'box_stock_increased',
  'box_stock_outbound',
  'sku_created',
  'sku_field_updated',
  'sku_disabled',
  'sku_deleted',
  'shelf_created',
  'shelf_field_updated',
  'shelf_disabled',
  'shelf_deleted',
  'brand_created',
  'brand_updated',
  'brand_deleted',
  'sku_type_created',
  'sku_type_updated',
  'sku_type_deleted',
  'shop_created',
  'shop_updated',
  'shop_deleted',
  'shop_platform_created',
  'user_created',
  'user_updated',
  'user_disabled',
  'user_deleted',
  'inbound_order_created',
  'inbound_order_confirmed',
  'inbound_order_voided',
  'outbound_order_created',
  'outbound_order_confirmed',
  'outbound_order_voided',
  'stocktake_task_created',
  'stocktake_task_started',
  'stocktake_task_finished',
  'stocktake_task_voided',
  'inventory_adjust_created',
  'inventory_adjust_confirmed',
  'inventory_adjust_voided',
  'rakuten_mail_retried',
  'rakuten_mail_cancelled',
  'rakuten_mail_marked_sent',
  'rakuten_mail_template_saved',
  'rakuten_mail_template_activated',
  'rakuten_shipping_retried',
  'rakuten_shipping_ignored',
  'rakuten_automation_circuit_reset'
) NOT NULL;
