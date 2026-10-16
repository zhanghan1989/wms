ALTER TABLE `rakuten_inventory_mappings`
  ADD COLUMN `sync_issue` TEXT NULL,
  ADD COLUMN `sync_issue_at` DATETIME(3) NULL;
ALTER TABLE `rakuten_inventory_runs` ADD COLUMN `plan_purged_at` DATETIME(3) NULL;
CREATE INDEX `rakuten_inventory_runs_plan_purged_at_finished_at_idx` ON `rakuten_inventory_runs` (`plan_purged_at`, `finished_at`);
