ALTER TABLE `batch_inbound_orders` ADD COLUMN `is_pre_registered` BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE `batch_inbound_planned_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` VARCHAR(128) NOT NULL,
  `qty` INTEGER NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `batch_inbound_planned_items_order_id_product_id_key` (`order_id`, `product_id`),
  CONSTRAINT `batch_inbound_planned_items_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `batch_inbound_orders` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
