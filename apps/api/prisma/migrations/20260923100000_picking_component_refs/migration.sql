CREATE TABLE `picking_item_component_refs` (
  `item_id` BIGINT UNSIGNED NOT NULL,
  `component_product_id` VARCHAR(128) NOT NULL,
  PRIMARY KEY (`item_id`, `component_product_id`),
  INDEX `idx_picking_component_product_item` (`component_product_id`, `item_id`),
  CONSTRAINT `picking_item_component_refs_item_id_fkey` FOREIGN KEY (`item_id`)
    REFERENCES `overseas_picking_batch_items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `idx_picking_items_product_batch` ON `overseas_picking_batch_items` (`product_id`, `batch_id`);

INSERT IGNORE INTO `picking_item_component_refs` (`item_id`, `component_product_id`)
SELECT item.id, component.component_product_id
FROM `overseas_picking_batch_items` AS item
JOIN JSON_TABLE(
  item.bom_snapshot,
  '$[*]' COLUMNS (`component_product_id` VARCHAR(128) PATH '$.componentProductId')
) AS component
WHERE component.component_product_id IS NOT NULL AND component.component_product_id <> '';
