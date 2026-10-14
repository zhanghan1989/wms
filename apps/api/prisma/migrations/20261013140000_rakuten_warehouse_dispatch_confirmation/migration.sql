ALTER TABLE `rakuten_order_records`
  ADD COLUMN `warehouse_shipped_at` DATETIME(3) NULL,
  ADD COLUMN `warehouse_shipped_by` BIGINT UNSIGNED NULL;
ALTER TABLE `overseas_picking_batches`
  ADD COLUMN `work_completed_at` DATETIME(3) NULL,
  ADD COLUMN `work_completed_by` BIGINT UNSIGNED NULL;
-- No timestamp backfill from registration/printing/update dates: old batches
-- require an explicit warehouse confirmation under the new shipping rule.
