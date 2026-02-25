CREATE TABLE `backup_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_name` VARCHAR(255) NOT NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'schedule',
  `size_bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `has_file` TINYINT(1) NOT NULL DEFAULT 1,
  `file_deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `backup_records_file_name_key`(`file_name`),
  INDEX `backup_records_created_at_idx`(`created_at`),
  INDEX `backup_records_has_file_created_at_idx`(`has_file`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
