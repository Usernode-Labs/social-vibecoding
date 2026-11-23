-- 23 Nov 2026 (#6994): a website archive uploaded from the Create screen,
-- kept until the project it makes has read it.
--
-- POST /api/apps/archive checks the file, stores its original bytes here and
-- answers an id; the create form sends that id to POST /api/apps, which links
-- the row to the new project. The project's setup re-reads the same bytes to
-- write its first commit (services/archive-import.js), so a retry reads the
-- same archive.
--
-- A row with no app_id is an upload whose project was never made: the
-- upload-gc clock deletes it after a day (services/upload-retention.js).
CREATE TABLE app_archive_uploads (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  data        BYTEA NOT NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_archive_uploads_app_idx ON app_archive_uploads (app_id)
  WHERE app_id IS NOT NULL;

-- What a person uploaded, kept only until their project has been made.
COMMENT ON TABLE app_archive_uploads IS 'staging:private';
