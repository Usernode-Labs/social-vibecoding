-- 18 Nov 2026 (#6821, Evan's follow-up): a before & after shots run marks the
-- change it is about, so the lists stop saying "Taking screenshots" the
-- moment the run publishes or fails.
--
-- The shot machine writes a run's state (shot_runs.state) and the slot that
-- shows it (chat_sessions.shots_state and its run: work-state-marks-all-inputs
-- already watches those). A run that ends where the slot is not updated,
-- because it points at another head's run by then, left the change's work
-- state saying "Taking screenshots" until the one-minute sweep came round.
-- This trigger marks the change on the run's own row, whatever wrote it.
--
-- Headless sessions stay out, as chat_sessions_work_state's own WHEN leaves
-- them out: a headless session is nobody's work item (refresh drops it).

CREATE OR REPLACE FUNCTION work_state_mark_shot_run_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.session_id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = r.session_id AND cs.is_headless IS TRUE) THEN
    RETURN NULL;
  END IF;
  PERFORM work_state_mark(NULL, NULL, r.session_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS shot_runs_work_state ON shot_runs;
CREATE TRIGGER shot_runs_work_state AFTER INSERT OR UPDATE OF state OR DELETE ON shot_runs
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_shot_run_row();
