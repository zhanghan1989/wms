CREATE TABLE `rakuten_schedule_controls` (
  `key` VARCHAR(32) NOT NULL,
  `enabled` BOOLEAN NOT NULL,
  `run_token` VARCHAR(64) NULL,
  `heartbeat_at` DATETIME(3) NULL,
  `started_at` DATETIME(3) NULL,
  `finished_at` DATETIME(3) NULL,
  `last_status` VARCHAR(32) NULL,
  `last_message` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
