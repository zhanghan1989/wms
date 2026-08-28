CREATE TABLE `master_product_bom_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `parent_product_id` VARCHAR(128) NOT NULL,
  `component_product_id` VARCHAR(128) NOT NULL,
  `quantity` INTEGER NOT NULL,
  `position` INTEGER NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_master_product_bom_parent_component`(`parent_product_id`, `component_product_id`),
  UNIQUE INDEX `uq_master_product_bom_parent_position`(`parent_product_id`, `position`),
  INDEX `idx_master_product_bom_component`(`component_product_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `master_product_bom_items`
  ADD CONSTRAINT `master_product_bom_items_parent_product_id_fkey`
  FOREIGN KEY (`parent_product_id`) REFERENCES `master_products`(`product_id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `master_product_bom_items`
  ADD CONSTRAINT `master_product_bom_items_component_product_id_fkey`
  FOREIGN KEY (`component_product_id`) REFERENCES `master_products`(`product_id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
