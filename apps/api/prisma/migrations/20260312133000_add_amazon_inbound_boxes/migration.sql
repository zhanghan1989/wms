-- CreateTable
CREATE TABLE `amazon_inbound_boxes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `shipment_id` BIGINT UNSIGNED NOT NULL,
  `amazon_shipment_id` VARCHAR(128) NOT NULL,
  `amazon_box_id` VARCHAR(128) NOT NULL,
  `box_sequence` INTEGER NULL,
  `template_name` VARCHAR(128) NULL,
  `content_source` VARCHAR(64) NULL,
  `quantity` INTEGER NULL,
  `status` VARCHAR(64) NULL,
  `payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uq_amazon_inbound_box_shipment_box`(`shipment_id`, `amazon_box_id`),
  INDEX `amazon_inbound_boxes_job_id_amazon_shipment_id_idx`(`job_id`, `amazon_shipment_id`),
  INDEX `amazon_inbound_boxes_shipment_id_status_idx`(`shipment_id`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `amazon_inbound_boxes` ADD CONSTRAINT `amazon_inbound_boxes_job_id_fkey`
FOREIGN KEY (`job_id`) REFERENCES `amazon_inbound_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_boxes` ADD CONSTRAINT `amazon_inbound_boxes_shipment_id_fkey`
FOREIGN KEY (`shipment_id`) REFERENCES `amazon_inbound_shipments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
