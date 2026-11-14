-- #6643: a change that carries risk is held for an admin instead of being
-- refused (services/release-holds.js). One row per hold: the rules the
-- change tripped when its checks ran, the commit they were read on, and how
-- it ended. A change has at most one hold waiting at a time; whether an admin
-- has approved it is read off pr_votes, never stored here, so an approval
-- that a new version clears is not remembered as given.
--
--   waiting   an admin's yes is owed (or given: the votes say which)
--   declined  a full admin voted no; the change and its request were closed
--   fixed     a later commit no longer trips any rule, so nobody is owed
CREATE TABLE IF NOT EXISTS release_holds (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  head_sha    TEXT,
  rules       TEXT[] NOT NULL,
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'declined', 'fixed')),
  decided_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ
);
COMMENT ON TABLE release_holds IS 'staging:private';

CREATE UNIQUE INDEX IF NOT EXISTS release_holds_one_waiting
  ON release_holds (session_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS release_holds_recent
  ON release_holds (created_at DESC);

-- The bell row that asks a full admin for their vote reaches a phone as an
-- App alert, beside the platform's limit and incident alerts
-- (services/mobile-push-preferences.js). A kind with no row here pushes
-- nothing.
INSERT INTO mobile_push_kind_categories (kind, category, default_enabled) VALUES
  ('release_hold', 'app_alerts', TRUE)
ON CONFLICT (kind) DO UPDATE SET
  category = EXCLUDED.category,
  default_enabled = EXCLUDED.default_enabled;
