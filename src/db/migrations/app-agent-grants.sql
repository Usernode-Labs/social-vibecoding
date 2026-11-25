-- 25 Nov 2026: browser approval for an app's agent path.
--
-- A personal access token (app_access_tokens) is copied by hand from the
-- app into an assistant. This is the other way in: the assistant is given
-- only the app's declared address, is told by the door where to ask, and the
-- member approves it on Homeroom in their browser (routes/mcp-remote.js,
-- services/app-agent-oauth.js). What it gets is a short-lived access token
-- and a refresh token, both for that one app and that one member.
--
-- A grant is one approval. Its tokens die with it, and the door checks on
-- every request that its owner is still a member who may see the app. Only
-- SHA-256 digests are kept.
CREATE TABLE IF NOT EXISTS app_agent_grants (
  id              BIGSERIAL PRIMARY KEY,
  grant_id        TEXT NOT NULL UNIQUE CHECK (grant_id ~ '^[A-Za-z0-9_-]{22}$'),
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,
  client_name     TEXT NOT NULL,
  redirect_origin TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
COMMENT ON TABLE app_agent_grants IS 'staging:private';
CREATE INDEX IF NOT EXISTS app_agent_grants_owner_idx
  ON app_agent_grants (app_id, user_id) WHERE revoked_at IS NULL;

-- One-use authorization codes, a minute long, bound to the client, its
-- redirect address, its PKCE challenge and the app address it asked for.
CREATE TABLE IF NOT EXISTS app_agent_codes (
  id             BIGSERIAL PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  grant_id       TEXT NOT NULL CHECK (grant_id ~ '^[A-Za-z0-9_-]{22}$'),
  app_id         INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ
);
COMMENT ON TABLE app_agent_codes IS 'staging:private';

CREATE TABLE IF NOT EXISTS app_agent_tokens (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id     TEXT NOT NULL REFERENCES app_agent_grants(grant_id) ON DELETE CASCADE,
  rotated_from BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
COMMENT ON TABLE app_agent_tokens IS 'staging:private';
CREATE INDEX IF NOT EXISTS app_agent_tokens_grant_idx
  ON app_agent_tokens (grant_id) WHERE revoked_at IS NULL;
