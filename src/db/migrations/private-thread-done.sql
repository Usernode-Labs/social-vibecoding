-- #6159 (3 Nov 2026): a private thread with Homeroom bot can be finished.
--
-- `done` is a state beside open, filed, posted and dropped. A thread is done
-- on its own when the request it was filed as, posted on or is about goes
-- live or is closed (services/private-threads.js finishForRequest), by Mark
-- done in its ⋯, or by asking the bot (its close_thread tool). A done thread
-- leaves the Homeroom bot page's lists; its messages stay, and a link to it
-- still opens it. Writing in it again, or Reopen, puts it back where it was
-- before (`done_from`), so open, filed and posted all survive the round trip.
ALTER TABLE private_threads DROP CONSTRAINT IF EXISTS private_threads_state_check;
ALTER TABLE private_threads ADD CONSTRAINT private_threads_state_check
  CHECK (state IN ('open', 'filed', 'posted', 'dropped', 'done'));
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS done_from VARCHAR(8);
ALTER TABLE private_threads DROP CONSTRAINT IF EXISTS private_threads_done_from_check;
ALTER TABLE private_threads ADD CONSTRAINT private_threads_done_from_check
  CHECK (done_from IS NULL OR done_from IN ('open', 'filed', 'posted'));
