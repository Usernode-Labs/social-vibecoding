-- Threads, stage 3 of #6225: a change for several requests gathers their
-- threads into its own, asking each other requester first (services/
-- thread-moves.js gather, consent). A move written for a change carries
-- `for_session_id`; it is asked once per change and request thread, whatever
-- its state, which this index keeps (a refused or applied one is never asked
-- again).
ALTER TABLE thread_moves ADD COLUMN IF NOT EXISTS for_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS thread_moves_for_change_idx
  ON thread_moves (thread_id, for_session_id) WHERE for_session_id IS NOT NULL;
