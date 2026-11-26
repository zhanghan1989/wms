ALTER TABLE `manual_order_records`
  ADD COLUMN `delivery_date_raw` VARCHAR(10) NULL,
  ADD COLUMN `delivery_time_slot` VARCHAR(4) NULL;
