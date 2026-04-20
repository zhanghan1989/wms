ALTER TABLE `master_products`
  ADD COLUMN `yamato_printer_name` VARCHAR(128) NULL AFTER `size`;

CREATE TABLE `print_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type` VARCHAR(32) NOT NULL DEFAULT 'yamato_label',
  `status` ENUM('pending', 'claimed', 'completed', 'failed', 'canceled') NOT NULL DEFAULT 'pending',
  `batch_page_id` BIGINT UNSIGNED NULL,
  `order_id` VARCHAR(128) NULL,
  `product_id` VARCHAR(128) NOT NULL,
  `printer_name` VARCHAR(128) NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_path` VARCHAR(512) NULL,
  `tracking_no` VARCHAR(64) NULL,
  `agent_name` VARCHAR(128) NULL,
  `claim_token` VARCHAR(64) NULL,
  `system_job_id` VARCHAR(128) NULL,
  `error_message` VARCHAR(255) NULL,
  `queued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `claimed_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  `failed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uq_print_jobs_claim_token`(`claim_token`),
  INDEX `print_jobs_status_queued_at_idx`(`status`, `queued_at`),
  INDEX `print_jobs_printer_status_queued_at_idx`(`printer_name`, `status`, `queued_at`),
  INDEX `print_jobs_batch_page_status_idx`(`batch_page_id`, `status`),
  INDEX `print_jobs_product_id_queued_at_idx`(`product_id`, `queued_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `print_jobs`
  ADD CONSTRAINT `print_jobs_batch_page_id_fkey`
  FOREIGN KEY (`batch_page_id`) REFERENCES `yamato_shipment_batch_pages`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
