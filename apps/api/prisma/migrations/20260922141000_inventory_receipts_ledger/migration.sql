ALTER TABLE `batch_inbound_items`
 ADD COLUMN `actual_qty` INTEGER NULL,
 ADD COLUMN `confirmed_by` BIGINT UNSIGNED NULL,
 ADD COLUMN `difference_reason` VARCHAR(255) NULL;
-- Historical receipts remain NULL: planned quantity is not evidence of quantity received.
ALTER TABLE `inventory_adjust_order_items`
 MODIFY COLUMN `sku_id` BIGINT UNSIGNED NULL,
 ADD COLUMN `product_id` VARCHAR(128) NULL;
ALTER TABLE `stock_movements` ADD COLUMN `operation_key` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `stock_movements_operation_key_key` ON `stock_movements` (`operation_key`);
