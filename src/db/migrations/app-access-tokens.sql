-- 25 Nov 2026: personal access tokens for an app.
--
-- A member's own assistant (an MCP client, a script) calls an app at the
-- app's own address with no browser and no Homeroom session. A private
-- app's door (services/edge-gate.js) let nothing like that through, and an
-- app could not check on such a call that its caller was still a member.
--
-- A token is made by a member from inside the app (routes/app-platform-api.js
-- POST /access-tokens), belongs to that member and that app, and is checked
-- at the door on every request: not revoked, and its owner still a member
-- who may see the app. Only its SHA-256 is kept; the token is shown once.
CREATE TABLE IF NOT EXISTS app_access_tokens (
  id           BIGSERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
COMMENT ON TABLE app_access_tokens IS 'staging:private';
CREATE INDEX IF NOT EXISTS app_access_tokens_owner_idx
  ON app_access_tokens (app_id, user_id) WHERE revoked_at IS NULL;
