CREATE TABLE `rakuten_tracking_query_ignores` (
  `tracking_no` VARCHAR(128) NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `ignored_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `ignored_by` VARCHAR(64) NOT NULL,
  `restored_at` DATETIME(3) NULL,
  `restored_by` VARCHAR(64) NULL,
  PRIMARY KEY (`tracking_no`),
  INDEX `rakuten_tracking_query_ignores_is_active_ignored_at_idx` (`is_active`, `ignored_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
