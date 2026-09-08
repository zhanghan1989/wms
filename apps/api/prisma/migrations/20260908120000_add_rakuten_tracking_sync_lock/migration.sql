CREATE TABLE `rakuten_tracking_sync_locks` (
  `id` VARCHAR(64) NOT NULL,
  `lock_token` VARCHAR(64) NULL,
  `locked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `rakuten_tracking_sync_locks_locked_at_idx`(`locked_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `rakuten_tracking_sync_locks` (`id`)
VALUES ('rakuten-tracking-status-sync');
