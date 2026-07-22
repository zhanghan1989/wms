UPDATE `master_products`
SET `status` = 0,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `stock_qty` = 0
  AND `product_name` LIKE '假产品ID-%';
