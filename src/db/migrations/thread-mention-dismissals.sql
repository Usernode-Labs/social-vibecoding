-- 24 Nov 2026 (mobile 04, Evan): when somebody names a person with @ in a
-- thread (a request's, a change's or a decision's), the Homeroom bot tab's
-- Needs you lists that thread, with Reply and Dismiss, until they write in it
-- after the @, dismiss it, or the thread finishes (services/thread-mentions.js
-- NAMED_SQL). This is Dismiss: one row per person and thread, when they last
-- pressed it. An @ before that moment is dismissed; a new @ after it starts
-- the row again, so the row is kept rather than deleted.
--
-- It is neither the bell's read mark (notifications.read_at) nor the
-- thread's read cursor (thread_reads): reading the notification, or opening
-- the thread, ends nothing. staging:private for the reason thread_reads is:
-- personal reading history.
CREATE TABLE IF NOT EXISTS thread_mention_dismissals (
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    BIGINT      NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, thread_id)
);
COMMENT ON TABLE thread_mention_dismissals IS 'staging:private';
