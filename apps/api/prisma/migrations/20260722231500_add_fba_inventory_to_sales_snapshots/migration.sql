ALTER TABLE `fba_sales_snapshots`
  ADD COLUMN `inventory_file_name` VARCHAR(255) NULL,
  ADD COLUMN `inventory_snapshot_date` DATE NULL,
  ADD COLUMN `inventory_rows` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_available_qty` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_inbound_qty` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_reserved_qty` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_unfulfillable_qty` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `fba_sales_snapshot_items`
  ADD COLUMN `fba_available_qty` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_inbound_qty` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_reserved_qty` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fba_unfulfillable_qty` INTEGER NOT NULL DEFAULT 0;
