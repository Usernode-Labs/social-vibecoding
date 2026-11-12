-- 11 Nov 2026 (docs/plans/bot-one-model.md, the one-model finish's review):
-- the work states' backfill, two indexes and a quieter card trigger.
--
-- A change built for a request has had a row of its own since
-- work-state-standing, and Needs you and the vote digest ask for a vote
-- only off that row (work_states.vote_open). The sweep makes the missing
-- ones a hundred a minute; every change up for a vote or merging is marked
-- now instead, so the drain (services/work-state.js drainDirty) makes their
-- rows within seconds of the release. db/migrate.js marks them again on
-- every boot, for a staging copy (whose work_states start empty) and any
-- change still without one.
INSERT INTO work_state_dirty (session_id)
SELECT cs.id FROM chat_sessions cs
 WHERE cs.status IN ('promoted', 'merging') AND cs.is_headless IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM work_states ws WHERE ws.item_kind = 'change' AND ws.session_id = cs.id)
ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO NOTHING;

-- The requests a change is about, from the run that built it
-- (work-state.js requestsOfSession and CHANGE_FACTS_SQL has_requests): a
-- run's build session had no index, so every refresh of a change read every
-- run. Most runs build nothing.
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_build_session
  ON homeroom_bot_runs(build_session_id) WHERE build_session_id IS NOT NULL;

-- A card retired because what it is about moved on (bot-cards.js
-- retireCards) marks nothing: the refresh that retired it derives its item
-- again itself (work-state.js settleCards), and the mark it made waited on
-- the drain's own taken marks while a tap on the same card waited on the
-- drain (a deadlock). Every other write to a card still marks its request
-- and its change.
CREATE OR REPLACE FUNCTION work_state_mark_card() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
DECLARE n INTEGER;
DECLARE s INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'retired' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  n := COALESCE(r.issue_number, r.source_issue_number,
                CASE WHEN (r.args->>'issueNumber') ~ '^[0-9]{1,9}$' THEN (r.args->>'issueNumber')::int END);
  s := COALESCE(r.session_id,
                CASE WHEN (r.args->>'sessionId') ~ '^[0-9]{1,9}$' THEN (r.args->>'sessionId')::int END);
  IF r.app_id IS NOT NULL AND n IS NOT NULL THEN PERFORM work_state_mark(r.app_id, n, NULL); END IF;
  IF s IS NOT NULL THEN PERFORM work_state_mark(NULL, NULL, s); END IF;
  RETURN NULL;
END $$;

-- The sweep: the rows still moving, longest unchecked first. A request
-- nobody has started on (reading, waiting to be read) moves only when one of
-- its records is written, which marks it, so the sweep leaves it out: a list
-- of requests makes a row for each one it shows (routes/issues.js), and
-- those rows would otherwise take the sweep's turns from the ones that move
-- by time.
DROP INDEX IF EXISTS work_states_sweep_idx;
CREATE INDEX IF NOT EXISTS work_states_sweep_moving_idx ON work_states (checked_at)
  WHERE stage <> 'closed'
    AND NOT (item_kind = 'request' AND stage = 'reading' AND COALESCE(line->>'code', '') = 'waiting');
