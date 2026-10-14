-- Release only obsolete pre-send holds for fixed new-order acknowledgements.
-- Sent, uncertain and explicitly cancelled messages remain untouched.
UPDATE `rakuten_order_mails`
SET `failure_category` = NULL, `last_error` = NULL, `next_attempt_at` = NULL,
    `resolution_note` = CASE WHEN `resolution_note` = '导入邮件需人工确认' THEN NULL ELSE `resolution_note` END
WHERE `event` = 'new_order'
  AND `status` IN ('pending', 'failed')
  AND `send_started_at` IS NULL
  AND (`failure_category` IN ('import_review', 'manual_review') OR `resolution_note` = '导入邮件需人工确认');
