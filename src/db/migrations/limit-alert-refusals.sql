-- Text alerts for people turned away at the app limit (services/limit-texts.js,
-- with #6901's count from platform_limit_refusals): the first refusal of a run
-- is texted at once, then the count at most every three hours. What each
-- number was last told about a run is kept beside its mark, and a refusal
-- text counts as the limit's six-hourly reminder rather than doubling it.

ALTER TABLE limit_alert_marks ADD COLUMN IF NOT EXISTS refusals_texted_at TIMESTAMPTZ;
ALTER TABLE limit_alert_marks ADD COLUMN IF NOT EXISTS refusals_texted INTEGER NOT NULL DEFAULT 0;

ALTER TABLE limit_alert_sends DROP CONSTRAINT IF EXISTS limit_alert_sends_what_check;
ALTER TABLE limit_alert_sends ADD CONSTRAINT limit_alert_sends_what_check
  CHECK (what IN ('verify', 'test', 'crossing', 'reminder', 'unknown', 'turned_away'));
