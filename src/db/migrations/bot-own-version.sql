-- #6389: Homeroom bot's own version of a person's change.
--
-- A change made outside Homeroom (external_agent set) cannot be edited by the
-- bot. When its author asks, the bot starts a change of its own from that
-- change's branch. `rebuilt_from_session_id` links the bot's change to the
-- one it was built from, so the request's page draws them as one choice, and
-- the original closes when the bot's version goes live.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS rebuilt_from_session_id INTEGER
  REFERENCES chat_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS chat_sessions_rebuilt_from_idx
  ON chat_sessions (rebuilt_from_session_id)
  WHERE rebuilt_from_session_id IS NOT NULL;

-- One unused ask per request: asking twice starts one build, not two. The
-- look that takes the ask marks it used; a request whose ask was never taken
-- may be asked again.
CREATE TABLE IF NOT EXISTS bot_version_asks (
  id serial PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  from_session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  asked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_version_asks_unused_idx
  ON bot_version_asks (app_id, issue_number)
  WHERE used_at IS NULL;
