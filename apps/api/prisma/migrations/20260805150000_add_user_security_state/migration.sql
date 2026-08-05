ALTER TABLE `users`
  ADD COLUMN `password_changed_at` DATETIME(3) NULL,
  ADD COLUMN `mfa_secret_encrypted` TEXT NULL,
  ADD COLUMN `mfa_secret_iv` VARCHAR(64) NULL,
  ADD COLUMN `mfa_secret_auth_tag` VARCHAR(64) NULL,
  ADD COLUMN `mfa_enabled_at` DATETIME(3) NULL;
