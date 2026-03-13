-- CreateTable
CREATE TABLE `amazon_shop_connections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL,
  `marketplace_id` VARCHAR(32) NOT NULL,
  `region` VARCHAR(32) NOT NULL,
  `seller_id` VARCHAR(64) NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `auth_config` JSON NULL,
  `remark` VARCHAR(255) NULL,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `amazon_shop_connections_name_key`(`name`),
  INDEX `amazon_shop_connections_status_created_at_idx`(`status`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `amazon_inbound_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_no` VARCHAR(64) NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('draft', 'payload_ready', 'pushed', 'failed', 'closed') NOT NULL DEFAULT 'draft',
  `source_type` VARCHAR(32) NOT NULL,
  `amazon_inbound_plan_id` VARCHAR(128) NULL,
  `last_operation_id` VARCHAR(128) NULL,
  `request_payload` JSON NULL,
  `response_payload` JSON NULL,
  `last_sync_at` DATETIME(3) NULL,
  `last_error` VARCHAR(512) NULL,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `pushed_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `amazon_inbound_jobs_job_no_key`(`job_no`),
  INDEX `amazon_inbound_jobs_connection_id_created_at_idx`(`connection_id`, `created_at`),
  INDEX `amazon_inbound_jobs_amazon_inbound_plan_id_idx`(`amazon_inbound_plan_id`),
  INDEX `amazon_inbound_jobs_status_created_at_idx`(`status`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `amazon_inbound_job_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `fba_replenishment_id` BIGINT UNSIGNED NOT NULL,
  `sku_id` BIGINT UNSIGNED NOT NULL,
  `box_id` BIGINT UNSIGNED NOT NULL,
  `requested_qty` INTEGER NOT NULL,
  `actual_qty` INTEGER NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `uq_amazon_job_item_job_replenishment`(`job_id`, `fba_replenishment_id`),
  INDEX `amazon_inbound_job_items_job_id_status_idx`(`job_id`, `status`),
  INDEX `amazon_inbound_job_items_fba_replenishment_id_idx`(`fba_replenishment_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `amazon_inbound_shipments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `amazon_shipment_id` VARCHAR(128) NOT NULL,
  `amazon_plan_id` VARCHAR(128) NULL,
  `shipment_name` VARCHAR(128) NULL,
  `destination_code` VARCHAR(64) NULL,
  `status` VARCHAR(64) NOT NULL,
  `payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `amazon_inbound_shipments_amazon_shipment_id_key`(`amazon_shipment_id`),
  INDEX `amazon_inbound_shipments_job_id_status_idx`(`job_id`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `amazon_api_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NULL,
  `job_id` BIGINT UNSIGNED NULL,
  `action` VARCHAR(64) NOT NULL,
  `request_method` VARCHAR(16) NULL,
  `request_url` VARCHAR(255) NULL,
  `request_body` JSON NULL,
  `response_status` INTEGER NULL,
  `response_body` JSON NULL,
  `status` ENUM('success', 'failed') NOT NULL DEFAULT 'success',
  `error_message` VARCHAR(512) NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `amazon_api_logs_connection_id_created_at_idx`(`connection_id`, `created_at`),
  INDEX `amazon_api_logs_job_id_created_at_idx`(`job_id`, `created_at`),
  INDEX `amazon_api_logs_status_created_at_idx`(`status`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterEnum
ALTER TABLE `operation_audit_logs`
MODIFY `event_type` ENUM(
  'box_created',
  'box_field_updated',
  'box_renamed',
  'box_disabled',
  'box_deleted',
  'box_stock_increased',
  'box_stock_outbound',
  'sku_created',
  'sku_field_updated',
  'sku_disabled',
  'sku_deleted',
  'shelf_created',
  'shelf_field_updated',
  'shelf_disabled',
  'shelf_deleted',
  'brand_created',
  'brand_updated',
  'brand_deleted',
  'sku_type_created',
  'sku_type_updated',
  'sku_type_deleted',
  'shop_created',
  'shop_updated',
  'shop_deleted',
  'user_created',
  'user_updated',
  'user_disabled',
  'user_deleted',
  'inbound_order_created',
  'inbound_order_confirmed',
  'inbound_order_voided',
  'outbound_order_created',
  'outbound_order_confirmed',
  'outbound_order_voided',
  'stocktake_task_created',
  'stocktake_task_started',
  'stocktake_task_finished',
  'stocktake_task_voided',
  'inventory_adjust_created',
  'inventory_adjust_confirmed',
  'inventory_adjust_voided',
  'amazon_connection_created',
  'amazon_connection_updated',
  'amazon_connection_deleted',
  'amazon_inbound_job_created',
  'amazon_inbound_job_payload_built',
  'amazon_inbound_job_pushed',
  'amazon_inbound_job_push_failed',
  'amazon_inbound_job_sync_failed',
  'amazon_inbound_job_synced'
) NOT NULL;

-- AddForeignKey
ALTER TABLE `amazon_shop_connections` ADD CONSTRAINT `amazon_shop_connections_created_by_fkey`
FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_jobs` ADD CONSTRAINT `amazon_inbound_jobs_connection_id_fkey`
FOREIGN KEY (`connection_id`) REFERENCES `amazon_shop_connections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_jobs` ADD CONSTRAINT `amazon_inbound_jobs_created_by_fkey`
FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_jobs` ADD CONSTRAINT `amazon_inbound_jobs_pushed_by_fkey`
FOREIGN KEY (`pushed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_job_items` ADD CONSTRAINT `amazon_inbound_job_items_job_id_fkey`
FOREIGN KEY (`job_id`) REFERENCES `amazon_inbound_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_job_items` ADD CONSTRAINT `amazon_inbound_job_items_fba_replenishment_id_fkey`
FOREIGN KEY (`fba_replenishment_id`) REFERENCES `fba_replenishments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_job_items` ADD CONSTRAINT `amazon_inbound_job_items_sku_id_fkey`
FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_job_items` ADD CONSTRAINT `amazon_inbound_job_items_box_id_fkey`
FOREIGN KEY (`box_id`) REFERENCES `boxes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_inbound_shipments` ADD CONSTRAINT `amazon_inbound_shipments_job_id_fkey`
FOREIGN KEY (`job_id`) REFERENCES `amazon_inbound_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_api_logs` ADD CONSTRAINT `amazon_api_logs_connection_id_fkey`
FOREIGN KEY (`connection_id`) REFERENCES `amazon_shop_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_api_logs` ADD CONSTRAINT `amazon_api_logs_job_id_fkey`
FOREIGN KEY (`job_id`) REFERENCES `amazon_inbound_jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `amazon_api_logs` ADD CONSTRAINT `amazon_api_logs_created_by_fkey`
FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
