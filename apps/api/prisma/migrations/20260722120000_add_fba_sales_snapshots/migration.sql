CREATE TABLE `fba_sales_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_name` VARCHAR(255) NOT NULL,
  `period_days` INTEGER NOT NULL DEFAULT 90,
  `total_rows` INTEGER NOT NULL,
  `fba_rows` INTEGER NOT NULL,
  `fbm_rows` INTEGER NOT NULL,
  `unmatched_rows` INTEGER NOT NULL,
  `ambiguous_rows` INTEGER NOT NULL,
  `fba_ordered_qty` INTEGER NOT NULL,
  `imported_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `fba_sales_snapshots_created_at_idx`(`created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `fba_sales_snapshot_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` BIGINT UNSIGNED NOT NULL,
  `seller_sku` VARCHAR(128) NOT NULL,
  `asin` VARCHAR(32) NULL,
  `product_name` TEXT NULL,
  `product_id` VARCHAR(128) NULL,
  `channel` VARCHAR(16) NOT NULL,
  `matched_by` VARCHAR(16) NULL,
  `ordered_qty` INTEGER NOT NULL,
  `order_item_qty` INTEGER NOT NULL,
  `sales_amount` DECIMAL(16, 2) NOT NULL DEFAULT 0,
  UNIQUE INDEX `uq_fba_sales_snapshot_item_sku`(`snapshot_id`, `seller_sku`),
  INDEX `idx_fba_sales_snapshot_items_product_id`(`product_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `fba_sales_snapshot_items_snapshot_id_fkey`
    FOREIGN KEY (`snapshot_id`) REFERENCES `fba_sales_snapshots`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
