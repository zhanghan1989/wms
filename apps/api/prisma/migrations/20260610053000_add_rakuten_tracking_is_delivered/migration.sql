ALTER TABLE `rakuten_order_records`
  ADD COLUMN `tracking_is_delivered` BOOLEAN NOT NULL DEFAULT false AFTER `tracking_has_customs_clearance`;

UPDATE `rakuten_order_records`
SET `tracking_is_delivered` = true
WHERE `tracking_status_label` LIKE '%配達完了%';

CREATE INDEX `rakuten_order_records_tracking_is_delivered_idx`
  ON `rakuten_order_records`(`tracking_is_delivered`);
