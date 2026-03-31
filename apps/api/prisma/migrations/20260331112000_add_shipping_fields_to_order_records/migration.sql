ALTER TABLE `order_records`
  ADD COLUMN `shipment_company` VARCHAR(128) NULL AFTER `shipping_phone`,
  ADD COLUMN `shipment_no` VARCHAR(128) NULL AFTER `shipment_company`,
  ADD COLUMN `imported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER `raw_payload`;

CREATE INDEX `order_records_imported_at_idx` ON `order_records`(`imported_at`);
