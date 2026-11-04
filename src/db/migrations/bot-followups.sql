-- A promise the Homeroom bot made to tell one person when something about a
-- change happens (issue #6264): stored, so it survives the turn that made
-- it, and fired once by the change's own moment.
--
-- One row per ask. A second ask from the same person about the same change
-- replaces the first (`state = 'replaced'`) rather than stacking, which the
-- partial unique index below enforces. `event` is the one moment asked
-- about; `place_type`/`place_ref` (and the conversation/thread for a DM)
-- are where the line goes. `head_sha` is the change's head when asked, so
-- an "update" follow-up fires only on a newer one. `message_id` is the line
-- posted; a fired row with a null message is still owed one.
CREATE TABLE IF NOT EXISTS homeroom_bot_followups (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id      INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  issue_number    INTEGER,
  event           VARCHAR(8) NOT NULL CHECK (event IN ('update', 'checks', 'vote', 'merged', 'live')),
  place_type      VARCHAR(10) NOT NULL CHECK (place_type IN ('issue', 'session', 'chat', 'category', 'message', 'dm')),
  place_ref       BIGINT,
  conversation_id BIGINT,
  thread_root_id  BIGINT,
  head_sha        VARCHAR(40),
  state           VARCHAR(10) NOT NULL DEFAULT 'waiting'
                    CHECK (state IN ('waiting', 'fired', 'cancelled', 'replaced', 'expired')),
  message_id      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CONSTRAINT homeroom_bot_followups_target CHECK (session_id IS NOT NULL OR issue_number IS NOT NULL)
);

-- A person waits on one thing at most: a second ask replaces the first.
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_followups_waiting
  ON homeroom_bot_followups (user_id, app_id, COALESCE(session_id, 0), COALESCE(issue_number, 0))
  WHERE state = 'waiting';

-- The change's moments select its waiting rows.
CREATE INDEX IF NOT EXISTS homeroom_bot_followups_session
  ON homeroom_bot_followups (session_id, state) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS homeroom_bot_followups_issue
  ON homeroom_bot_followups (app_id, issue_number, state) WHERE state = 'waiting';
