-- #6233 (4 Nov 2026): a merge of Homeroom itself is Live only once the whole
-- rollout finished, not when the first new server served it.
--
-- `platform_first_served_at` is when a serving process first ran the build
-- that carries the merge. It is kept for the record (the infra topic's
-- Merge -> live figure), and it no longer means Live: a release replaces its
-- servers one at a time, so a build's first boot is not production carrying
-- it everywhere.
--
-- `live_at` (chat_sessions) is the time the rollout finished: every serving
-- process runs a build containing the merge. `live_rolled_back_at` says a
-- later complete rollout served a build that does not contain it, so the
-- change went back to Going live (services/release-watch.js settleRollback).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_first_served_at TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS live_rolled_back_at TIMESTAMPTZ;
