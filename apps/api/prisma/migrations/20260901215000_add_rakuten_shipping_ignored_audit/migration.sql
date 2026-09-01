ALTER TABLE `operation_audit_logs`
  MODIFY COLUMN `event_type` ENUM(
    'box_created', 'box_field_updated', 'box_renamed', 'box_disabled', 'box_deleted',
    'box_stock_increased', 'box_stock_outbound',
    'sku_created', 'sku_field_updated', 'sku_disabled', 'sku_deleted',
    'shelf_created', 'shelf_field_updated', 'shelf_disabled', 'shelf_deleted',
    'brand_created', 'brand_updated', 'brand_deleted',
    'sku_type_created', 'sku_type_updated', 'sku_type_deleted',
    'shop_created', 'shop_updated', 'shop_deleted',
    'user_created', 'user_updated', 'user_disabled', 'user_deleted',
    'inbound_order_created', 'inbound_order_confirmed', 'inbound_order_voided',
    'outbound_order_created', 'outbound_order_confirmed', 'outbound_order_voided',
    'stocktake_task_created', 'stocktake_task_started', 'stocktake_task_finished', 'stocktake_task_voided',
    'inventory_adjust_created', 'inventory_adjust_confirmed', 'inventory_adjust_voided',
    'rakuten_mail_retried', 'rakuten_mail_cancelled', 'rakuten_mail_marked_sent',
    'rakuten_mail_template_saved', 'rakuten_mail_template_activated', 'rakuten_shipping_retried',
    'rakuten_shipping_ignored', 'rakuten_automation_circuit_reset'
  ) NOT NULL;
