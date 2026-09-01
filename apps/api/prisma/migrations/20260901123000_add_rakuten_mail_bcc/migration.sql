ALTER TABLE `rakuten_rms_connections`
  ADD COLUMN `smtp_bcc_addresses` VARCHAR(1000) NULL AFTER `smtp_from_name`;

ALTER TABLE `rakuten_order_mails`
  ADD COLUMN `bcc_recipients` VARCHAR(1000) NULL AFTER `recipient`;
