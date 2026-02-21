-- AlterTable
ALTER TABLE `fba_replenishments`
  MODIFY `status` ENUM('pending_confirm', 'pending_outbound', 'outbound', 'deleted') NOT NULL DEFAULT 'pending_confirm',
  ADD COLUMN `deleted_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `deleted_at` DATETIME(3) NULL;

-- AddForeignKey
ALTER TABLE `fba_replenishments`
  ADD CONSTRAINT `fba_replenishments_deleted_by_fkey`
  FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;