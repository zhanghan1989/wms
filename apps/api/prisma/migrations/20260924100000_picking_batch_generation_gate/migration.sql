-- Preserve existing batches as historical records without changing their work status.
ALTER TABLE `overseas_picking_batches`
  ADD COLUMN `completion_gate_required` BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE `overseas_picking_batches`
  ALTER COLUMN `completion_gate_required` SET DEFAULT TRUE;

CREATE TABLE `picking_batch_generation_locks` (
  `id` TINYINT NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `picking_batch_generation_locks` (`id`) VALUES (1);
