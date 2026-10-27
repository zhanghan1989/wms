ALTER TABLE `rakuten_rms_connections`
  ADD COLUMN `sales_coverage_start` DATETIME(3) NULL,
  ADD COLUMN `sales_coverage_end` DATETIME(3) NULL,
  ADD COLUMN `last_sales_synced_at` DATETIME(3) NULL,
  ADD COLUMN `last_sales_sync_error` TEXT NULL;

CREATE TABLE `rakuten_sales_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `order_id` VARCHAR(128) NOT NULL,
  `ordered_at` DATETIME(3) NOT NULL,
  `order_progress` VARCHAR(32) NOT NULL,
  `goods_amount` DECIMAL(16,2) NOT NULL,
  `coupon_amount` DECIMAL(16,2) NOT NULL,
  `items` JSON NOT NULL,
  `content_hash` CHAR(64) NOT NULL,
  `synced_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `rakuten_sales_snapshots_connection_id_order_id_key` (`connection_id`, `order_id`),
  INDEX `rakuten_sales_snapshots_connection_id_ordered_at_idx` (`connection_id`, `ordered_at`),
  CONSTRAINT `rakuten_sales_snapshots_connection_id_fkey` FOREIGN KEY (`connection_id`) REFERENCES `rakuten_rms_connections` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `operation_audit_logs` MODIFY `event_type` ENUM('box_created','box_field_updated','box_renamed','box_disabled','box_deleted','box_stock_increased','box_stock_outbound','sku_created','sku_field_updated','sku_disabled','sku_deleted','shelf_created','shelf_field_updated','shelf_disabled','shelf_deleted','brand_created','brand_updated','brand_deleted','sku_type_created','sku_type_updated','sku_type_deleted','shop_created','shop_updated','shop_deleted','shop_platform_created','user_created','user_updated','user_disabled','user_deleted','inbound_order_created','inbound_order_confirmed','inbound_order_voided','outbound_order_created','outbound_order_confirmed','outbound_order_voided','stocktake_task_created','stocktake_task_started','stocktake_task_finished','stocktake_task_voided','inventory_adjust_created','inventory_adjust_confirmed','inventory_adjust_voided','rakuten_mail_retried','rakuten_mail_cancelled','rakuten_mail_marked_sent','rakuten_mail_template_saved','rakuten_mail_template_activated','rakuten_shipping_retried','rakuten_shipping_ignored','rakuten_automation_circuit_reset','rakuten_sales_reconciled') NOT NULL;
