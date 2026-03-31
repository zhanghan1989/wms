DROP INDEX `order_records_imported_at_idx` ON `order_records`;

ALTER TABLE `order_records`
  CHANGE COLUMN `imported_at` `csv_imported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `shipment_no_registered_at` DATETIME(3) NULL AFTER `shipment_no`;

CREATE INDEX `order_records_csv_imported_at_idx` ON `order_records`(`csv_imported_at`);
