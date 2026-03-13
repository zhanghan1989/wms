ALTER TABLE `amazon_inbound_job_items`
ADD COLUMN `fba_carton_ref` VARCHAR(64) NULL AFTER `box_id`;

UPDATE `amazon_inbound_job_items` item
INNER JOIN `fba_replenishments` replenishment ON replenishment.`id` = item.`fba_replenishment_id`
SET item.`fba_carton_ref` = replenishment.`request_no`
WHERE item.`fba_carton_ref` IS NULL OR item.`fba_carton_ref` = '';

ALTER TABLE `amazon_inbound_job_items`
MODIFY COLUMN `fba_carton_ref` VARCHAR(64) NOT NULL;

CREATE INDEX `amazon_inbound_job_items_job_id_fba_carton_ref_idx`
ON `amazon_inbound_job_items`(`job_id`, `fba_carton_ref`);
