-- CreateTable
CREATE TABLE `fba_replenishments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_no` VARCHAR(64) NOT NULL,
  `status` ENUM('pending_confirm', 'pending_outbound', 'outbound') NOT NULL DEFAULT 'pending_confirm',
  `sku_id` BIGINT UNSIGNED NOT NULL,
  `box_id` BIGINT UNSIGNED NOT NULL,
  `requested_qty` INTEGER NOT NULL,
  `actual_qty` INTEGER NULL,
  `express_no` VARCHAR(128) NULL,
  `remark` VARCHAR(128) NULL,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `confirmed_by` BIGINT UNSIGNED NULL,
  `outbound_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `confirmed_at` DATETIME(3) NULL,
  `outbound_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `fba_replenishments_request_no_key`(`request_no`),
  INDEX `fba_replenishments_status_created_at_idx`(`status`, `created_at`),
  INDEX `fba_replenishments_sku_id_status_idx`(`sku_id`, `status`),
  INDEX `fba_replenishments_box_id_status_idx`(`box_id`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `fba_replenishments` ADD CONSTRAINT `fba_replenishments_sku_id_fkey` FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fba_replenishments` ADD CONSTRAINT `fba_replenishments_box_id_fkey` FOREIGN KEY (`box_id`) REFERENCES `boxes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fba_replenishments` ADD CONSTRAINT `fba_replenishments_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fba_replenishments` ADD CONSTRAINT `fba_replenishments_confirmed_by_fkey` FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fba_replenishments` ADD CONSTRAINT `fba_replenishments_outbound_by_fkey` FOREIGN KEY (`outbound_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
