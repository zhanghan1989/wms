CREATE TABLE `rakuten_tracking_checks` (
  `tracking_no` VARCHAR(128) NOT NULL,
  `checked_at` DATETIME(3) NOT NULL,
  `next_check_at` DATETIME(3) NOT NULL,
  `consecutive_failures` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`tracking_no`),
  INDEX `rakuten_tracking_checks_next_check_at_idx` (`next_check_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `idx_rakuten_tracking_parcel`
  ON `rakuten_order_records` (`shipment_no`, `deleted_at`, `dispatch_mode`);
