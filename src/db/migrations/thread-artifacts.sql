-- 20 Nov 2026 (live-draft review, K): a thread can hold several artifacts
-- (docs/plans/artifacts.md, "Several artifacts in a thread").
--
-- One artifact per thread was built into the store: design_threads is keyed
-- by its thread (private_thread_id is its primary key) and design_versions
-- is unique on (private_thread_id, version). A release runs the build from
-- before beside this one for some minutes, and every open proposal's
-- preview boots its own, possibly older, code on a copy of production's
-- database. So this only ADDS, and nothing a build from before reads
-- changes meaning:
--
--   - A thread's FIRST artifact stays where it always was, in design_threads
--     and design_versions, numbered 1. Nothing is copied or moved, so a
--     build from before reads and writes every thread's first artifact
--     exactly as it did, and its version numbers stay the ones both builds
--     take under the same row lock (artifacts.js addVersion).
--   - Each LATER artifact (2, 3, ... up to the store's cap of 12) is a row of
--     thread_artifacts, numbered within its thread, with its versions in
--     thread_artifact_versions, numbered 1, 2, ... per artifact. A build from
--     before never names these tables, so to it a thread still holds one
--     artifact: its first.
--   - A plan and a project's first version that came from a design name
--     which artifact of its thread (design_artifact_id) beside the thread
--     and version they already store. Null, as on every row from before,
--     means the thread's first artifact.
--
-- To undo: run the build from before. It ignores both tables and both
-- columns; every first artifact is whole. Later artifacts stay stored, unseen,
-- until a later migration drops them (nothing here needs dropping first).

-- A thread's artifacts after its first. `number` is the artifact's id as
-- people and the bot use it (1 is design_threads' row); the columns are
-- design_threads' own, so a later artifact is read the same way.
CREATE TABLE IF NOT EXISTS thread_artifacts (
  id                BIGSERIAL PRIMARY KEY,
  private_thread_id BIGINT NOT NULL REFERENCES private_threads(id) ON DELETE CASCADE,
  number            INTEGER NOT NULL CHECK (number >= 2),
  kind              VARCHAR(16) NOT NULL DEFAULT 'page' CHECK (kind IN ('design', 'page')),
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  surface           VARCHAR(8) NOT NULL CHECK (surface IN ('platform', 'app', 'new')),
  route             TEXT CHECK (route IS NULL OR char_length(route) <= 500),
  width             INTEGER NOT NULL CHECK (width BETWEEN 200 AND 4000),
  height            INTEGER NOT NULL CHECK (height BETWEEN 200 AND 4000),
  viewport          VARCHAR(8) CHECK (viewport IS NULL OR viewport IN ('phone', 'desktop')),
  place             VARCHAR(16) NOT NULL DEFAULT 'thread' CHECK (place IN ('thread')),
  -- The pictures a person added to a design (bot-pictures.js addToDesign),
  -- as design_threads.pictures holds the first artifact's.
  pictures          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (private_thread_id, number)
);
COMMENT ON TABLE thread_artifacts IS 'staging:private';

-- Their versions, whole each time, as design_versions holds the first's.
CREATE TABLE IF NOT EXISTS thread_artifact_versions (
  id                BIGSERIAL PRIMARY KEY,
  artifact_id       BIGINT NOT NULL REFERENCES thread_artifacts(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL CHECK (version > 0),
  html              TEXT NOT NULL CHECK (octet_length(html) <= 1048576),
  author            VARCHAR(8) NOT NULL CHECK (author IN ('capture', 'bot')),
  note              TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  message_id        INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_id, version)
);
COMMENT ON TABLE thread_artifact_versions IS 'staging:private';

-- Which artifact of its thread a plan, or a project's first version, came
-- from. Nullable with no default, so a build from before (which names
-- neither in its INSERT or UPDATE) keeps working; null is the first.
ALTER TABLE chat_session_specs ADD COLUMN IF NOT EXISTS design_artifact_id INTEGER;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS design_artifact_id INTEGER;
