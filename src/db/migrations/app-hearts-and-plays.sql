-- Hearts and plays (services/app-popularity.js): what a project's hub, its
-- signed-out page and the Communities cards say about how much an app is
-- liked and used.
--
-- HEARTS. One row per account and app: anybody signed in who can see an app
-- can heart it and take the heart back, a member or not. It is not a pin
-- (app_favorites, "keep it on my Home") and not a membership.
--
-- PLAYS are one per person per app per day. Somebody signed in is counted
-- from app_activity, which already keeps exactly that row, so nothing new is
-- written for them. A visitor with no account has no such row, so their
-- plays are counted here: a number per app per day, and nothing about who.
--
-- app_visitor_play_marks is what stops the same visitor counting twice in a
-- day: the keyed, day-scoped hash of a network the signed-out telemetry
-- already uses (ui-telemetry.js anonymousSource), which names nobody and
-- cannot be turned back into an address. A row is of no use after its day
-- and is deleted two days on (app-popularity.js pruneMarks).
CREATE TABLE IF NOT EXISTS app_hearts (
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_hearts_user ON app_hearts (user_id);

CREATE TABLE IF NOT EXISTS app_visitor_plays (
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  day    DATE NOT NULL,
  plays  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);

CREATE TABLE IF NOT EXISTS app_visitor_play_marks (
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  day    DATE NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (app_id, day, source)
);
CREATE INDEX IF NOT EXISTS idx_app_visitor_play_marks_day ON app_visitor_play_marks (day);
