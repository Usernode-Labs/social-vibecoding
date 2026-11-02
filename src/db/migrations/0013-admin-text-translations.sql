-- #6152: text an admin writes in the console and a phone shows, translated.
-- See src/services/admin-text-translations.js.
--
-- One row per message and language. `source_digest` is the digest of the
-- English it was made from, so changing the English retires it. `text` is NULL
-- when the last attempt was refused (`problem` says why, `attempted_at` says
-- when to try again). `reviewed` means a person wrote or approved it.
--
-- Not private: these are the words every phone is shown.
CREATE TABLE IF NOT EXISTS admin_text_translations (
  source_key    TEXT NOT NULL,
  language      VARCHAR(16) NOT NULL,
  source_digest TEXT NOT NULL,
  text          TEXT,
  reviewed      BOOLEAN NOT NULL DEFAULT FALSE,
  problem       TEXT,
  model         TEXT,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_key, language)
);
