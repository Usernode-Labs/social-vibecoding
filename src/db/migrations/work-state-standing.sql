-- 11 Nov 2026 (docs/plans/bot-one-model.md, step 3, built in step 1 of the
-- one-model proposal): the standing. One row per request and per change is
-- what every surface draws and what Homeroom bot says of it.
--
-- A row already held the stage, its why or reason and its second line. It
-- now also holds the facts a screen or the bot used to read again for
-- itself (services/work-state.js refresh writes them with the stage):
--
--   standing        its change (checks, votes, holds, an update on its
--                   way), what is asked of the requester (an open question,
--                   a plan, a vote to close it, a private thread holding it,
--                   open cards), the bot's newest post about it, and for a
--                   request its tries, why its build stopped and who
--                   shipped it when somebody else's change closed it.
--   vote_open       its change is open for votes now: up for a vote, its
--                   checks passed on its head, not a first version, no
--                   update on its way, GitHub is not holding an approved
--                   merge, its before & after shots are not still being
--                   taken, and it merges cleanly or waits only for a yes.
--                   Needs you lists a vote only on a change row with this
--                   set (routes/workshop-overview.js), so a merged, merging
--                   or held change is never asked for one.
--   lead_change_id  on a request's row: the change it draws (the bot's
--                   newest proposal of it, else a person's change for it).
--
-- A change now has its own row even when it was built for a request (the
-- request's row says where the request stands; the change's says whether
-- it is open for votes). A change's row never rings the bell: its
-- requests' rows do (work-state.js bellPushes).

ALTER TABLE work_states ADD COLUMN IF NOT EXISTS standing JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE work_states ADD COLUMN IF NOT EXISTS vote_open BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE work_states ADD COLUMN IF NOT EXISTS lead_change_id BIGINT;

-- Needs you: the changes open for votes, by change.
CREATE INDEX IF NOT EXISTS work_states_vote_open_idx
  ON work_states (item_ref) WHERE item_kind = 'change' AND vote_open;

-- ── What the standing is derived from, marked when it moves ─────────────

-- A vote on a change: its votes, and whether it is still owed.
CREATE OR REPLACE FUNCTION work_state_mark_vote() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM work_state_mark(NULL, NULL, r.session_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pr_votes_work_state ON pr_votes;
CREATE TRIGGER pr_votes_work_state AFTER INSERT OR UPDATE OR DELETE ON pr_votes
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_vote();

-- One of Homeroom bot's cards: the request it is about (its column, the
-- request a card was made from, or its args), and the change.
CREATE OR REPLACE FUNCTION work_state_mark_card() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
DECLARE n INTEGER;
DECLARE s INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  n := COALESCE(r.issue_number, r.source_issue_number,
                CASE WHEN (r.args->>'issueNumber') ~ '^[0-9]{1,9}$' THEN (r.args->>'issueNumber')::int END);
  s := COALESCE(r.session_id,
                CASE WHEN (r.args->>'sessionId') ~ '^[0-9]{1,9}$' THEN (r.args->>'sessionId')::int END);
  IF r.app_id IS NOT NULL AND n IS NOT NULL THEN PERFORM work_state_mark(r.app_id, n, NULL); END IF;
  IF s IS NOT NULL THEN PERFORM work_state_mark(NULL, NULL, s); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS bot_cards_work_state ON bot_cards;
CREATE TRIGGER bot_cards_work_state AFTER INSERT OR UPDATE OF status OR DELETE ON bot_cards
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_card();

-- A plan version on a session: the requests the session is about (the
-- session's own mark resolves to them).
CREATE OR REPLACE FUNCTION work_state_mark_spec() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM work_state_mark(NULL, NULL, r.session_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS chat_session_specs_work_state ON chat_session_specs;
CREATE TRIGGER chat_session_specs_work_state AFTER INSERT OR UPDATE OF shared_to_group_at OR DELETE ON chat_session_specs
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_spec();

-- A vote to close a request: the request it closes.
CREATE OR REPLACE FUNCTION work_state_mark_close_vote() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.payload->>'issueNumber') ~ '^[0-9]{1,9}$' THEN
    PERFORM work_state_mark(NEW.app_id, (NEW.payload->>'issueNumber')::int, NULL);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS issues_close_vote_work_state ON issues;
CREATE TRIGGER issues_close_vote_work_state AFTER INSERT OR UPDATE OF status ON issues
  FOR EACH ROW WHEN (NEW.kind = 'close_issue') EXECUTE FUNCTION work_state_mark_close_vote();

-- A vote on a vote to close a request.
CREATE OR REPLACE FUNCTION work_state_mark_issue_vote() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM work_state_mark(i.app_id, (i.payload->>'issueNumber')::int, NULL)
     FROM issues i
    WHERE i.id = r.issue_id AND i.kind = 'close_issue' AND (i.payload->>'issueNumber') ~ '^[0-9]{1,9}$';
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS issue_votes_work_state ON issue_votes;
CREATE TRIGGER issue_votes_work_state AFTER INSERT OR UPDATE OR DELETE ON issue_votes
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_issue_vote();

-- The bot's post goes out (its message is recorded after the row is made).
DROP TRIGGER IF EXISTS homeroom_bot_posts_work_state ON homeroom_bot_posts;
CREATE TRIGGER homeroom_bot_posts_work_state AFTER INSERT OR UPDATE OF thread_message_id, pending ON homeroom_bot_posts
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();

-- A change: also what holds its vote or its merge (GitHub's hold, its
-- shots), a new head clearing its votes (an imported change's head too),
-- and its PR number. What lapses with time alone (a turn or an ask past its
-- window, shots that never settled) the two-minute sweep catches.
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
     OR NEW.shots_state IS DISTINCT FROM OLD.shots_state
     OR NEW.shots_run_id IS DISTINCT FROM OLD.shots_run_id
     OR NEW.shots_updated_at IS DISTINCT FROM OLD.shots_updated_at
     OR NEW.approval_epoch IS DISTINCT FROM OLD.approval_epoch
     OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
     OR NEW.live_at IS DISTINCT FROM OLD.live_at
     OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
     OR NEW.linked_issues IS DISTINCT FROM OLD.linked_issues
     OR (NEW.active_turn IS NULL) <> (OLD.active_turn IS NULL)
     OR NEW.reviewed_head_sha IS DISTINCT FROM OLD.reviewed_head_sha
     OR NEW.imported_pr_head_sha IS DISTINCT FROM OLD.imported_pr_head_sha
     OR NEW.checks_commit_sha IS DISTINCT FROM OLD.checks_commit_sha THEN
    PERFORM work_state_mark(NULL, NULL, NEW.id);
  END IF;
  RETURN NULL;
END $$;
