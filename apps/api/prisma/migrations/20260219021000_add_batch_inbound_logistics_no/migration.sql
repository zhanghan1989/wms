-- AlterTable
ALTER TABLE `batch_inbound_orders`
  ADD COLUMN `domestic_order_no` VARCHAR(128) NULL AFTER `uploaded_file_name`,
  ADD COLUMN `sea_order_no` VARCHAR(128) NULL AFTER `domestic_order_no`;
