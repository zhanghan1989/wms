ALTER TABLE `order_records`
  ADD COLUMN `send_status` ENUM('unsent', 'sent') NOT NULL DEFAULT 'unsent' AFTER `shipment_no_registered_at`;

UPDATE `order_records`
SET `send_status` = CASE
  WHEN `shipment_no` IS NOT NULL AND TRIM(`shipment_no`) <> '' THEN 'sent'
  ELSE 'unsent'
END;
