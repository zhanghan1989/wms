CREATE INDEX `rakuten_order_records_tracking_sync_candidate_idx`
  ON `rakuten_order_records`(`dispatch_mode`, `tracking_is_delivered`, `tracking_checked_at`, `shipment_no`);
