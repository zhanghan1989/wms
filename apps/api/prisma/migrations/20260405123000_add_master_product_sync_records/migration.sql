CREATE TABLE `master_product_sync_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `operation_type` VARCHAR(32) NOT NULL,
  `product_id` VARCHAR(128) NULL,
  `source_file_name` VARCHAR(255) NULL,
  `fetched_count` INTEGER NOT NULL DEFAULT 0,
  `created_count` INTEGER NOT NULL DEFAULT 0,
  `updated_count` INTEGER NOT NULL DEFAULT 0,
  `executed_by` BIGINT UNSIGNED NULL,
  `operator_name` VARCHAR(64) NULL,
  `executed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_master_product_sync_records_operation_type_executed_at`(`operation_type`, `executed_at`),
  INDEX `idx_master_product_sync_records_executed_by_executed_at`(`executed_by`, `executed_at`),
  INDEX `idx_master_product_sync_records_product_id_executed_at`(`product_id`, `executed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `master_product_sync_records`
  ADD CONSTRAINT `master_product_sync_records_executed_by_fkey`
    FOREIGN KEY (`executed_by`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `master_product_sync_records`
  ADD CONSTRAINT `master_product_sync_records_product_id_fkey`
    FOREIGN KEY (`product_id`) REFERENCES `master_products`(`product_id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
