CREATE TABLE `manual_order_records` LIKE `amazon_order_records`;

INSERT INTO `manual_order_records`
SELECT *
FROM `amazon_order_records`
WHERE `source_file_path` = 'manual:amazon-order';

DELETE FROM `amazon_order_records`
WHERE `source_file_path` = 'manual:amazon-order';
