UPDATE `skus`
SET `shop` = ''
WHERE `shop` IS NULL;

ALTER TABLE `skus`
  DROP INDEX `skus_sku_key`,
  MODIFY `sku` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  MODIFY `shop` VARCHAR(128) NOT NULL DEFAULT '',
  ADD UNIQUE INDEX `skus_sku_shop_key`(`sku`, `shop`);
