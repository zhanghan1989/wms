ALTER TABLE `skus`
  ADD COLUMN `product_id` VARCHAR(128) NULL AFTER `id`;

CREATE UNIQUE INDEX `skus_product_id_key` ON `skus`(`product_id`);
