CREATE TABLE `amazon_sp_api_connections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `seller_id` VARCHAR(64) NOT NULL,
  `region` VARCHAR(8) NOT NULL DEFAULT 'FE',
  `marketplace_ids` JSON NOT NULL,
  `encrypted_refresh_token` TEXT NOT NULL,
  `token_iv` VARCHAR(64) NOT NULL,
  `token_auth_tag` VARCHAR(64) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `sync_fbm_orders` BOOLEAN NOT NULL DEFAULT true,
  `sync_fba_orders` BOOLEAN NOT NULL DEFAULT true,
  `sync_fba_inventory` BOOLEAN NOT NULL DEFAULT true,
  `last_orders_synced_at` DATETIME(3) NULL,
  `last_inventory_synced_at` DATETIME(3) NULL,
  `last_successful_sync_at` DATETIME(3) NULL,
  `last_sync_error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `amazon_sp_api_connections_shop_id_key` (`shop_id`),
  INDEX `amazon_sp_api_connections_status_idx` (`status`),
  INDEX `amazon_sp_api_connections_seller_id_idx` (`seller_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `amazon_sp_api_sync_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `sync_type` ENUM('fbm_orders', 'fba_orders', 'fba_inventory', 'full') NOT NULL,
  `status` ENUM('running', 'success', 'partial', 'failed') NOT NULL DEFAULT 'running',
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) NULL,
  `fetched_count` INTEGER NOT NULL DEFAULT 0,
  `created_count` INTEGER NOT NULL DEFAULT 0,
  `updated_count` INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,

  INDEX `amazon_sp_api_sync_runs_connection_id_started_at_idx` (`connection_id`, `started_at`),
  INDEX `amazon_sp_api_sync_runs_status_started_at_idx` (`status`, `started_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `amazon_fba_order_items` (
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
  `currency` VARCHAR(8) NULL,
  `item_amount` DECIMAL(16, 2) NOT NULL DEFAULT 0,
  `purchase_date` DATETIME(3) NULL,
  `last_update_date` DATETIME(3) NULL,
  `raw_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_amazon_fba_order_item` (`connection_id`, `amazon_order_id`, `amazon_order_item_id`),
  INDEX `amazon_fba_order_items_purchase_date_idx` (`purchase_date`),
  INDEX `amazon_fba_order_items_seller_sku_idx` (`seller_sku`),
  INDEX `amazon_fba_order_items_order_status_idx` (`order_status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `amazon_fba_inventory_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `marketplace_id` VARCHAR(32) NOT NULL,
  `seller_sku` VARCHAR(128) NOT NULL,
  `fn_sku` VARCHAR(64) NULL,
  `asin` VARCHAR(32) NULL,
  `product_name` TEXT NULL,
  `fulfillable_qty` INTEGER NOT NULL DEFAULT 0,
  `inbound_working_qty` INTEGER NOT NULL DEFAULT 0,
  `inbound_shipped_qty` INTEGER NOT NULL DEFAULT 0,
  `inbound_receiving_qty` INTEGER NOT NULL DEFAULT 0,
  `reserved_qty` INTEGER NOT NULL DEFAULT 0,
  `unfulfillable_qty` INTEGER NOT NULL DEFAULT 0,
  `total_qty` INTEGER NOT NULL DEFAULT 0,
  `snapshot_at` DATETIME(3) NOT NULL,
  `raw_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_amazon_fba_inventory_item` (`connection_id`, `marketplace_id`, `seller_sku`),
  INDEX `amazon_fba_inventory_items_seller_sku_idx` (`seller_sku`),
  INDEX `amazon_fba_inventory_items_snapshot_at_idx` (`snapshot_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `amazon_order_records`
  ADD COLUMN `sp_api_connection_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `order_status` VARCHAR(32) NULL,
  ADD COLUMN `fulfillment_channel` VARCHAR(16) NULL,
  ADD COLUMN `amazon_last_updated_at` DATETIME(3) NULL,
  ADD COLUMN `source_kind` VARCHAR(16) NOT NULL DEFAULT 'file';

CREATE INDEX `amazon_order_records_sp_api_connection_id_amazon_last_updated_at_idx`
  ON `amazon_order_records`(`sp_api_connection_id`, `amazon_last_updated_at`);

ALTER TABLE `amazon_sp_api_connections`
  ADD CONSTRAINT `amazon_sp_api_connections_shop_id_fkey`
  FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `amazon_sp_api_sync_runs`
  ADD CONSTRAINT `amazon_sp_api_sync_runs_connection_id_fkey`
  FOREIGN KEY (`connection_id`) REFERENCES `amazon_sp_api_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `amazon_fba_order_items`
  ADD CONSTRAINT `amazon_fba_order_items_connection_id_fkey`
  FOREIGN KEY (`connection_id`) REFERENCES `amazon_sp_api_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `amazon_fba_inventory_items`
  ADD CONSTRAINT `amazon_fba_inventory_items_connection_id_fkey`
  FOREIGN KEY (`connection_id`) REFERENCES `amazon_sp_api_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `amazon_order_records`
  ADD CONSTRAINT `amazon_order_records_sp_api_connection_id_fkey`
  FOREIGN KEY (`sp_api_connection_id`) REFERENCES `amazon_sp_api_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
