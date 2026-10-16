ALTER TABLE `rakuten_rms_connections`
  ADD COLUMN `inventory_last_full_synced_at` DATETIME(3) NULL;
ALTER TABLE `rakuten_inventory_mappings`
  ADD COLUMN `last_published_quantity` INTEGER NULL,
  ADD COLUMN `last_published_at` DATETIME(3) NULL;
