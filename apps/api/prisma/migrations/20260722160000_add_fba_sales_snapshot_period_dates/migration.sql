ALTER TABLE `fba_sales_snapshots`
  ADD COLUMN `period_start` DATE NULL AFTER `period_days`,
  ADD COLUMN `period_end` DATE NULL AFTER `period_start`;
