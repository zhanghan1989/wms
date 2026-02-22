-- CreateTable
CREATE TABLE `shops` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `shops_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- InitData: import distinct shop values from current skus
INSERT INTO `shops` (`name`, `status`, `created_at`, `updated_at`)
SELECT DISTINCT `shop`, 1, NOW(3), NOW(3)
FROM `skus`
WHERE `shop` IS NOT NULL AND TRIM(`shop`) <> ''
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- AlterEnum
ALTER TABLE `operation_audit_logs`
MODIFY `event_type` ENUM(
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
  'inventory_adjust_voided'
) NOT NULL;

