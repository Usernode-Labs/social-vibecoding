-- Reminders for people let in from the waitlist who have not signed in
-- (services/waitlist-reminders.js): a first one at least 2 days after the
-- admit, the last one at least 6 days after it and 4 after the first, and
-- never a third. Each is stamped on the row as it is claimed, by a
-- compare-and-set on its own column (`... WHERE reminder_1_sent_at IS NULL`),
-- so two processes can never both send the same one to the same row.
-- `reminders_stopped_at` is the row's "Stop these reminders" link
-- (GET/POST /mail/reminders/stop), keyed to the row because most of these
-- people have no account. Times only, like release_mail_sent_at beside them,
-- and no capability: not column-private.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS reminder_1_sent_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS reminder_2_sent_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS reminders_stopped_at TIMESTAMPTZ;

-- Which copy of a stored email template a send used (services/mail/index.js
-- send), so batches can be compared later: the template row's version, and a
-- short digest of the English words and layout it was rendered from. The
-- digest is there because a row nobody edited (version 1, by nobody) is
-- refreshed from the seeds in place (db/email-template-seeds.js
-- refreshUntouched), which keeps its version while its words change. NULL on
-- a row nothing was rendered for (no transport, throttled, suppressed) and on
-- every row from before this migration. Covered by the table-level
-- staging:private comment.
ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS template_version INTEGER;
ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS template_digest TEXT;
