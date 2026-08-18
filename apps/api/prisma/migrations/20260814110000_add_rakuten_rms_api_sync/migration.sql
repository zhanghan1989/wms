CREATE TABLE `rakuten_rms_connections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `encrypted_service_secret` TEXT NOT NULL,
  `service_secret_iv` VARCHAR(64) NOT NULL,
  `service_secret_auth_tag` VARCHAR(64) NOT NULL,
  `encrypted_license_key` TEXT NOT NULL,
  `license_key_iv` VARCHAR(64) NOT NULL,
  `license_key_auth_tag` VARCHAR(64) NOT NULL,
  `license_expires_at` DATETIME(3) NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `sync_orders` BOOLEAN NOT NULL DEFAULT true,
  `last_orders_synced_at` DATETIME(3) NULL,
  `last_successful_sync_at` DATETIME(3) NULL,
  `last_sync_error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `rakuten_rms_connections_shop_id_key` (`shop_id`),
  INDEX `rakuten_rms_connections_status_idx` (`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rakuten_rms_sync_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('running', 'success', 'partial', 'failed') NOT NULL DEFAULT 'running',
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) NULL,
  `fetched_count` INTEGER NOT NULL DEFAULT 0,
  `created_count` INTEGER NOT NULL DEFAULT 0,
  `updated_count` INTEGER NOT NULL DEFAULT 0,
  `skipped_count` INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `change_snapshot` JSON NULL,
  `rolled_back_at` DATETIME(3) NULL,

  INDEX `rakuten_rms_sync_runs_connection_id_started_at_idx` (`connection_id`, `started_at`),
  INDEX `rakuten_rms_sync_runs_status_started_at_idx` (`status`, `started_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rakuten_rms_sync_previews` (
  `token` CHAR(64) NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `used_at` DATETIME(3) NULL,
  `preview_data` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `rakuten_rms_sync_previews_connection_id_created_at_idx` (`connection_id`, `created_at`),
  INDEX `rakuten_rms_sync_previews_expires_at_idx` (`expires_at`),
  PRIMARY KEY (`token`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `rakuten_order_records`
  ADD COLUMN `rms_connection_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `rms_item_key` VARCHAR(191) NULL,
  ADD COLUMN `source_kind` VARCHAR(16) NOT NULL DEFAULT 'csv',
  ADD COLUMN `rms_last_synced_at` DATETIME(3) NULL,
  ADD UNIQUE INDEX `uq_rakuten_rms_order_item` (`rms_connection_id`, `rms_item_key`),
  ADD INDEX `rakuten_order_records_rms_connection_id_idx` (`rms_connection_id`);

ALTER TABLE `rakuten_rms_connections`
  ADD CONSTRAINT `rakuten_rms_connections_shop_id_fkey`
  FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `rakuten_rms_sync_runs`
  ADD CONSTRAINT `rakuten_rms_sync_runs_connection_id_fkey`
  FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `rakuten_rms_sync_previews`
  ADD CONSTRAINT `rakuten_rms_sync_previews_connection_id_fkey`
  FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `rakuten_order_records`
  ADD CONSTRAINT `rakuten_order_records_rms_connection_id_fkey`
  FOREIGN KEY (`rms_connection_id`) REFERENCES `rakuten_rms_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
