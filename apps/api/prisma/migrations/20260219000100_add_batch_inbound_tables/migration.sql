-- CreateTable
CREATE TABLE `batch_inbound_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no` VARCHAR(64) NOT NULL,
  `status` ENUM('waiting_upload', 'waiting_inbound', 'confirmed', 'void') NOT NULL,
  `expected_box_count` INTEGER NOT NULL,
  `range_start` INTEGER NOT NULL,
  `range_end` INTEGER NOT NULL,
  `collected_box_codes` JSON NOT NULL,
  `uploaded_file_name` VARCHAR(255) NULL,
  `remark` VARCHAR(255) NULL,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `batch_inbound_orders_order_no_key`(`order_no`),
  INDEX `batch_inbound_orders_created_by_idx`(`created_by`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `batch_inbound_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `box_code` VARCHAR(128) NOT NULL,
  `sku_code` VARCHAR(128) NOT NULL,
  `qty` INTEGER NOT NULL,
  `source_row_no` INTEGER NULL,
  `status` ENUM('pending', 'confirmed') NOT NULL DEFAULT 'pending',
  `confirmed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `uq_batch_order_box_sku`(`order_id`, `box_code`, `sku_code`),
  INDEX `batch_inbound_items_order_id_status_idx`(`order_id`, `status`),
  INDEX `batch_inbound_items_order_id_box_code_idx`(`order_id`, `box_code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `batch_inbound_orders`
  ADD CONSTRAINT `batch_inbound_orders_created_by_fkey`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `batch_inbound_items`
  ADD CONSTRAINT `batch_inbound_items_order_id_fkey`
  FOREIGN KEY (`order_id`) REFERENCES `batch_inbound_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
