RENAME TABLE `order_records` TO `rakuten_order_records`;

ALTER TABLE `rakuten_order_records`
  RENAME INDEX `order_records_row_hash_key` TO `rakuten_order_records_row_hash_key`,
  RENAME INDEX `order_records_order_id_idx` TO `rakuten_order_records_order_id_idx`,
  RENAME INDEX `order_records_mall_order_no_idx` TO `rakuten_order_records_mall_order_no_idx`,
  RENAME INDEX `order_records_sku_code_idx` TO `rakuten_order_records_sku_code_idx`,
  RENAME INDEX `order_records_created_at_idx` TO `rakuten_order_records_created_at_idx`,
  RENAME INDEX `order_records_csv_imported_at_idx` TO `rakuten_order_records_csv_imported_at_idx`;
