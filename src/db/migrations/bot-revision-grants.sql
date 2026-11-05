-- #6284: the Homeroom bot's limit of three fixes counts only fixes it made
-- on its own. An update a person asked for (a thread ask, Main Chat's
-- revise, a No vote's reason) is recorded as asked, has its own, higher
-- limit, and never uses up one of the bot's own rounds.
--
-- When the bot stops at its own limit, the requester, an admin or anybody
-- who voted on the change may let it try once more. One open grant buys
-- exactly one round: its round is recorded as asked, and the grant is
-- marked used.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS asked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS asked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Why a run stopped: 'own_revisions' on the hand-off the bot's own limit
-- caused. No CHECK constraint, like budget_stop.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS limit_stop TEXT;

-- Updates people asked for before this change were reply revisions, which
-- record no checks_head_sha; a fix round records the head it looked at. So
-- they stop counting now, and PR #6254 gets its two rounds back.
UPDATE homeroom_bot_runs
   SET asked = TRUE
 WHERE verdict = 'revise'
   AND proposal_session_id IS NOT NULL
   AND checks_head_sha IS NULL
   AND asked = FALSE;

CREATE TABLE IF NOT EXISTS homeroom_bot_revision_grants (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  head_sha    VARCHAR(40),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ,
  run_id      BIGINT
);

-- One open grant per change: pressing Let it try again while a round waits
-- or runs does nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_revision_grants_open
  ON homeroom_bot_revision_grants (session_id)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS homeroom_bot_revision_grants_session
  ON homeroom_bot_revision_grants (session_id, created_at DESC);

COMMENT ON TABLE homeroom_bot_revision_grants IS 'staging:private';
