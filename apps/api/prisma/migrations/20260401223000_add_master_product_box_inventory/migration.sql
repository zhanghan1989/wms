CREATE TABLE `master_product_box_inventory` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `box_id` BIGINT UNSIGNED NOT NULL,
  `product_id` VARCHAR(128) NOT NULL,
  `qty` INTEGER NOT NULL DEFAULT 0,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `master_product_box_inventory_box_id_product_id_key`(`box_id`, `product_id`),
  INDEX `idx_master_product_box_inventory_product_id`(`product_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `master_product_box_inventory`
  ADD CONSTRAINT `master_product_box_inventory_box_id_fkey`
  FOREIGN KEY (`box_id`) REFERENCES `boxes`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `master_product_box_inventory`
  ADD CONSTRAINT `master_product_box_inventory_product_id_fkey`
  FOREIGN KEY (`product_id`) REFERENCES `master_products`(`product_id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO `master_product_box_inventory` (`box_id`, `product_id`, `qty`, `updated_at`)
SELECT
  `ibs`.`box_id`,
  `s`.`product_id`,
  SUM(`ibs`.`qty`) AS `qty`,
  CURRENT_TIMESTAMP(3)
FROM `inventory_box_sku` AS `ibs`
INNER JOIN `skus` AS `s` ON `s`.`id` = `ibs`.`sku_id`
WHERE `ibs`.`qty` > 0
  AND `s`.`product_id` IS NOT NULL
  AND TRIM(`s`.`product_id`) <> ''
GROUP BY `ibs`.`box_id`, `s`.`product_id`
ON DUPLICATE KEY UPDATE
  `qty` = VALUES(`qty`),
  `updated_at` = CURRENT_TIMESTAMP(3);

UPDATE `master_products` AS `mp`
LEFT JOIN (
  SELECT `product_id`, SUM(`qty`) AS `total_qty`
  FROM `master_product_box_inventory`
  WHERE `qty` > 0
  GROUP BY `product_id`
) AS `totals`
  ON `totals`.`product_id` = `mp`.`product_id`
SET `mp`.`stock_qty` = COALESCE(`totals`.`total_qty`, 0);
