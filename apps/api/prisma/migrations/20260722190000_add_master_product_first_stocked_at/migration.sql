ALTER TABLE `master_products`
  ADD COLUMN `first_stocked_at` DATETIME(3) NULL AFTER `stock_qty`,
  ADD INDEX `idx_master_products_first_stocked_at` (`first_stocked_at`);

UPDATE `master_products` AS `product`
INNER JOIN (
  SELECT `evidence`.`product_id`, MIN(`evidence`.`stocked_at`) AS `first_stocked_at`
  FROM (
    SELECT `product_id`, `confirmed_at` AS `stocked_at`
    FROM `batch_inbound_items`
    WHERE `status` = 'confirmed' AND `qty` > 0 AND `confirmed_at` IS NOT NULL
    UNION ALL
    SELECT `item`.`product_id`, `order`.`created_at` AS `stocked_at`
    FROM `inbound_order_items` AS `item`
    INNER JOIN `inbound_orders` AS `order` ON `order`.`id` = `item`.`order_id`
    WHERE `order`.`status` = 'confirmed' AND `item`.`qty` > 0
    UNION ALL
    SELECT `product_id`, `created_at` AS `stocked_at`
    FROM `stock_movements`
    WHERE `product_id` IS NOT NULL AND `qty_delta` > 0
  ) AS `evidence`
  GROUP BY `evidence`.`product_id`
) AS `first_stock` ON `first_stock`.`product_id` = `product`.`product_id`
SET `product`.`first_stocked_at` = `first_stock`.`first_stocked_at`
WHERE `product`.`first_stocked_at` IS NULL;
