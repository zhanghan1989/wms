ALTER TABLE `rakuten_order_records`
  ADD COLUMN `rms_manual_override_at` DATETIME(3) NULL,
  ADD COLUMN `rms_manual_override_by` VARCHAR(64) NULL,
  ADD COLUMN `rms_manual_action_type` VARCHAR(16) NULL,
  ADD COLUMN `rms_manual_action_changed_fields` JSON NULL,
  ADD COLUMN `rms_manual_action_observed_payload` JSON NULL,
  ADD COLUMN `rms_manual_action_observed_hash` CHAR(40) NULL,
  ADD COLUMN `rms_manual_action_detected_at` DATETIME(3) NULL,
  ADD COLUMN `rms_manual_action_resolved_at` DATETIME(3) NULL,
  ADD COLUMN `rms_manual_action_resolved_by` VARCHAR(64) NULL,
  ADD INDEX `idx_rakuten_rms_manual_action` (`rms_manual_action_detected_at`, `rms_manual_action_resolved_at`),
  ADD INDEX `idx_rakuten_rms_manual_override` (`rms_manual_override_at`);

UPDATE `rakuten_order_records`
SET `rms_manual_override_at` = COALESCE(`updated_at`, CURRENT_TIMESTAMP(3)),
    `rms_manual_override_by` = 'legacy'
WHERE JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$._wmsManualOverrideFields')) IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$._wmsManualOverrideFields')) <> '';

UPDATE `rakuten_order_records` AS target
INNER JOIN `rakuten_order_records` AS source
  ON source.`order_id` = target.`order_id`
  AND source.`shop_name` <=> target.`shop_name`
  AND source.`rms_manual_override_at` IS NOT NULL
SET target.`rms_manual_override_at` = COALESCE(target.`rms_manual_override_at`, source.`rms_manual_override_at`),
    target.`rms_manual_override_by` = COALESCE(target.`rms_manual_override_by`, 'legacy-order');

ALTER TABLE `rakuten_rms_sync_runs`
  ADD COLUMN `manual_action_count` INTEGER NOT NULL DEFAULT 0 AFTER `skipped_count`;

CREATE TABLE `rakuten_order_sync_exclusions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `rms_connection_id` BIGINT UNSIGNED NULL,
  `shop_name` VARCHAR(128) NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `rms_item_key` VARCHAR(191) NULL,
  `sku_code` VARCHAR(128) NULL,
  `reason` VARCHAR(64) NOT NULL DEFAULT 'user_delete',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `idx_rakuten_order_exclusion_lookup` (`shop_name`, `order_id`, `rms_item_key`, `sku_code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
