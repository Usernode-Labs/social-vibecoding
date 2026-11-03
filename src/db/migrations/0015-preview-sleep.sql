-- #6157 (2 Nov 2026): a preview can sleep, a third state between running and
-- torn down.
--
-- A preview nobody has used for a while (services/staging-reap.js
-- sweepSleep, PREVIEW_SLEEP_AFTER_MS, two hours by default) is scaled to no
-- replicas: its image, its Deployment, Service and Ingress, its database
-- clone and the session's records stay as they are, so opening it again
-- (Preview, a direct link, a checks run) only scales it back up
-- (services/preview-sleep.js wake). This records the state, so status reads
-- and the admin console can say "Asleep", and what the sleeping clone
-- weighs, so the console can total the storage sleeping previews still hold.
--
-- Both columns are cleared whenever another attempt serves, or the preview
-- is retired (the preview machine's `published` and `unpublished` writes).

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS staging_asleep_at TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS staging_asleep_db_bytes BIGINT;

-- The asleep previews, for the console's totals and the sleep pass.
CREATE INDEX IF NOT EXISTS chat_sessions_staging_asleep_idx
  ON chat_sessions (staging_asleep_at) WHERE staging_asleep_at IS NOT NULL;
