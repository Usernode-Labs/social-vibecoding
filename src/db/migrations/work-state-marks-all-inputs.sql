-- 18 Nov 2026 (#6821): every input a change's work state is derived from
-- marks it, whatever wrote it.
--
-- A change's page worked its status out live, while the lists read the
-- stored row (work_states), and the two disagreed: an approved change
-- catching up with main said "Approved · Syncing with main" on its page and
-- "Up for a vote" in the Homeroom bot tab. Part of that was the derivation
-- itself (services/work-state.js now drops a stale 'awaiting_approval' once
-- the votes are in); the rest was the store going stale, because a fact that
-- deriveChange / promotedChange / deriveFacts read was written where nothing
-- marked the item. A follow-up turn's active_turn, a merge, a new head, the
-- before & after shots, a verdict, the update on its way (an ask, a look, a
-- check the bot is getting fixed) all left the row saying the old thing
-- until the one-minute sweep came round, and with a few thousand open rows
-- that is many minutes.
--
-- Each input now marks its item itself, so the 3 s drain (drainDirty)
-- refreshes the row whatever wrote the fact. Nothing else changes: the
-- marks table, work_state_mark and the drain are the ones work-states.sql
-- made. The routes' own touched() calls stay, redundant but harmless.

-- The change's columns, all of what CHANGE_FACTS_SQL, updateComingSql,
-- updateFailedSql, flakeFixingSql and shotsHeld read. The turn is marked on
-- its mode or its start, never on its heartbeat: a beat every few seconds
-- would fill the marks table for a fact no stage reads.
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
     OR NEW.merged_at IS DISTINCT FROM OLD.merged_at
     OR NEW.live_at IS DISTINCT FROM OLD.live_at
     OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
     OR NEW.linked_issues IS DISTINCT FROM OLD.linked_issues
     OR NEW.approval_epoch IS DISTINCT FROM OLD.approval_epoch
     OR (NEW.active_turn IS NULL) <> (OLD.active_turn IS NULL)
     OR COALESCE(NEW.active_turn->>'mode', '') IS DISTINCT FROM COALESCE(OLD.active_turn->>'mode', '')
     OR COALESCE(NEW.active_turn->>'startedAt', '') IS DISTINCT FROM COALESCE(OLD.active_turn->>'startedAt', '')
     OR NEW.imported_pr_head_sha IS DISTINCT FROM OLD.imported_pr_head_sha
     OR NEW.reviewed_head_sha IS DISTINCT FROM OLD.reviewed_head_sha
     OR NEW.checks_commit_sha IS DISTINCT FROM OLD.checks_commit_sha
     OR NEW.test_results IS DISTINCT FROM OLD.test_results
     OR NEW.shots_state IS DISTINCT FROM OLD.shots_state
     OR NEW.shots_run_id IS DISTINCT FROM OLD.shots_run_id
     OR NEW.shots_detail IS DISTINCT FROM OLD.shots_detail
     OR NEW.shots_updated_at IS DISTINCT FROM OLD.shots_updated_at
     OR NEW.created_from_issue_number IS DISTINCT FROM OLD.created_from_issue_number THEN
    PERFORM work_state_mark(NULL, NULL, NEW.id);
  END IF;
  RETURN NULL;
END $$;

-- An update on its way: an ask's status move (queued, taken, done) and the
-- head it was taken at both change what its change reads.
DROP TRIGGER IF EXISTS homeroom_bot_change_asks_work_state ON homeroom_bot_change_asks;
CREATE TRIGGER homeroom_bot_change_asks_work_state AFTER INSERT OR UPDATE OR DELETE ON homeroom_bot_change_asks
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_session_row();

-- A takeover look: running, done or failed, and when it ended, are what
-- updateComingSql and updateFailedSql read.
CREATE OR REPLACE FUNCTION work_state_mark_look_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.session_id IS NOT NULL THEN PERFORM work_state_mark(NULL, NULL, r.session_id); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS homeroom_bot_looks_work_state ON homeroom_bot_looks;
CREATE TRIGGER homeroom_bot_looks_work_state AFTER INSERT OR UPDATE OF state, ended_at OR DELETE ON homeroom_bot_looks
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_look_row();

-- A wait on a fix for a check that is not the change's own (#6807): whether
-- one is open, and what became of it.
DROP TRIGGER IF EXISTS homeroom_bot_flake_waits_work_state ON homeroom_bot_flake_waits;
CREATE TRIGGER homeroom_bot_flake_waits_work_state AFTER INSERT OR UPDATE OF stage, ended_at OR DELETE ON homeroom_bot_flake_waits
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_session_row();
