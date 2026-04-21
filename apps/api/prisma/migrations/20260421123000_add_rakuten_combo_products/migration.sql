CREATE TABLE `rakuten_combo_products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `combo_name` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `rakuten_combo_products_combo_name_key`(`combo_name`),
  INDEX `rakuten_combo_products_created_at_idx`(`created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rakuten_combo_product_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `combo_id` BIGINT UNSIGNED NOT NULL,
  `product_id` VARCHAR(128) NOT NULL,
  `position` INTEGER NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_rakuten_combo_items_combo_position`(`combo_id`, `position`),
  UNIQUE INDEX `uq_rakuten_combo_items_combo_product`(`combo_id`, `product_id`),
  INDEX `rakuten_combo_items_product_id_idx`(`product_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `rakuten_combo_product_items`
  ADD CONSTRAINT `rakuten_combo_product_items_combo_id_fkey`
  FOREIGN KEY (`combo_id`) REFERENCES `rakuten_combo_products`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `rakuten_combo_product_items`
  ADD CONSTRAINT `rakuten_combo_product_items_product_id_fkey`
  FOREIGN KEY (`product_id`) REFERENCES `master_products`(`product_id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
