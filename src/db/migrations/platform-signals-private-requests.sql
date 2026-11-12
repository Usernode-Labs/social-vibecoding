-- 12 Nov 2026: a private kind of platform signal (the dependency audit's
-- `security`, and `security_audit`) files a private request (#5048), which
-- only full admins see, instead of a request on the board
-- (services/platform-signals.js). When the bot can make the upgrade it gets
-- a request of its own on the board, which names only what to upgrade:
-- `issue_number` is that one, and it closing (the upgrade's merge) does not
-- close the row. Only the audit, or an admin closing the private request,
-- does.
--
-- `private_request_id` carries no foreign key on purpose: private_requests
-- is staging:private, and a staging copy empties every table holding a key
-- into a private one (db-manager.js privateDataExclusions), which would
-- empty this one too. Nothing deletes a private request; a number nothing
-- joins to reads as a request that is not closed.
--
-- `upgrade_closed_at` is when the sweep first saw the bot's request closed
-- while the row stayed open; `escalated_at` is when it then told the full
-- admins that the audit still finds the problem, which it does once.
ALTER TABLE platform_signals
  ADD COLUMN IF NOT EXISTS private_request_id INTEGER,
  ADD COLUMN IF NOT EXISTS upgrade_closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
