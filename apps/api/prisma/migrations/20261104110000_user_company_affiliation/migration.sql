ALTER TABLE `users` DROP FOREIGN KEY `users_company_id_fkey`;
ALTER TABLE `users` MODIFY `company_id` BIGINT UNSIGNED NULL;
ALTER TABLE `users` ADD CONSTRAINT `users_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `operation_audit_logs` DROP FOREIGN KEY `operation_audit_logs_company_id_fkey`;
ALTER TABLE `operation_audit_logs` MODIFY `company_id` BIGINT UNSIGNED NULL;
ALTER TABLE `operation_audit_logs` ADD CONSTRAINT `operation_audit_logs_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE `users` SET `company_id`=NULL, `session_version`=`session_version`+1 WHERE (`role`='system_admin' OR `department`='overseas_warehouse') AND `company_id` IS NOT NULL;
