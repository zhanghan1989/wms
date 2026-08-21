CREATE INDEX `idx_rakuten_orders_dashboard_scope`
ON `rakuten_order_records` (`rms_connection_id`, `order_imported_at_raw`);
