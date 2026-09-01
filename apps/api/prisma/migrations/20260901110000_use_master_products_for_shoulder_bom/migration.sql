ALTER TABLE `master_product_bom_items`
  ADD COLUMN `component_product_id` VARCHAR(128) NULL;

UPDATE `master_product_bom_items` bom
INNER JOIN `shoulder_strap_parts` part ON part.`id` = bom.`part_id`
INNER JOIN `master_products` product ON product.`product_id` = part.`part_code`
SET bom.`component_product_id` = product.`product_id`;

DELETE FROM `master_product_bom_items`
WHERE `component_product_id` IS NULL;

ALTER TABLE `master_product_bom_items`
  DROP FOREIGN KEY `master_product_bom_items_part_id_fkey`,
  DROP INDEX `uq_master_product_bom_parent_part`,
  DROP INDEX `idx_master_product_bom_part`,
  DROP COLUMN `part_id`,
  MODIFY `component_product_id` VARCHAR(128) NOT NULL,
  ADD UNIQUE INDEX `uq_master_product_bom_parent_component`(`parent_product_id`, `component_product_id`),
  ADD INDEX `idx_master_product_bom_component`(`component_product_id`),
  ADD CONSTRAINT `master_product_bom_items_component_product_id_fkey`
    FOREIGN KEY (`component_product_id`) REFERENCES `master_products`(`product_id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE IF EXISTS `shoulder_strap_part_stock_movements`;
DROP TABLE IF EXISTS `shoulder_strap_parts`;

ALTER TABLE `overseas_picking_batch_items`
  ADD COLUMN `picking_requirement_snapshot` JSON NULL AFTER `picking_plan_snapshot`;
