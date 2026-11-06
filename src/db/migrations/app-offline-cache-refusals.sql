-- Offline apps (services/offline-cache.js): an app whose page never says it
-- opened at the cacheable address, learned once per build instead of once
-- per device.
--
-- The shell frames a public app at one address with the token after `#`, and
-- the bridge moves it into the query and tells the shell it opened. A page
-- that loads no bridge never says so: the device then frames it the old,
-- tokened way for a week (app-view.js _offlineCacheDidNotOpen), so every
-- device opened it signed out once a week before reloading. Now the shell
-- also reports it, and once two different people have reported the same
-- build, the app keeps the tokened address on every device until it deploys
-- again (services/offline-cache-refusals.js).
--
--   app_offline_cache_refusals  one row per (app, build, person) that saw
--                               the page not open. Only the current build's
--                               rows are kept. staging:private: which
--                               people opened which app.
--   apps.offline_cache_off_sha  the build that reached the threshold. The
--                               cacheable address is skipped while it equals
--                               apps.main_sha, so the next deploy clears it.
CREATE TABLE IF NOT EXISTS app_offline_cache_refusals (
  app_id   INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  main_sha TEXT NOT NULL,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, main_sha, user_id)
);
COMMENT ON TABLE app_offline_cache_refusals IS 'staging:private';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS offline_cache_off_sha TEXT;
