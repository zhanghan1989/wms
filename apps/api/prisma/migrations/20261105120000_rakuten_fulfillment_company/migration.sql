-- Rakuten remains Japan-operated. Only the fulfillment assignment follows the
-- product owner; unknown products stay unassigned for Japan to resolve.
ALTER TABLE `rakuten_order_records`
  ADD COLUMN `fulfillment_company_id` BIGINT UNSIGNED NULL,
  ADD INDEX `rakuten_order_records_fulfillment_company_id_idx` (`fulfillment_company_id`),
  ADD CONSTRAINT `rakuten_order_records_fulfillment_company_id_fkey`
    FOREIGN KEY (`fulfillment_company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE `rakuten_order_records` AS r
JOIN `master_products` AS p
  ON p.`product_id` = COALESCE(NULLIF(TRIM(r.`sku_code`), ''), NULLIF(TRIM(r.`set_component_sku_code`), ''))
SET r.`fulfillment_company_id` = p.`company_id`;
