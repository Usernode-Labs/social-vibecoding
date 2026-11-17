-- #6784: a project made from an idea thread with Homeroom bot remembers the
-- thread its plan was agreed in. Only new data: existing rows stay null, and
-- the unique index stops two racing creates from linking the same thread.
ALTER TABLE homeroom_bot_first_versions
  ADD COLUMN IF NOT EXISTS idea_thread_id BIGINT REFERENCES private_threads(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_first_versions_idea_thread_idx
  ON homeroom_bot_first_versions (idea_thread_id)
  WHERE idea_thread_id IS NOT NULL;
