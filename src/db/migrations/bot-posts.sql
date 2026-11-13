-- Homeroom bot, one model, step 4 (11 Nov 2026): one posting function,
-- append-only (docs/plans/bot-one-model.md; src/services/bot-post.js).
--
-- Every word the bot says to people is one post, keyed by what it is:
-- `kind:subject:version` (a build's failure on request 12 of project 3 in
-- run 40 is `build_failed:request:3-12:run-40`). The key is claimed before
-- anything is sent, so a post asked for twice (a retry, a restart, two
-- passes at once) is said once: the second ask finds the row and says
-- nothing (`asked` counts the asks). A post a restart caught going out is
-- `pending`, and the retry says only the parts its row has not recorded
-- (its thread message, its GitHub comment).
--
-- `outcome`: `said` (it is a message in its place), `refused` (the place's
-- rules do not have the bot say that there: recorded, never a message),
-- `repeat` (a failure note whose words are the place's last failure note's,
-- with nobody writing since: the status card already shows it, so nothing
-- is said) and `pending`. homeroom_bot_posts stays as the per-request
-- projection its readers use, written once the post is said
-- (`request_post_id`).
CREATE TABLE IF NOT EXISTS bot_posts (
  id                       BIGSERIAL PRIMARY KEY,
  said_key                 TEXT NOT NULL,
  kind                     TEXT NOT NULL,
  subject                  TEXT NOT NULL,
  version                  TEXT NOT NULL DEFAULT '',
  place_type               TEXT NOT NULL,
  app_id                   INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  place_ref                BIGINT,
  issue_number             INTEGER,
  session_id               INTEGER,
  run_id                   INTEGER,
  chat_message_id          INTEGER,
  conversation_message_id  INTEGER,
  github_comment_id        BIGINT,
  github_created_at        TIMESTAMPTZ,
  request_post_id          INTEGER,
  words_digest             TEXT,
  outcome                  TEXT NOT NULL DEFAULT 'pending',
  why                      TEXT,
  asked                    INTEGER NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  said_at                  TIMESTAMPTZ,
  CONSTRAINT bot_posts_outcome_check CHECK (outcome IN ('pending', 'said', 'repeat', 'refused'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_posts_said_key ON bot_posts(said_key);
-- The place's last failure note (bot-post.js lastFailure).
CREATE INDEX IF NOT EXISTS idx_bot_posts_place
  ON bot_posts(app_id, place_type, place_ref, id DESC) WHERE outcome = 'said';
-- A request's posts, for the admin's count of notes said twice (duplicateNotes).
CREATE INDEX IF NOT EXISTS idx_bot_posts_request
  ON bot_posts(app_id, issue_number, created_at) WHERE issue_number IS NOT NULL;

-- The posts a run said before this, by the keys they would have now, so a
-- durable build a restart sends back across the release says nothing twice
-- (homeroom-bot.js asked homeroom_bot_posts by run and kind before). A post
-- still going out (pending) is taken up as one. The last 30 days are
-- enough: older runs are not retried.
INSERT INTO bot_posts (said_key, kind, subject, version, place_type, app_id, place_ref, issue_number, run_id,
                       chat_message_id, github_comment_id, request_post_id, outcome, created_at, said_at)
SELECT p.kind || ':request:' || p.app_id || '-' || p.issue_number || ':run-' || p.run_id,
       p.kind, 'request:' || p.app_id || '-' || p.issue_number, 'run-' || p.run_id, 'issue',
       p.app_id, p.issue_number, p.issue_number, p.run_id,
       p.thread_message_id, p.github_comment_id, p.id,
       CASE WHEN p.pending IS TRUE THEN 'pending' ELSE 'said' END, p.created_at,
       CASE WHEN p.pending IS TRUE THEN NULL ELSE p.created_at END
  FROM homeroom_bot_posts p
 WHERE p.run_id IS NOT NULL AND p.created_at > NOW() - INTERVAL '30 days'
ON CONFLICT (said_key) DO NOTHING;

-- "Looking at this now" is said once per request, ever: its key is the
-- request's.
INSERT INTO bot_posts (said_key, kind, subject, version, place_type, app_id, place_ref, issue_number,
                       github_comment_id, request_post_id, outcome, created_at, said_at)
SELECT 'looking:request:' || p.app_id || '-' || p.issue_number || ':once',
       'looking', 'request:' || p.app_id || '-' || p.issue_number, 'once', 'issue',
       p.app_id, p.issue_number, p.issue_number, p.github_comment_id, p.id, 'refused', p.created_at, p.created_at
  FROM homeroom_bot_posts p
 WHERE p.kind = 'looking'
ON CONFLICT (said_key) DO NOTHING;
