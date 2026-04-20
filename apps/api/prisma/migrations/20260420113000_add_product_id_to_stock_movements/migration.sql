ALTER TABLE `stock_movements`
  ADD COLUMN `product_id` VARCHAR(128) NULL AFTER `box_id`;

UPDATE `stock_movements` sm
JOIN `skus` s ON s.`id` = sm.`sku_id`
SET sm.`product_id` = s.`product_id`
WHERE sm.`product_id` IS NULL;

ALTER TABLE `stock_movements`
  MODIFY COLUMN `sku_id` BIGINT UNSIGNED NULL;

ALTER TABLE `stock_movements`
  ADD INDEX `idx_stock_movements_product_id_created_at`(`product_id`, `created_at`),
  ADD CONSTRAINT `stock_movements_product_id_fkey`
    FOREIGN KEY (`product_id`) REFERENCES `master_products`(`product_id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
