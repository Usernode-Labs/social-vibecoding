-- Each time somebody is turned away at the server-wide app limit
-- (services/platform-limit-alerts.js recordRefusal, called from the two 429
-- branches in routes/apps.js).
--
-- A refusal used to be silent. The level only notifies when it RISES, and a
-- cap raised while the count stayed above the re-arm line (REARM_RATIO) kept
-- the stored level at "full", so when it filled again nobody heard: the
-- server was full from 13 Nov 17:29 UTC until 20 Nov and only a person
-- asking in the chat told the admins (#6901).
--
-- One row per account per UTC day, so retries and a person trying again do
-- not inflate the count. `refused_at` is their first refusal that day.
CREATE TABLE IF NOT EXISTS platform_limit_refusals (
  limit_key  VARCHAR(32) NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  refused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (limit_key, user_id, day)
);
CREATE INDEX IF NOT EXISTS platform_limit_refusals_at
  ON platform_limit_refusals (limit_key, refused_at);

-- The run of refusals being reported: `refusals_since` starts on the first
-- refusal while the server is full, and evaluate('apps') clears it whenever
-- the server has room again (used < cap), so raising the cap ends the run
-- even if the level stays "full". `refusals_notified_at` is when the last
-- refusal notice went out; rows with refused_at > it are the people not yet
-- reported.
ALTER TABLE platform_limit_alerts ADD COLUMN IF NOT EXISTS refusals_since TIMESTAMPTZ;
ALTER TABLE platform_limit_alerts ADD COLUMN IF NOT EXISTS refusals_notified_at TIMESTAMPTZ;
