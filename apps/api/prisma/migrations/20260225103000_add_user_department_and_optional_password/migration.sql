ALTER TABLE `users`
  MODIFY `password_hash` VARCHAR(255) NULL;

ALTER TABLE `users`
  ADD COLUMN `department` ENUM('factory', 'overseas_warehouse', 'china_warehouse')
  NOT NULL
  DEFAULT 'china_warehouse'
  AFTER `role`;
