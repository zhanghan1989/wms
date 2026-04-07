ALTER TABLE `batch_inbound_items`
  DROP INDEX `uq_batch_order_box_sku`,
  CHANGE COLUMN `sku_code` `product_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  ADD UNIQUE INDEX `uq_batch_order_box_product` (`order_id`, `box_code`, `product_id`);

ALTER TABLE `inbound_order_items`
  ADD COLUMN `product_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER `box_id`;

UPDATE `inbound_order_items` AS `items`
INNER JOIN `skus` AS `skus`
  ON `skus`.`id` = `items`.`sku_id`
SET `items`.`product_id` = `skus`.`product_id`
WHERE `items`.`product_id` IS NULL;

ALTER TABLE `inbound_order_items`
  MODIFY COLUMN `product_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;

ALTER TABLE `inbound_order_items`
  DROP FOREIGN KEY `inbound_order_items_sku_id_fkey`;

ALTER TABLE `inbound_order_items`
  DROP INDEX `inbound_order_items_sku_id_fkey`,
  DROP COLUMN `sku_id`,
  ADD INDEX `inbound_order_items_product_id_fkey` (`product_id`),
  ADD CONSTRAINT `inbound_order_items_product_id_fkey`
    FOREIGN KEY (`product_id`) REFERENCES `master_products` (`product_id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
