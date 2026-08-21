ALTER TABLE `rakuten_order_records`
ADD COLUMN `order_imported_date` DATE NULL AFTER `order_imported_at_raw`;

UPDATE `rakuten_order_records`
SET `order_imported_date` = CASE
  WHEN TRIM(`order_imported_at_raw`) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.*Z$' THEN
    DATE(DATE_ADD(
      STR_TO_DATE(LEFT(TRIM(`order_imported_at_raw`), 19), '%Y-%m-%dT%H:%i:%s'),
      INTERVAL 9 HOUR
    ))
  WHEN TRIM(`order_imported_at_raw`) REGEXP '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}' THEN
    STR_TO_DATE(REGEXP_SUBSTR(TRIM(`order_imported_at_raw`), '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}'), '%Y-%c-%e')
  WHEN TRIM(`order_imported_at_raw`) REGEXP '^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}' THEN
    STR_TO_DATE(REGEXP_SUBSTR(TRIM(`order_imported_at_raw`), '^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}'), '%Y/%c/%e')
  WHEN TRIM(`order_imported_at_raw`) REGEXP '^[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日' THEN
    STR_TO_DATE(REGEXP_SUBSTR(TRIM(`order_imported_at_raw`), '^[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日'), '%Y年%c月%e日')
  WHEN TRIM(`order_imported_at_raw`) REGEXP '^[0-9]{8}([^0-9]|$)' THEN
    STR_TO_DATE(LEFT(TRIM(`order_imported_at_raw`), 8), '%Y%m%d')
  WHEN TRIM(`order_imported_at_raw`) REGEXP '^[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{4}' THEN
    STR_TO_DATE(
      REPLACE(REGEXP_SUBSTR(TRIM(`order_imported_at_raw`), '^[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{4}'), '-', '/'),
      '%c/%e/%Y'
    )
  ELSE NULL
END
WHERE `order_imported_at_raw` IS NOT NULL
  AND TRIM(`order_imported_at_raw`) <> '';

ALTER TABLE `rakuten_order_records`
DROP INDEX `idx_rakuten_orders_dashboard_scope`,
ADD INDEX `idx_rakuten_orders_dashboard_scope` (`rms_connection_id`, `order_imported_date`);
