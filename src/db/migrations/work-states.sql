-- 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): one work state per
-- request and per change, stored.
--
-- Every surface that shows where a request or a change stands (the Homeroom
-- bot tab, the chat's activity drawer and cards, a request's page, a
-- project's chat, the bell, the Workshop) used to decide it again from the
-- bot's records with code of its own, and they disagreed. Now
-- services/work-state.js decides it once, from the same records, whenever
-- they change (the workflow's afterAccepted hook, in the transition's own
-- transaction, and the few routes that change a request outside it), and
-- stores it here; the surfaces read this row and the `work_state` push.
--
-- One row per item: a request (item_ref = its number) or a change with no
-- request (item_ref = its session). A change built for a request is that
-- request's row. `stage` is one of ten words, `why` says why a
-- waiting_for_you is the requester's move, `reason` why a stopped stopped,
-- and `line` the second line (a queue place, a hold, a round of review).
--
-- `session_id` and `requester_id` carry no foreign key on purpose. The row
-- is derived again whenever its facts move, so nothing needs them checked,
-- and a check would take a share lock on the change's chat_sessions row: a
-- transition that holds that row FOR UPDATE (the proposal, preview,
-- merge-followups and shots machines' facts) and then stores this row would
-- deadlock with a drain storing the same row first. A deleted user or
-- change leaves a number nothing joins to.

CREATE TABLE IF NOT EXISTS work_states (
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('request', 'change')),
  item_ref      INTEGER NOT NULL,
  issue_number  INTEGER,
  session_id    INTEGER,
  stage         TEXT NOT NULL CHECK (stage IN (
                  'reading', 'planning', 'waiting_for_you', 'building', 'checking',
                  'up_for_vote', 'going_live', 'live', 'stopped', 'closed')),
  why           TEXT CHECK (why IS NULL OR why IN ('question', 'plan', 'decide', 'already_works', 'needs_detail')),
  reason        TEXT CHECK (reason IS NULL OR reason IN ('build_failed', 'fix_stopped', 'look_failed', 'change_closed', 'stalled')),
  line          JSONB,
  whose_move    TEXT CHECK (whose_move IS NULL OR whose_move IN ('bot', 'requester', 'group', 'builder')),
  requester_id  INTEGER,
  since         TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When it was last derived again, changed or not: the sweep takes the
  -- longest unchecked first, so it reaches every row in turn.
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, item_kind, item_ref)
);

-- A person's own items, for the bot tab and the drawer.
CREATE INDEX IF NOT EXISTS work_states_requester_idx
  ON work_states (requester_id, updated_at DESC) WHERE requester_id IS NOT NULL;
-- An app's items in a stage, for a project's lists.
CREATE INDEX IF NOT EXISTS work_states_app_stage_idx ON work_states (app_id, stage);
-- The sweep: the rows still moving, longest unchecked first.
CREATE INDEX IF NOT EXISTS work_states_sweep_idx ON work_states (checked_at) WHERE stage <> 'closed';
-- A change's row, found from its session.
CREATE INDEX IF NOT EXISTS work_states_session_idx ON work_states (session_id) WHERE session_id IS NOT NULL;

-- Derived from the bot's private records (its runs, its queue, people's
-- requests): a staging copy gets the table without its rows, and a fresh
-- refresh there writes its own.
COMMENT ON TABLE work_states IS 'staging:private';

