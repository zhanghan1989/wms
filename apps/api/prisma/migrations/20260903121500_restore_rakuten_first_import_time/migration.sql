-- RMS re-syncs previously copied the latest sync time into csv_imported_at.
-- created_at is immutable and records when the row first entered WMS, including
-- CSV rows that were later claimed by the RMS API.
UPDATE `rakuten_order_records`
SET `csv_imported_at` = `created_at`
WHERE `source_kind` = 'rms_api'
  AND `csv_imported_at` <> `created_at`;
