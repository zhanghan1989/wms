ALTER TABLE `master_products`
  ADD COLUMN `stock_qty` INT NOT NULL DEFAULT 0 AFTER `size`;