-- ── What changed since: the requests and changes to derive again ────────
--
-- The machines' transitions store a work state as they change one
-- (afterAccepted), and a few routes refresh theirs. Everything else that
-- writes what a work state is derived from (the build pipeline's progress,
-- a review round, a reply, a claim, a change's checks or its turn) is
-- caught here, by construction: a trigger on each of those tables marks the
-- request or change it is about, and services/work-state.js drainDirty
-- derives the marked ones again within seconds (the work-state-drain
-- clock). One row per item: marking one already marked does nothing.

CREATE TABLE IF NOT EXISTS work_state_dirty (
  id            BIGSERIAL PRIMARY KEY,
  app_id        INTEGER,
  issue_number  INTEGER,
  session_id    INTEGER,
  marked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((session_id IS NULL) = (app_id IS NOT NULL AND issue_number IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS work_state_dirty_request_idx
  ON work_state_dirty (app_id, issue_number) WHERE session_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_state_dirty_session_idx
  ON work_state_dirty (session_id) WHERE session_id IS NOT NULL;
COMMENT ON TABLE work_state_dirty IS 'staging:private';

CREATE OR REPLACE FUNCTION work_state_mark(p_app INTEGER, p_issue INTEGER, p_session INTEGER) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_session IS NOT NULL THEN
    INSERT INTO work_state_dirty (session_id) VALUES (p_session)
      ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO NOTHING;
  ELSIF p_app IS NOT NULL AND p_issue IS NOT NULL AND p_issue > 0 THEN
    INSERT INTO work_state_dirty (app_id, issue_number) VALUES (p_app, p_issue)
      ON CONFLICT (app_id, issue_number) WHERE session_id IS NULL DO NOTHING;
  END IF;
END $$;

-- A row of a table keyed by (app_id, issue_number): marks its request.
CREATE OR REPLACE FUNCTION work_state_mark_request_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM work_state_mark(r.app_id, r.issue_number, NULL);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS homeroom_bot_runs_work_state ON homeroom_bot_runs;
CREATE TRIGGER homeroom_bot_runs_work_state AFTER INSERT OR UPDATE ON homeroom_bot_runs
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();
DROP TRIGGER IF EXISTS homeroom_bot_queue_work_state ON homeroom_bot_queue;
CREATE TRIGGER homeroom_bot_queue_work_state AFTER INSERT OR UPDATE OR DELETE ON homeroom_bot_queue
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();
DROP TRIGGER IF EXISTS homeroom_bot_posts_work_state ON homeroom_bot_posts;
CREATE TRIGGER homeroom_bot_posts_work_state AFTER INSERT ON homeroom_bot_posts
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();
DROP TRIGGER IF EXISTS homeroom_bot_requesters_work_state ON homeroom_bot_requesters;
CREATE TRIGGER homeroom_bot_requesters_work_state AFTER INSERT OR UPDATE OR DELETE ON homeroom_bot_requesters
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();
DROP TRIGGER IF EXISTS homeroom_bot_closed_requests_work_state ON homeroom_bot_closed_requests;
CREATE TRIGGER homeroom_bot_closed_requests_work_state AFTER INSERT OR UPDATE OR DELETE ON homeroom_bot_closed_requests
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();
DROP TRIGGER IF EXISTS homeroom_bot_dm_messages_work_state ON homeroom_bot_dm_messages;
CREATE TRIGGER homeroom_bot_dm_messages_work_state AFTER INSERT OR UPDATE OF question_status ON homeroom_bot_dm_messages
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_request_row();

CREATE OR REPLACE FUNCTION work_state_mark_issue_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM work_state_mark(r.app_id, r.github_issue_number, NULL);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS issue_claims_work_state ON issue_claims;
CREATE TRIGGER issue_claims_work_state AFTER INSERT OR UPDATE OR DELETE ON issue_claims
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_issue_row();
DROP TRIGGER IF EXISTS issues_work_state ON issues;
CREATE TRIGGER issues_work_state AFTER INSERT OR UPDATE OF status ON issues
  FOR EACH ROW WHEN (NEW.kind = 'general') EXECUTE FUNCTION work_state_mark_issue_row();

CREATE OR REPLACE FUNCTION work_state_mark_session_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM work_state_mark(NULL, NULL, r.session_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS homeroom_bot_change_asks_work_state ON homeroom_bot_change_asks;
CREATE TRIGGER homeroom_bot_change_asks_work_state AFTER INSERT OR UPDATE OF status OR DELETE ON homeroom_bot_change_asks
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_session_row();
DROP TRIGGER IF EXISTS homeroom_bot_revision_grants_work_state ON homeroom_bot_revision_grants;
CREATE TRIGGER homeroom_bot_revision_grants_work_state AFTER INSERT OR UPDATE OF used_at ON homeroom_bot_revision_grants
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_session_row();

-- A change: what its stage reads moved (its status, checks, turn, the
-- requests it says it closes).
CREATE OR REPLACE FUNCTION work_state_mark_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.check_state IS DISTINCT FROM OLD.check_state
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

DROP TRIGGER IF EXISTS chat_sessions_work_state ON chat_sessions;
CREATE TRIGGER chat_sessions_work_state AFTER INSERT OR UPDATE ON chat_sessions
  FOR EACH ROW WHEN (NEW.is_headless IS NOT TRUE) EXECUTE FUNCTION work_state_mark_change();

-- A private thread about a request holds it for its requester's plan.
CREATE OR REPLACE FUNCTION work_state_mark_private_thread() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.about_kind = 'request' THEN PERFORM work_state_mark(r.app_id, r.about_number, NULL); END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS private_threads_work_state ON private_threads;
CREATE TRIGGER private_threads_work_state AFTER INSERT OR UPDATE OR DELETE ON private_threads
  FOR EACH ROW EXECUTE FUNCTION work_state_mark_private_thread();
