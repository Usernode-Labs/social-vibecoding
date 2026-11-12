-- 11 Nov 2026 (#6594): a change's work state moves when its votes move.
--
-- services/work-state.js now says a change whose votes are in is Approved
-- (waiting on its checks) or Going live, never "Up for a vote". A vote
-- decides that, and pr_votes was not among the tables a work state is
-- derived from, so a stored row would have kept asking for a vote already
-- cast until the two-minute sweep caught up.
--
-- An authored push moves the approval epoch, which retires earlier yes
-- votes; the change's state follows that too, so chat_sessions.approval_epoch
-- (and integration_block_reasons, which the same rule reads) now mark a
-- change.

DROP TRIGGER IF EXISTS pr_votes_work_state ON pr_votes;
CREATE TRIGGER pr_votes_work_state AFTER INSERT OR UPDATE OR DELETE ON pr_votes
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_session_row();

CREATE OR REPLACE FUNCTION work_state_mark_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.check_state IS DISTINCT FROM OLD.check_state
     OR NEW.check_phase IS DISTINCT FROM OLD.check_phase
     OR NEW.merge_conflict_state IS DISTINCT FROM OLD.merge_conflict_state
     OR NEW.integration_merges_clean IS DISTINCT FROM OLD.integration_merges_clean
     OR NEW.integration_block_reasons IS DISTINCT FROM OLD.integration_block_reasons
     OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
     OR NEW.live_at IS DISTINCT FROM OLD.live_at
     OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
     OR NEW.linked_issues IS DISTINCT FROM OLD.linked_issues
     OR NEW.approval_epoch IS DISTINCT FROM OLD.approval_epoch
     OR (NEW.active_turn IS NULL) <> (OLD.active_turn IS NULL)
     OR NEW.reviewed_head_sha IS DISTINCT FROM OLD.reviewed_head_sha
     OR NEW.checks_commit_sha IS DISTINCT FROM OLD.checks_commit_sha THEN
    PERFORM work_state_mark(NULL, NULL, NEW.id);
  END IF;
  RETURN NULL;
END $$;
