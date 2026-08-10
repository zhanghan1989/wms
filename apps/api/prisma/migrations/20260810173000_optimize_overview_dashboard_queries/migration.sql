CREATE INDEX `idx_fba_orders_status_purchase`
  ON `amazon_fba_order_items`(`order_status`, `purchase_date`);

CREATE INDEX `idx_rakuten_orders_shipment_registered`
  ON `rakuten_order_records`(`shipment_no_registered_at`);

CREATE INDEX `idx_amz_orders_source_updated`
  ON `amazon_order_records`(`source_kind`, `amazon_last_updated_at`);

CREATE INDEX `idx_amz_orders_source_shipment`
  ON `amazon_order_records`(`source_kind`, `shipment_no_registered_at`);
