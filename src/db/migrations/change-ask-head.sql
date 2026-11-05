-- #6348 (5 Nov 2026): the version a change's update was asked against.
--
-- An ask holds the vote only while the change is still on the head it was
-- made against (services/homeroom-bot-progress.js updateComingSql): once a
-- newer commit lands, the ask no longer says an update is coming, however
-- long its record outlives the update. asked_head_sha is that head at the
-- moment the ask was queued: the change's reviewed_head_sha, or an imported
-- change's imported_pr_head_sha. NULL for asks made before this column
-- existed, which keep the time windows alone.
ALTER TABLE homeroom_bot_change_asks ADD COLUMN IF NOT EXISTS asked_head_sha VARCHAR(40);
