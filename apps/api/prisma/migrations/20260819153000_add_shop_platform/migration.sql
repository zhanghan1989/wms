-- AlterTable
ALTER TABLE `shops`
  ADD COLUMN `platform` ENUM('amazon', 'rakuten') NOT NULL DEFAULT 'amazon' AFTER `name`;

-- Existing Rakuten RMS shops belong to the Rakuten tab. The explicit names
-- preserve the requested classification even if a connection is temporarily absent.
UPDATE `shops`
SET `platform` = 'rakuten'
WHERE `name` IN ('乐天-1号店', '乐天-2号店')
   OR `id` IN (SELECT `shop_id` FROM `rakuten_rms_connections`);
