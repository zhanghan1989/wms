-- CreateTable
CREATE TABLE `product_edit_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sku_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('pending') NOT NULL DEFAULT 'pending',
  `before_data` JSON NOT NULL,
  `after_data` JSON NOT NULL,
  `changed_fields` JSON NOT NULL,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  INDEX `product_edit_requests_sku_id_created_at_idx`(`sku_id`, `created_at`),
  INDEX `product_edit_requests_created_by_created_at_idx`(`created_by`, `created_at`),
  INDEX `product_edit_requests_status_created_at_idx`(`status`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_edit_requests` ADD CONSTRAINT `product_edit_requests_sku_id_fkey` FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_edit_requests` ADD CONSTRAINT `product_edit_requests_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
