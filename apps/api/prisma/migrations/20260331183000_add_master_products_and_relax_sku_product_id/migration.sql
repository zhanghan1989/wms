DROP INDEX `skus_product_id_key` ON `skus`;

CREATE INDEX `idx_skus_product_id` ON `skus`(`product_id`);

CREATE TABLE `master_products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` VARCHAR(128) NOT NULL,
  `product_name` VARCHAR(255) NULL,
  `product_type` VARCHAR(128) NULL,
  `bag_brand` VARCHAR(128) NULL,
  `color` VARCHAR(64) NULL,
  `bag_name` VARCHAR(128) NULL,
  `bag_type` VARCHAR(64) NULL,
  `zipper_style` VARCHAR(64) NULL,
  `style` VARCHAR(128) NULL,
  `pattern` VARCHAR(128) NULL,
  `buckle_type` VARCHAR(64) NULL,
  `matching_bag_type` VARCHAR(64) NULL,
  `length` VARCHAR(64) NULL,
  `width` VARCHAR(64) NULL,
  `pattern_type` VARCHAR(64) NULL,
  `size` VARCHAR(64) NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `master_products_product_id_key`(`product_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
