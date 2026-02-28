ALTER TABLE `users`
  MODIFY COLUMN `department` VARCHAR(64) NOT NULL DEFAULT 'china_warehouse';

ALTER TABLE `department_options`
  MODIFY COLUMN `code` VARCHAR(64) NOT NULL;
