-- Review B4 (19 Nov 2026): why a build of Homeroom bot's stopped is stored
-- as a code, beside the English of homeroom_bot_runs.build_error.
--
-- The cause was decoded from that English by regular expressions in eight
-- places (services/bot-stop-cause.js, work-state.js, homeroom-bot-progress.js,
-- the activity cards, the chat, the public plan, the bot's own push queries
-- with LIKE 'waiting to push:%', a project's figures with LIKE 'skipped:%'):
-- reword one message and its cause silently became "other".
--
-- build_stop is { "cause": <code>, "by"?: <username>, "times"?: <n>,
-- "plan"?: true }, `plan` when it stopped before a plan was written
-- (homeroom-bot-progress.js planFailed: its retry), whatever the cause:
--   restarts, time, restart, unproposed, push, push_permanent,
--   push_gave_up, no_change, no_start, plan, credit, stopped, other
--     (a build that did not finish: bot-stop-cause.js BUILD_CAUSES)
--   waiting_push   finished, its commit not uploaded yet (it is retried)
--   skipped        not built: answered, closed or replaced meanwhile
--   superseded     not built: a later verdict on the same request
--   blocked        found impossible as written: its requester adds detail
-- Additive and nullable: a run with no build_error has none.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_stop JSONB;

-- The one reading of the English, for what was written before the code
-- existed and for a writer that still sends only the English (a Pod of the
-- release before this one, or a writer not yet given its code). Its rules
-- are bot-stop-cause.js stopOfText's; tests/bot-stop-cause-postgres.test.js
-- runs both over the same texts.
CREATE OR REPLACE FUNCTION homeroom_bot_build_stop(err TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out JSONB := homeroom_bot_build_stop_cause(err);
BEGIN
  IF out IS NOT NULL AND btrim(err) ~ '(no plan could be written|only part of a spec)' THEN
    out := out || '{"plan":true}'::jsonb;
  END IF;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION homeroom_bot_build_stop_cause(err TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  raw TEXT := btrim(COALESCE(err, ''));
  r TEXT;
  m TEXT[];
BEGIN
  IF raw = '' THEN RETURN NULL; END IF;
  IF raw = 'credit_wait' THEN RETURN '{"cause":"credit"}'::jsonb; END IF;
  IF raw LIKE 'waiting to push:%' THEN RETURN '{"cause":"waiting_push"}'::jsonb; END IF;
  IF raw LIKE 'skipped:%' THEN RETURN '{"cause":"skipped"}'::jsonb; END IF;
  IF raw LIKE 'superseded:%' THEN RETURN '{"cause":"superseded"}'::jsonb; END IF;
  IF raw LIKE 'blocked:%' THEN RETURN '{"cause":"blocked"}'::jsonb; END IF;
  m := regexp_match(raw, '^stopped: by @([A-Za-z0-9_.-]{1,64})');
  IF m IS NOT NULL THEN RETURN jsonb_build_object('cause', 'stopped', 'by', m[1]); END IF;
  IF raw LIKE 'stopped:%' THEN RETURN '{"cause":"stopped"}'::jsonb; END IF;
  -- What a failed turn was last doing is never read, nor which process
  -- recorded it.
  r := regexp_replace(raw, '; (last activity|it last said):.*$', '');
  r := regexp_replace(r, '\s*\(finished after a restart\)', '', 'g');
  m := regexp_match(r, 'restarted in the middle of each of its last (\d+) tries');
  IF m IS NOT NULL THEN RETURN jsonb_build_object('cause', 'restarts', 'times', m[1]::int); END IF;
  IF r ~ 'ran past its time limit' THEN RETURN '{"cause":"time"}'::jsonb; END IF;
  IF r ~ '(restarted|by a restart)' THEN RETURN '{"cause":"restart"}'::jsonb; END IF;
  IF r ~ 'built but could not be proposed' THEN RETURN '{"cause":"unproposed"}'::jsonb; END IF;
  IF r ~ 'couldn''t push the build''s commit' THEN
    IF r ~ 'gave up' THEN RETURN '{"cause":"push_gave_up"}'::jsonb; END IF;
    IF r ~ 'permanent' THEN RETURN '{"cause":"push_permanent"}'::jsonb; END IF;
    RETURN '{"cause":"push"}'::jsonb;
  END IF;
  IF r ~ 'produced no change' THEN RETURN '{"cause":"no_change"}'::jsonb; END IF;
  IF r ~ '(could not start|would not start|could not open a session|could not create its branch)' THEN
    RETURN '{"cause":"no_start"}'::jsonb;
  END IF;
  IF r ~ '(no plan could be written|only part of a spec)' THEN RETURN '{"cause":"plan"}'::jsonb; END IF;
  RETURN '{"cause":"other"}'::jsonb;
END $$;

-- A write that changes the English without saying the code gets the code
-- the English reads as; one that says it keeps it; clearing the English
-- clears it.
CREATE OR REPLACE FUNCTION homeroom_bot_runs_build_stop() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.build_error IS NULL THEN
    NEW.build_stop := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.build_stop IS NULL THEN NEW.build_stop := homeroom_bot_build_stop(NEW.build_error); END IF;
  ELSIF NEW.build_error IS DISTINCT FROM OLD.build_error AND NEW.build_stop IS NOT DISTINCT FROM OLD.build_stop THEN
    NEW.build_stop := homeroom_bot_build_stop(NEW.build_error);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS homeroom_bot_runs_build_stop ON homeroom_bot_runs;
CREATE TRIGGER homeroom_bot_runs_build_stop BEFORE INSERT OR UPDATE OF build_error, build_stop ON homeroom_bot_runs
  FOR EACH ROW EXECUTE FUNCTION homeroom_bot_runs_build_stop();

-- Once, for what was written before: idempotent (only rows with English
-- and no code yet).
UPDATE homeroom_bot_runs SET build_stop = homeroom_bot_build_stop(build_error)
 WHERE build_stop IS NULL AND build_error IS NOT NULL;
