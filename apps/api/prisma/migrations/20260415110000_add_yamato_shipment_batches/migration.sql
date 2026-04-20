CREATE TABLE `yamato_shipment_batches` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `exported_file_name` VARCHAR(255) NULL,
  `pdf_file_name` VARCHAR(255) NULL,
  `pdf_file_path` VARCHAR(512) NULL,
  `pdf_uploaded_at` DATETIME(3) NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'excel_exported',
  `page_count` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `yamato_shipment_batches_status_created_at_idx`(`status`, `created_at`),
  INDEX `yamato_shipment_batches_pdf_uploaded_at_idx`(`pdf_uploaded_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `yamato_shipment_batch_pages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` BIGINT UNSIGNED NOT NULL,
  `page_no` INTEGER NOT NULL,
  `order_id` VARCHAR(64) NULL,
  `product_ids` JSON NULL,
  `item_summary` TEXT NULL,
  `tracking_no` VARCHAR(128) NULL,
  `recipient_name` VARCHAR(255) NULL,
  `page_text` TEXT NULL,
  `printed_at` DATETIME(3) NULL,
  `printed_product_id` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `uq_yamato_shipment_batch_pages_batch_page`(`batch_id`, `page_no`),
  INDEX `yamato_shipment_batch_pages_batch_id_printed_at_idx`(`batch_id`, `printed_at`),
  INDEX `yamato_shipment_batch_pages_order_id_idx`(`order_id`),
  INDEX `yamato_shipment_batch_pages_tracking_no_idx`(`tracking_no`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `yamato_shipment_batch_pages`
  ADD CONSTRAINT `yamato_shipment_batch_pages_batch_id_fkey`
  FOREIGN KEY (`batch_id`) REFERENCES `yamato_shipment_batches`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
