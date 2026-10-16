ALTER TABLE `rakuten_rms_connections`
  ADD COLUMN `inventory_catalog_version` VARCHAR(36) NULL,
  ADD COLUMN `inventory_catalog_refreshed_at` DATETIME(3) NULL,
  ADD COLUMN `inventory_catalog_error` TEXT NULL;
ALTER TABLE `rakuten_inventory_mappings` ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'manual';
CREATE TABLE `rakuten_inventory_catalog` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `version` VARCHAR(36) NOT NULL,
  `manage_number` VARCHAR(32) NOT NULL,
  `variant_id` VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  `merchant_defined_sku_id` VARCHAR(96) NULL,
  `title` VARCHAR(255) NOT NULL,
  `hidden` BOOLEAN NOT NULL,
  `unlimited_stock` BOOLEAN NOT NULL,
  `sales_start` DATETIME(3) NULL,
  `sales_end` DATETIME(3) NULL,
  `product_id` VARCHAR(128) NULL,
  `match_status` VARCHAR(24) NOT NULL,
  `candidates` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_rakuten_catalog_version_sku` (`connection_id`, `version`, `manage_number`, `variant_id`),
  INDEX `idx_rakuten_catalog_match` (`connection_id`, `version`, `match_status`),
  CONSTRAINT `rakuten_inventory_catalog_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `rakuten_inventory_catalog_jobs` (
  `id` VARCHAR(36) NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `cursor_mark` TEXT NOT NULL,
  `product_count` INTEGER NOT NULL DEFAULT 0,
  `sku_count` INTEGER NOT NULL DEFAULT 0,
  `error` TEXT NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `rakuten_inventory_catalog_jobs_connection_id_started_at_idx` (`connection_id`, `started_at`),
  CONSTRAINT `rakuten_inventory_catalog_jobs_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
