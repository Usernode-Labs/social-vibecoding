-- A request's summary, written by Homeroom bot (services/request-summary.js)
-- and shown at the top of the request's page in place of the asker's own
-- words once there is something beyond them to say: a plan the group can
-- read, or one or more changes built for it. Before that the page shows
-- the request as it was written.
--
-- One row per request. `input_key` names what the summary was written from
-- (the request's words, the newest plan shared with the group, and each
-- change up for a vote or merged, by its summary): when the page is read
-- and that no longer matches, the summary is written again, and the old one
-- is shown until the new one lands. `basis` says what it drew on, for the
-- line under it. `generating_until` is one writer's lease across processes;
-- `failed_at` holds off a retry.
--
-- Private: it is text about a project's requests, which may be a private
-- community's, so a staging copy gets the table and none of its rows.
CREATE TABLE IF NOT EXISTS request_summaries (
  app_id           INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number     INTEGER NOT NULL,
  input_key        VARCHAR(64) NOT NULL,
  summary          TEXT,
  basis            VARCHAR(16) CHECK (basis IN ('plan', 'change', 'changes')),
  model            VARCHAR(64),
  generating_until TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, issue_number)
);
COMMENT ON TABLE request_summaries IS 'staging:private';
