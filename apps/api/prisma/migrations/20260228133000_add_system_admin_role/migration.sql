ALTER TABLE `users`
  MODIFY COLUMN `role` ENUM('employee', 'admin', 'system_admin') NOT NULL;

ALTER TABLE `role_options`
  MODIFY COLUMN `code` ENUM('employee', 'admin', 'system_admin') NOT NULL;

INSERT INTO `role_options` (`code`, `name`, `status`, `sort`)
VALUES ('system_admin', '系统管理员', 1, 30)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `sort` = VALUES(`sort`),
  `updated_at` = CURRENT_TIMESTAMP(3);
