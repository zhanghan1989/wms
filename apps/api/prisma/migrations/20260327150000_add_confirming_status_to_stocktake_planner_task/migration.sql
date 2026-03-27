ALTER TABLE `stocktake_planner_tasks`
  MODIFY COLUMN `status` ENUM('pending', 'confirming', 'confirmed', 'canceled') NOT NULL DEFAULT 'pending';
