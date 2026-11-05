-- #6081: text people post gets translated into the reader's language, when
-- they ask for it (services/user-content-translations.js).
--
-- One row per text and target language. `source_digest` is the sha256 of the
-- exact source text (a request's title or words, a message's content), so an
-- edited text is a new row and the old translation is never shown against it.
-- No source text is stored, only its digest.
--
-- `text` NULL with `same_language` true means the model found the text
-- already in the target language. `text` NULL with a `problem` means the
-- answer was refused by the checks; it may be asked for again after 24
-- hours. A row with text is never overwritten.
CREATE TABLE IF NOT EXISTS user_content_translations (
  source_digest   TEXT NOT NULL,
  language        VARCHAR(35) NOT NULL,
  text            TEXT,
  source_language VARCHAR(35),
  same_language   BOOLEAN NOT NULL DEFAULT FALSE,
  problem         TEXT,
  model           TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_digest, language)
);

-- How many new translations one person asked for, in one UTC day. Cache hits
-- cost nothing and are not counted.
CREATE TABLE IF NOT EXISTS user_content_translation_asks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
