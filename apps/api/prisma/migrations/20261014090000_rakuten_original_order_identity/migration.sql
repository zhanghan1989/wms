ALTER TABLE `rakuten_order_records`
  ADD COLUMN `rms_order_id` VARCHAR(64) NULL;

-- Prefer explicit/source evidence. Never strip an A/B suffix heuristically.
UPDATE `rakuten_order_records`
SET `rms_order_id` = COALESCE(
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$._wmsOriginalOrderId')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.rmsOrder.orderNumber')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`raw_payload`, '$.rmsOrder.OrderNumber')), 'null'), ''),
  CASE WHEN `source_kind` = 'csv' THEN NULLIF(`mall_order_no`, '') ELSE NULL END,
  NULLIF(`order_id`, '')
);
CREATE INDEX `idx_rakuten_original_order` ON `rakuten_order_records` (`rms_connection_id`, `rms_order_id`);
