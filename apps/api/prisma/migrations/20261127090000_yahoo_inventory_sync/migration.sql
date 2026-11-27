ALTER TABLE `yahoo_order_connections`
  ADD COLUMN `last_complete_orders_at` DATETIME(3) NULL,
  ADD COLUMN `inventory_enabled` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `inventory_pause_reason` VARCHAR(255) NULL,
  ADD COLUMN `inventory_failure_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `inventory_baseline_count` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `yahoo_inventory_mappings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` INTEGER NOT NULL,
  `item_code` VARCHAR(99) COLLATE utf8mb4_bin NOT NULL,
  `sub_code` VARCHAR(99) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `product_id` VARCHAR(128) NOT NULL,
  `source` VARCHAR(16) NOT NULL DEFAULT 'manual',
  `safety_stock` INTEGER NOT NULL DEFAULT 0,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_yahoo_inventory_target` (`connection_id`, `item_code`, `sub_code`),
  CONSTRAINT `yahoo_inventory_mappings_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `yahoo_order_connections` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `yahoo_inventory_runs` (
  `id` CHAR(36) NOT NULL,
  `connection_id` INTEGER NOT NULL,
  `actor_id` VARCHAR(30) NULL,
  `trigger` VARCHAR(16) NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `plan` JSON NULL,
  `result` JSON NULL,
  `message` VARCHAR(255) NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_yahoo_inventory_recent` (`connection_id`, `started_at`),
  CONSTRAINT `yahoo_inventory_runs_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `yahoo_order_connections` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
