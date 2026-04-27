ALTER TABLE `yamato_shipment_batch_pages`
  ADD COLUMN `printer_value` VARCHAR(128) NULL AFTER `product_ids`,
  ADD COLUMN `printer_name` VARCHAR(128) NULL AFTER `printer_value`;
