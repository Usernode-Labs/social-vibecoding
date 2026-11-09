-- Threads, one loop (phase B): a private thread can be about a request or a
-- change. "Work on this with Homeroom bot" on a request's page, or on a
-- change's, opens a thread in the person's chat with the bot about it
-- (services/private-threads.js startAbout), and the bot reads what it is
-- about. `threads` is public and `private_threads` private: the private row
-- points at the public thread, never the other way round.

ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS about_thread_id BIGINT REFERENCES threads(id) ON DELETE SET NULL;
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS about_kind VARCHAR(8);
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS about_number INTEGER;
ALTER TABLE private_threads DROP CONSTRAINT IF EXISTS private_threads_about_check;
ALTER TABLE private_threads ADD CONSTRAINT private_threads_about_check
  CHECK ((about_kind IS NULL AND about_number IS NULL)
      OR (about_kind IN ('request', 'change') AND about_number > 0));

-- The hold: while the person who asked for a request works on it in such a
-- thread, the bot waits for their plan before it reads or builds it
-- (rules/bot-loop.ts planHoldSql). `holds_bot` is set when the thread is
-- opened by the request's own requester; the hold lifts when a plan is
-- posted on the request ('plan'), when they tap Let the bot build it now
-- ('go'), or by itself once the thread has been quiet for 7 days.
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS holds_bot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS hold_lifted_at TIMESTAMPTZ;
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS hold_lifted_by VARCHAR(8);
ALTER TABLE private_threads DROP CONSTRAINT IF EXISTS private_threads_hold_lifted_by_check;
ALTER TABLE private_threads ADD CONSTRAINT private_threads_hold_lifted_by_check
  CHECK (hold_lifted_by IS NULL OR hold_lifted_by IN ('plan', 'go'));

-- The threads about one request or change, which the lane reads for a hold.
CREATE INDEX IF NOT EXISTS private_threads_about_idx
  ON private_threads (app_id, about_kind, about_number) WHERE about_kind IS NOT NULL;
