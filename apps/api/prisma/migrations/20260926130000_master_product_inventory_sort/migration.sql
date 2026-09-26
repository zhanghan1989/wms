-- Supports active-product inventory ordering and keyset pagination.
CREATE INDEX `idx_master_products_status_stock_product`
ON `master_products` (`status`, `stock_qty`, `product_id`);
