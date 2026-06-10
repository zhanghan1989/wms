ALTER TABLE `rakuten_order_records`
  ADD COLUMN `tracking_status_label` VARCHAR(128) NULL AFTER `shipment_no_registered_at`,
  ADD COLUMN `tracking_has_customs_clearance` BOOLEAN NOT NULL DEFAULT false AFTER `tracking_status_label`,
  ADD COLUMN `tracking_status_occurred_at` DATETIME(3) NULL AFTER `tracking_has_customs_clearance`,
  ADD COLUMN `tracking_checked_at` DATETIME(3) NULL AFTER `tracking_status_occurred_at`,
  ADD COLUMN `tracking_error` TEXT NULL AFTER `tracking_checked_at`;

CREATE INDEX `rakuten_order_records_tracking_status_label_idx`
  ON `rakuten_order_records`(`tracking_status_label`);

CREATE INDEX `rakuten_order_records_tracking_checked_at_idx`
  ON `rakuten_order_records`(`tracking_checked_at`);
