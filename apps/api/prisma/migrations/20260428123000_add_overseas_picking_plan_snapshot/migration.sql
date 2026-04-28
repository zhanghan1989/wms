ALTER TABLE `overseas_picking_batch_items`
  ADD COLUMN `picking_plan_snapshot` JSON NULL AFTER `available_stock_snapshot`;
