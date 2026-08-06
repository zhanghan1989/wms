CREATE TABLE `amazon_order_sync_exclusions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sp_api_connection_id` BIGINT UNSIGNED NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `order_item_id` VARCHAR(64) NULL,
  `reason` VARCHAR(64) NOT NULL DEFAULT 'user_delete',
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `restored_by` BIGINT UNSIGNED NULL,
  `restored_at` DATETIME(3) NULL,

  INDEX `idx_amz_order_exclusion_lookup` (`is_active`, `sp_api_connection_id`, `order_id`, `order_item_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `amazon_order_sync_observations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sp_api_connection_id` BIGINT UNSIGNED NOT NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `order_item_id` VARCHAR(64) NOT NULL,
  `order_status` VARCHAR(32) NULL,
  `quantity_ordered` INTEGER NULL,
  `quantity_shipped` INTEGER NULL,
  `quantity_to_ship` INTEGER NULL,
  `freeze_reason` VARCHAR(64) NULL,
  `raw_payload` JSON NULL,
  `observed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_amz_order_observation` (`sp_api_connection_id`, `order_id`, `order_item_id`),
  INDEX `idx_amz_order_observation_order` (`order_id`, `order_item_id`, `observed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
