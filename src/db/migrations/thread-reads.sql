-- #6262: where each person's reading of a request, change or decision thread
-- stands. A request's page (and a change's, and a decision's) is one
-- `threads` row; `chat_messages.thread_id` names the messages in it. This is
-- the watermark that lets the Homeroom bot page say which threads have
-- something new: every message above `last_read_id`, from somebody else, not
-- deleted and not from someone the reader blocked, is unread
-- (services/thread-reads.js). A missing row is created at the thread's newest
-- message the first time the lists are read for a person, so every thread
-- starts at zero. staging:private for the reason app_chat_reads and
-- app_category_chat_reads are: personal reading history.
CREATE TABLE IF NOT EXISTS thread_reads (
  thread_id    BIGINT  NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_reads_user ON thread_reads (user_id);
COMMENT ON TABLE thread_reads IS 'staging:private';
