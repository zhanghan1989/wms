ALTER TABLE `rakuten_order_records`
  ADD COLUMN `dispatch_mode` VARCHAR(32) NULL AFTER `shipment_no_registered_at`;

ALTER TABLE `amazon_order_records`
  ADD COLUMN `dispatch_mode` VARCHAR(32) NULL AFTER `shipment_no_registered_at`;

ALTER TABLE `overseas_picking_batch_items`
  ADD COLUMN `dispatch_mode` VARCHAR(32) NOT NULL DEFAULT 'overseas' AFTER `available_stock_snapshot`,
  ADD COLUMN `picked_at` DATETIME(3) NULL AFTER `shipment_tracking_no`;
