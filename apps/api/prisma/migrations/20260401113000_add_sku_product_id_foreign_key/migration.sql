ALTER TABLE `skus`
  ADD CONSTRAINT `fk_skus_product_id_master_products_product_id`
  FOREIGN KEY (`product_id`) REFERENCES `master_products`(`product_id`)
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
