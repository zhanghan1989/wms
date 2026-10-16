ALTER TABLE `rakuten_rms_connections` ADD COLUMN `inventory_sync_enabled` BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE `rakuten_inventory_mappings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `product_id` VARCHAR(128) NOT NULL,
  `manage_number` VARCHAR(32) NOT NULL,
  `variant_id` VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  `safety_stock` INTEGER NOT NULL DEFAULT 0,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_rakuten_inventory_target` (`connection_id`, `manage_number`, `variant_id`),
  INDEX `rakuten_inventory_mappings_product_id_idx` (`product_id`),
  CONSTRAINT `rakuten_inventory_mappings_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `rakuten_inventory_runs` (
  `id` VARCHAR(36) NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `trigger` VARCHAR(16) NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `actor_id` VARCHAR(32) NULL,
  `plan` JSON NOT NULL,
  `result` JSON NULL,
  `message` TEXT NULL,
  `expires_at` DATETIME(3) NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `rakuten_inventory_runs_connection_id_started_at_idx` (`connection_id`, `started_at`),
  INDEX `rakuten_inventory_runs_status_expires_at_idx` (`status`, `expires_at`),
  CONSTRAINT `rakuten_inventory_runs_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
