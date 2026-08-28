CREATE TABLE `shoulder_strap_parts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `part_code` VARCHAR(128) NOT NULL,
  `part_name` VARCHAR(255) NOT NULL,
  `stock_qty` INTEGER NOT NULL DEFAULT 0,
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `shoulder_strap_parts_part_code_key`(`part_code`),
  INDEX `idx_shoulder_strap_parts_status_code`(`status`, `part_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `shoulder_strap_parts`
  (`part_code`, `part_name`, `stock_qty`, `status`, `created_at`, `updated_at`)
SELECT DISTINCT
  bom.`component_product_id`,
  COALESCE(NULLIF(TRIM(product.`product_name`), ''), bom.`component_product_id`),
  GREATEST(COALESCE(product.`stock_qty`, 0), 0),
  COALESCE(product.`status`, 1),
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `master_product_bom_items` bom
LEFT JOIN `master_products` product
  ON product.`product_id` = bom.`component_product_id`;

ALTER TABLE `master_product_bom_items`
  ADD COLUMN `part_id` BIGINT UNSIGNED NULL;

UPDATE `master_product_bom_items` bom
INNER JOIN `shoulder_strap_parts` part
  ON part.`part_code` = bom.`component_product_id`
SET bom.`part_id` = part.`id`;

ALTER TABLE `master_product_bom_items`
  DROP FOREIGN KEY `master_product_bom_items_component_product_id_fkey`,
  DROP INDEX `uq_master_product_bom_parent_component`,
  DROP INDEX `idx_master_product_bom_component`,
  DROP COLUMN `component_product_id`,
  MODIFY `part_id` BIGINT UNSIGNED NOT NULL,
  ADD UNIQUE INDEX `uq_master_product_bom_parent_part`(`parent_product_id`, `part_id`),
  ADD INDEX `idx_master_product_bom_part`(`part_id`),
  ADD CONSTRAINT `master_product_bom_items_part_id_fkey`
    FOREIGN KEY (`part_id`) REFERENCES `shoulder_strap_parts`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
