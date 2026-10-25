CREATE TABLE `site_branding` (
  `id` INTEGER NOT NULL,
  `site_name` VARCHAR(60) NOT NULL DEFAULT '库存管理系统',
  `logo` MEDIUMTEXT NOT NULL,
  `theme_color` VARCHAR(7) NOT NULL DEFAULT '#0f8a5f',
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
