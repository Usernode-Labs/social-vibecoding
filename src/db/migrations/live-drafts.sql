-- Live app drafts (services/live-drafts.js). In a private thread of their
-- chat with Homeroom bot about a project, a person opens a draft: a change
-- of their own (chat_sessions row, its branch off main) whose preview runs
-- the app under a supervisor (services/live-draft-supervisor.js), so the
-- bot's edits in that thread are written into the running preview and the
-- app restarts in place. Each edit that runs is a commit on the draft's
-- branch. Propose puts the draft up for a vote like any other change.
--
-- `state`: open while it is edited; proposed once it went up for a vote;
-- closed when they put it away. One open draft per thread.
CREATE TABLE IF NOT EXISTS live_drafts (
  id                SERIAL PRIMARY KEY,
  app_id            INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  private_thread_id BIGINT REFERENCES private_threads(id) ON DELETE SET NULL,
  root_message_id   INTEGER NOT NULL,
  session_id        INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  state             VARCHAR(16) NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'proposed', 'closed')),
  base_sha          VARCHAR(40),
  head_sha          VARCHAR(40),
  edits             INTEGER NOT NULL DEFAULT 0,
  -- What the preview is doing for the draft: starting (its first build),
  -- live (edits restart it in place), rebuilding (an edit changed what the
  -- app installs, so its image is built again), failed (it did not start).
  live_state        VARCHAR(16) NOT NULL DEFAULT 'starting'
                    CHECK (live_state IN ('starting', 'live', 'rebuilding', 'failed')),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS live_drafts_open_thread_idx
  ON live_drafts (user_id, root_message_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS live_drafts_session_idx ON live_drafts (session_id);
COMMENT ON TABLE live_drafts IS 'staging:private';

-- One row per edit that ran in the draft's preview: its commit and the
-- bot's one-line summary of it, for the draft's history and its proposal.
CREATE TABLE IF NOT EXISTS live_draft_edits (
  id          SERIAL PRIMARY KEY,
  draft_id    INTEGER NOT NULL REFERENCES live_drafts(id) ON DELETE CASCADE,
  commit_sha  VARCHAR(40) NOT NULL,
  summary     TEXT NOT NULL,
  paths       TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS live_draft_edits_draft_idx ON live_draft_edits (draft_id, id);
COMMENT ON TABLE live_draft_edits IS 'staging:private';
