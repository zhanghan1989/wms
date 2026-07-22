CREATE TABLE `amazon_replenishment_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_file_name` VARCHAR(255) NOT NULL,
  `inventory_file_name` VARCHAR(255) NOT NULL,
  `business_row_count` INTEGER NOT NULL,
  `inventory_row_count` INTEGER NOT NULL,
  `business_rows` JSON NOT NULL,
  `inventory_rows` JSON NOT NULL,
  `store` VARCHAR(128) NULL,
  `snapshot_date` VARCHAR(32) NULL,
  `imported_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `amazon_replenishment_snapshots_created_at_idx`(`created_at`),
  INDEX `amazon_replenishment_snapshots_store_created_at_idx`(`store`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
