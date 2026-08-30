ALTER TABLE `rakuten_rms_connections`
  ADD COLUMN `smtp_auth_id` VARCHAR(128) NULL,
  ADD COLUMN `encrypted_smtp_password` TEXT NULL,
  ADD COLUMN `smtp_password_iv` VARCHAR(64) NULL,
  ADD COLUMN `smtp_password_auth_tag` VARCHAR(64) NULL,
  ADD COLUMN `smtp_from_address` VARCHAR(255) NULL,
  ADD COLUMN `smtp_from_name` VARCHAR(128) NULL,
  ADD COLUMN `mail_notifications_enabled` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `auto_shipping_enabled` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `automation_lock_token` VARCHAR(64) NULL,
  ADD COLUMN `automation_locked_at` DATETIME(3) NULL,
  ADD COLUMN `shipping_circuit_opened_at` DATETIME(3) NULL,
  ADD COLUMN `shipping_circuit_reason` TEXT NULL,
  ADD COLUMN `mail_circuit_opened_at` DATETIME(3) NULL,
  ADD COLUMN `mail_circuit_reason` TEXT NULL,
  ADD INDEX `idx_rakuten_connection_automation_lock` (`automation_locked_at`);

ALTER TABLE `rakuten_order_records`
  ADD COLUMN `buyer_email` VARCHAR(255) NULL;

CREATE TABLE `rakuten_mail_template_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `event` ENUM('new_order', 'japan_shipped', 'china_delay', 'china_customs', 'mixed_partial', 'mixed_customs') NOT NULL,
  `version` INTEGER NOT NULL,
  `subject_template` VARCHAR(255) NOT NULL,
  `body_template` TEXT NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `activated_at` DATETIME(3) NULL,
  UNIQUE INDEX `uq_rakuten_mail_template_version` (`connection_id`, `event`, `version`),
  INDEX `idx_rakuten_mail_template_active` (`connection_id`, `event`, `is_active`),
  PRIMARY KEY (`id`),
  CONSTRAINT `rakuten_mail_template_versions_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `rakuten_mail_template_versions_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rakuten_order_mails` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `event` ENUM('new_order', 'japan_shipped', 'china_delay', 'china_customs', 'mixed_partial', 'mixed_customs') NOT NULL,
  `status` ENUM('pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled', 'uncertain', 'dead_letter') NOT NULL DEFAULT 'pending',
  `recipient` VARCHAR(255) NULL,
  `subject` VARCHAR(255) NULL,
  `body` TEXT NULL,
  `smtp_message_id` VARCHAR(512) NULL,
  `send_started_at` DATETIME(3) NULL,
  `resolved_at` DATETIME(3) NULL,
  `resolved_by` BIGINT UNSIGNED NULL,
  `resolution_note` VARCHAR(255) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME(3) NULL,
  `sent_at` DATETIME(3) NULL,
  `last_error` TEXT NULL,
  `failure_category` VARCHAR(32) NULL,
  `dead_lettered_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uq_rakuten_order_mail_event` (`connection_id`, `order_id`, `event`),
  INDEX `idx_rakuten_order_mail_pending` (`status`, `next_attempt_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `rakuten_order_mails_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rakuten_order_shipping_reports` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `fulfillment_type` VARCHAR(16) NOT NULL,
  `fingerprint` CHAR(40) NOT NULL,
  `status` ENUM('pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled', 'uncertain', 'dead_letter') NOT NULL DEFAULT 'pending',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME(3) NULL,
  `reported_at` DATETIME(3) NULL,
  `last_error` TEXT NULL,
  `failure_category` VARCHAR(32) NULL,
  `dead_lettered_at` DATETIME(3) NULL,
  `response_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uq_rakuten_order_shipping_report` (`connection_id`, `order_id`),
  INDEX `idx_rakuten_shipping_report_pending` (`status`, `next_attempt_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `rakuten_order_shipping_reports_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rakuten_automation_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `trigger` ENUM('scheduled', 'manual') NOT NULL,
  `status` ENUM('running', 'success', 'partial', 'failed') NOT NULL DEFAULT 'running',
  `shipping_sent` INTEGER NOT NULL DEFAULT 0,
  `shipping_skipped` INTEGER NOT NULL DEFAULT 0,
  `shipping_failed` INTEGER NOT NULL DEFAULT 0,
  `mail_sent` INTEGER NOT NULL DEFAULT 0,
  `mail_failed` INTEGER NOT NULL DEFAULT 0,
  `mail_blocked` INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) NULL,
  INDEX `idx_rakuten_automation_run_connection` (`connection_id`, `started_at`),
  INDEX `idx_rakuten_automation_run_status` (`status`, `started_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `rakuten_automation_runs_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `operation_audit_logs`
  MODIFY COLUMN `event_type` ENUM(
    'box_created', 'box_field_updated', 'box_renamed', 'box_disabled', 'box_deleted',
    'box_stock_increased', 'box_stock_outbound',
    'sku_created', 'sku_field_updated', 'sku_disabled', 'sku_deleted',
    'shelf_created', 'shelf_field_updated', 'shelf_disabled', 'shelf_deleted',
    'brand_created', 'brand_updated', 'brand_deleted',
    'sku_type_created', 'sku_type_updated', 'sku_type_deleted',
    'shop_created', 'shop_updated', 'shop_deleted',
    'user_created', 'user_updated', 'user_disabled', 'user_deleted',
    'inbound_order_created', 'inbound_order_confirmed', 'inbound_order_voided',
    'outbound_order_created', 'outbound_order_confirmed', 'outbound_order_voided',
    'stocktake_task_created', 'stocktake_task_started', 'stocktake_task_finished', 'stocktake_task_voided',
    'inventory_adjust_created', 'inventory_adjust_confirmed', 'inventory_adjust_voided',
    'rakuten_mail_retried', 'rakuten_mail_cancelled', 'rakuten_mail_marked_sent',
    'rakuten_mail_template_saved', 'rakuten_mail_template_activated', 'rakuten_shipping_retried',
    'rakuten_automation_circuit_reset'
  ) NOT NULL;
