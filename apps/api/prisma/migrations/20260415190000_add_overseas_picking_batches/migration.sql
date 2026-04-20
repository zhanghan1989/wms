CREATE TABLE `overseas_picking_batches` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_no` VARCHAR(64) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'created',
  `order_count` INT NOT NULL DEFAULT 0,
  `item_count` INT NOT NULL DEFAULT 0,
  `total_qty` INT NOT NULL DEFAULT 0,
  `created_by` BIGINT UNSIGNED NULL,
  `confirmed_by` BIGINT UNSIGNED NULL,
  `confirmed_at` DATETIME(3) NULL,
  `remark` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `overseas_picking_batches_batch_no_key`(`batch_no`),
  INDEX `overseas_picking_batches_status_created_at_idx`(`status`, `created_at`),
  INDEX `overseas_picking_batches_confirmed_at_idx`(`confirmed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `overseas_picking_batch_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` BIGINT UNSIGNED NOT NULL,
  `source` VARCHAR(16) NOT NULL,
  `source_record_id` BIGINT UNSIGNED NOT NULL,
  `order_id` VARCHAR(64) NULL,
  `sku_code` VARCHAR(128) NULL,
  `product_id` VARCHAR(128) NOT NULL,
  `requested_qty` INT NOT NULL,
  `actual_qty` INT NULL,
  `available_stock_snapshot` INT NOT NULL DEFAULT 0,
  `shop_name` VARCHAR(128) NULL,
  `shipping_name` VARCHAR(255) NULL,
  `shipment_tracking_no` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uq_overseas_picking_batch_items_batch_source_record`(`batch_id`, `source`, `source_record_id`),
  INDEX `overseas_picking_batch_items_batch_id_product_id_idx`(`batch_id`, `product_id`),
  INDEX `overseas_picking_batch_items_source_source_record_id_idx`(`source`, `source_record_id`),
  INDEX `overseas_picking_batch_items_order_id_idx`(`order_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `overseas_picking_batch_items`
  ADD CONSTRAINT `overseas_picking_batch_items_batch_id_fkey`
  FOREIGN KEY (`batch_id`) REFERENCES `overseas_picking_batches`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `yamato_shipment_batches`
  ADD COLUMN `picking_batch_id` BIGINT UNSIGNED NULL AFTER `id`,
  ADD UNIQUE INDEX `yamato_shipment_batches_picking_batch_id_key`(`picking_batch_id`);
