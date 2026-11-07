-- Leave me out (Settings › Privacy), in place of "Share usage analytics"
-- (#5593, 20 Oct 2026).
--
-- Screen usage data (the shell's UI telemetry, the made screen's moments,
-- App-tab openings and Live views: services/usage-analytics.js lists them)
-- is recorded for every account again, as it was before #5593, unless the
-- person leaves themselves out. `usage_left_out_at` is when they did; NULL is
-- recorded. Leaving out erases what was recorded and stops Google Analytics
-- counting them; Journey still counts them in totals but names them nowhere.
--
-- users.usage_analytics, #5593's opt-in, is no longer read. It stays so a
-- server still on the old code during the rollout reads a column that exists.

ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_left_out_at TIMESTAMPTZ;

-- The few accounts that left themselves out, for Journey's masking.
CREATE INDEX IF NOT EXISTS users_usage_left_out_idx
  ON users (id) WHERE usage_left_out_at IS NOT NULL;
