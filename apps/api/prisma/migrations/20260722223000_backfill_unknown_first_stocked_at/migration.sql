UPDATE `master_products`
SET `first_stocked_at` = '2026-02-26 17:19:05.000'
WHERE `first_stocked_at` IS NULL
  AND `stock_qty` > 0;
