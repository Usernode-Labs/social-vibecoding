-- #6071: design threads. A private thread in a person's chat with Homeroom
-- bot holding a captured screen (a Homeroom page, or an app on its App tab)
-- as self-contained HTML, which the bot edits at their word, one version at
-- a time. Nothing in it is public until they tap Propose it, which files a
-- request on the screen's project with the before and after screens as its
-- plan (services/design-threads.js).

ALTER TABLE private_threads DROP CONSTRAINT IF EXISTS private_threads_kind_check;
ALTER TABLE private_threads ADD CONSTRAINT private_threads_kind_check
  CHECK (kind IN ('draft_request', 'draft_reply', 'idea', 'ask', 'design'));

-- What a design thread is of: the screen it was captured from and the size
-- it was drawn at, which every version is drawn at too.
CREATE TABLE IF NOT EXISTS design_threads (
  private_thread_id BIGINT PRIMARY KEY REFERENCES private_threads(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  surface           VARCHAR(8) NOT NULL CHECK (surface IN ('platform', 'app')),
  route             TEXT CHECK (route IS NULL OR char_length(route) <= 500),
  width             INTEGER NOT NULL CHECK (width BETWEEN 200 AND 4000),
  height            INTEGER NOT NULL CHECK (height BETWEEN 200 AND 4000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE design_threads IS 'staging:private';

-- Each version of the screen: the capture is 1, every edit of the bot's the
-- next. `message_id` is the thread's message that says it.
CREATE TABLE IF NOT EXISTS design_versions (
  id                BIGSERIAL PRIMARY KEY,
  private_thread_id BIGINT NOT NULL REFERENCES private_threads(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL CHECK (version > 0),
  html              TEXT NOT NULL CHECK (octet_length(html) <= 1048576),
  author            VARCHAR(8) NOT NULL CHECK (author IN ('capture', 'bot')),
  note              TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  message_id        INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (private_thread_id, version)
);
COMMENT ON TABLE design_versions IS 'staging:private';
