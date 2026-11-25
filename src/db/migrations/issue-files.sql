-- 25 Nov 2026 (#7136): a file a person attached for Homeroom bot, carried
-- onto the request it was drafted into, so that request's build can save it.
--
-- Pictures already reach a build: a picture kept for a request is an
-- issue_screenshots row, served to the build on its own token. Anything
-- else a chat accepts (a zip of a site, a spreadsheet, a document) had no
-- way onto a request at all. It gets its own record here, apart from the
-- request's screenshots: its name, kind and size are what the request
-- lists, and its bytes are what the build saves.
--
-- issue_owner/repo/number are stamped when the issue is filed, as
-- issue_screenshots' are; rows never linked (the draft was not filed, or
-- the file was dropped before filing) are swept by the server's orphan
-- sweeper after a day.
CREATE TABLE IF NOT EXISTS issue_files (
  id            VARCHAR(32) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      VARCHAR(256) NOT NULL,
  kind          VARCHAR(16) NOT NULL,
  content_type  VARCHAR(128) NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  -- A zip's central-directory manifest (attachments.validateZip), null
  -- otherwise: what the build reads before it unpacks anything.
  meta          JSONB,
  data          BYTEA NOT NULL,
  issue_owner   TEXT,
  issue_repo    TEXT,
  issue_number  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_issue_files_request
  ON issue_files(issue_owner, issue_repo, issue_number);
CREATE INDEX IF NOT EXISTS idx_issue_files_orphan
  ON issue_files(created_at) WHERE issue_number IS NULL;
-- Private: the bytea can contain anything a person chose to attach;
-- staging gets the schema only.
COMMENT ON TABLE issue_files IS 'staging:private';
