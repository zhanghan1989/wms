-- Rename the existing company in place so all company_id relationships remain intact.
-- The unique name constraint stops this migration if another QLSZ company exists.
UPDATE `companies`
SET `name` = 'QLSZ', `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `name` = '祈麟双子';
