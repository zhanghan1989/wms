-- CreateTable
CREATE TABLE `amazon_inbound_box_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `shipment_id` BIGINT UNSIGNED NOT NULL,
  `box_id` BIGINT UNSIGNED NOT NULL,
  `amazon_shipment_id` VARCHAR(128) NOT NULL,
  `amazon_box_id` VARCHAR(128) NOT NULL,
  `msku` VARCHAR(128) NULL,
  `fnsku` VARCHAR(128) NULL,
  `asin` VARCHAR(32) NULL,
  `quantity` INTEGER NULL,
  `payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  INDEX `amazon_inbound_box_items_job_id_amazon_shipment_id_idx`(`job_id`, `amazon_shipment_id`),
  INDEX `amazon_inbound_box_items_shipment_id_amazon_box_id_idx`(`shipment_id`, `amazon_box_id`),
  INDEX `amazon_inbound_box_items_box_id_idx`(`box_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `amazon_inbound_box_items` ADD CONSTRAINT `amazon_inbound_box_items_job_id_fkey`
FOREIGN KEY (`job_id`) REFERENCES `amazon_inbound_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_box_items` ADD CONSTRAINT `amazon_inbound_box_items_shipment_id_fkey`
FOREIGN KEY (`shipment_id`) REFERENCES `amazon_inbound_shipments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_box_items` ADD CONSTRAINT `amazon_inbound_box_items_box_id_fkey`
FOREIGN KEY (`box_id`) REFERENCES `amazon_inbound_boxes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
