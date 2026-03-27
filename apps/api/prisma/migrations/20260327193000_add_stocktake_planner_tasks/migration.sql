CREATE TABLE `stocktake_planner_tasks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_no` VARCHAR(64) NOT NULL,
  `planned_date` DATE NOT NULL,
  `shelf_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('pending', 'confirmed') NOT NULL DEFAULT 'pending',
  `created_by` BIGINT UNSIGNED NOT NULL,
  `confirmed_by` BIGINT UNSIGNED NULL,
  `confirmed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `stocktake_planner_tasks_task_no_key`(`task_no`),
  INDEX `stocktake_planner_tasks_planned_date_idx`(`planned_date`),
  INDEX `stocktake_planner_tasks_shelf_id_idx`(`shelf_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `stocktake_planner_tasks`
  ADD CONSTRAINT `stocktake_planner_tasks_shelf_id_fkey`
    FOREIGN KEY (`shelf_id`) REFERENCES `shelves`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `stocktake_planner_tasks_created_by_fkey`
    FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `stocktake_planner_tasks_confirmed_by_fkey`
    FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
