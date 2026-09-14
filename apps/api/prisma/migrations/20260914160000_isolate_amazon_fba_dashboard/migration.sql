ALTER TABLE `amazon_fba_order_items`
  ADD COLUMN `dashboard_visible_at` DATETIME(3) NULL;

CREATE INDEX `idx_fba_orders_dashboard_visible`
  ON `amazon_fba_order_items`(`connection_id`, `dashboard_visible_at`);
