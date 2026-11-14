-- #6650: Home's "New in your communities" card says what happened in a
-- person's communities since they last looked (services/home-for-you.js).
-- "Last looked" is this one timestamp per account: the moment they pressed
-- "Mark all read" on that card. Without a row the card reads the last seven
-- days. A project's chat keeps its own read marker (app_chat_reads); this
-- one never moves it, and that one never moves this.
--
-- staging:private: when somebody last looked at their Home is about them.
CREATE TABLE IF NOT EXISTS home_activity_seen (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE home_activity_seen IS 'staging:private';
