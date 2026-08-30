ALTER TABLE `overseas_picking_batch_items`
  ADD COLUMN `bom_snapshot` JSON NULL AFTER `picking_plan_snapshot`;

CREATE TABLE `shoulder_strap_part_stock_movements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `part_id` BIGINT UNSIGNED NOT NULL,
  `movement_type` VARCHAR(32) NOT NULL,
  `ref_type` VARCHAR(32) NOT NULL,
  `ref_id` BIGINT UNSIGNED NOT NULL,
  `product_id` VARCHAR(128) NULL,
  `qty_delta` INTEGER NOT NULL,
  `before_qty` INTEGER NOT NULL,
  `after_qty` INTEGER NOT NULL,
  `operator_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `idx_shoulder_part_movements_part_created`(`part_id`, `created_at`),
  INDEX `idx_shoulder_part_movements_ref`(`ref_type`, `ref_id`),
  INDEX `idx_shoulder_part_movements_product_created`(`product_id`, `created_at`),
  CONSTRAINT `shoulder_strap_part_stock_movements_part_id_fkey`
    FOREIGN KEY (`part_id`) REFERENCES `shoulder_strap_parts`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `shoulder_strap_part_stock_movements_operator_id_fkey`
    FOREIGN KEY (`operator_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
