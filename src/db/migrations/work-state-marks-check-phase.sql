-- 6 Nov 2026 (#6402): a change's work state moves when what its checks wait
-- on moves.
--
-- services/work-state.js now words a checking change with "About N min left"
-- while its run is in flight, and "Waiting to sync with main" while its
-- checks are deferred or a conflict with main is recorded. Deferring a
-- promoted head (check_phase 'deferred') and measuring a conflict
-- (merge_conflict_state, integration_merges_clean) both change how the row
-- reads, and neither touched a column the old trigger watched, so a stored
-- row would have kept saying the old thing until the sweep caught up.
--
-- The two-minute sweep (work-state.js sweep) still re-derives rows that are
-- still moving, which keeps the minutes current between the moves below.

CREATE OR REPLACE FUNCTION work_state_mark_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.check_state IS DISTINCT FROM OLD.check_state
     OR NEW.check_phase IS DISTINCT FROM OLD.check_phase
     OR NEW.merge_conflict_state IS DISTINCT FROM OLD.merge_conflict_state
     OR NEW.integration_merges_clean IS DISTINCT FROM OLD.integration_merges_clean
     OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
     OR NEW.live_at IS DISTINCT FROM OLD.live_at
     OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
     OR NEW.linked_issues IS DISTINCT FROM OLD.linked_issues
     OR (NEW.active_turn IS NULL) <> (OLD.active_turn IS NULL)
     OR NEW.reviewed_head_sha IS DISTINCT FROM OLD.reviewed_head_sha
     OR NEW.checks_commit_sha IS DISTINCT FROM OLD.checks_commit_sha THEN
    PERFORM work_state_mark(NULL, NULL, NEW.id);
  END IF;
  RETURN NULL;
END $$;
