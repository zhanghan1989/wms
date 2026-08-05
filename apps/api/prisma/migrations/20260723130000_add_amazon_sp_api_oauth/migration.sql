ALTER TABLE `amazon_sp_api_connections`
  ADD COLUMN `authorization_mode` VARCHAR(16) NOT NULL DEFAULT 'oauth',
  ADD COLUMN `authorized_at` DATETIME(3) NULL,
  ADD COLUMN `authorization_expires_at` DATETIME(3) NULL;

CREATE TABLE `amazon_sp_api_oauth_states` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `state_hash` CHAR(64) NOT NULL,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `region` VARCHAR(8) NOT NULL DEFAULT 'FE',
  `marketplace_ids` JSON NOT NULL,
  `sync_fbm_orders` BOOLEAN NOT NULL DEFAULT true,
  `sync_fba_orders` BOOLEAN NOT NULL DEFAULT true,
  `sync_fba_inventory` BOOLEAN NOT NULL DEFAULT true,
  `return_path` VARCHAR(255) NOT NULL DEFAULT '/',
  `created_by` BIGINT UNSIGNED NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `consumed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `amazon_sp_api_oauth_states_state_hash_key` (`state_hash`),
  INDEX `amazon_sp_api_oauth_states_shop_id_expires_at_idx` (`shop_id`, `expires_at`),
  INDEX `amazon_sp_api_oauth_states_expires_at_consumed_at_idx` (`expires_at`, `consumed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `amazon_sp_api_oauth_states`
  ADD CONSTRAINT `amazon_sp_api_oauth_states_shop_id_fkey`
  FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `amazon_sp_api_oauth_states`
  ADD CONSTRAINT `amazon_sp_api_oauth_states_created_by_fkey`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
