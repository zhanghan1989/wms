CREATE TABLE `amazon_fbm_order_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `amazon_order_id` VARCHAR(64) NOT NULL,
  `amazon_order_item_id` VARCHAR(64) NOT NULL,
  `marketplace_id` VARCHAR(32) NULL,
  `seller_sku` VARCHAR(128) NULL,
  `asin` VARCHAR(32) NULL,
  `product_name` TEXT NULL,
  `order_status` VARCHAR(32) NULL,
  `quantity_ordered` INTEGER NOT NULL DEFAULT 0,
  `quantity_shipped` INTEGER NOT NULL DEFAULT 0,
  `quantity_unfulfilled` INTEGER NOT NULL DEFAULT 0,
  `purchase_date` DATETIME(3) NULL,
  `last_update_date` DATETIME(3) NULL,
  `raw_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_amazon_fbm_order_item`(`connection_id`, `amazon_order_id`, `amazon_order_item_id`),
  INDEX `idx_fbm_orders_connection_purchase`(`connection_id`, `purchase_date`),
  INDEX `amazon_fbm_order_items_seller_sku_idx`(`seller_sku`),
  INDEX `idx_fbm_orders_status_purchase`(`order_status`, `purchase_date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `amazon_fbm_order_items`
  ADD CONSTRAINT `amazon_fbm_order_items_connection_id_fkey`
  FOREIGN KEY (`connection_id`) REFERENCES `amazon_sp_api_connections`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
