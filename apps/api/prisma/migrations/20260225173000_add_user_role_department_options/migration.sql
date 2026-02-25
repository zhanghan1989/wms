CREATE TABLE `department_options` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` ENUM('factory', 'overseas_warehouse', 'china_warehouse') NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `sort` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `department_options_code_key`(`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `role_options` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` ENUM('employee', 'admin') NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `sort` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `role_options_code_key`(`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `department_options` (`code`, `name`, `status`, `sort`)
VALUES
  ('factory', '工厂', 1, 10),
  ('overseas_warehouse', '海外仓', 1, 20),
  ('china_warehouse', '中国仓', 1, 30);

INSERT INTO `role_options` (`code`, `name`, `status`, `sort`)
VALUES
  ('employee', '员工', 1, 10),
  ('admin', '管理者', 1, 20);
