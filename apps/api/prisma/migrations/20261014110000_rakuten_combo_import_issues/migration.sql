CREATE TABLE `rakuten_order_import_issues` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `combo_skus` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  `resolved_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_rakuten_import_issue_order` (`connection_id`, `order_id`),
  INDEX `idx_rakuten_import_issue_pending` (`resolved_at`, `connection_id`),
  CONSTRAINT `rakuten_order_import_issues_connection_id_fkey` FOREIGN KEY (`connection_id`)
    REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
