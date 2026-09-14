ALTER TABLE `amazon_order_records`
  ADD COLUMN `sp_api_dashboard_visible_at` DATETIME(3) NULL,
  ADD INDEX `idx_amz_orders_dashboard_visible` (`sp_api_connection_id`, `sp_api_dashboard_visible_at`);
