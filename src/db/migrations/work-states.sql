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

CREATE TABLE IF NOT EXISTS work_states (
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('request', 'change')),
  item_ref      INTEGER NOT NULL,
  issue_number  INTEGER,
  session_id    INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  stage         TEXT NOT NULL CHECK (stage IN (
                  'reading', 'planning', 'waiting_for_you', 'building', 'checking',
                  'up_for_vote', 'going_live', 'live', 'stopped', 'closed')),
  why           TEXT CHECK (why IS NULL OR why IN ('question', 'plan', 'decide', 'already_works', 'needs_detail')),
  reason        TEXT CHECK (reason IS NULL OR reason IN ('build_failed', 'fix_stopped', 'look_failed', 'change_closed', 'stalled')),
  line          JSONB,
  whose_move    TEXT CHECK (whose_move IS NULL OR whose_move IN ('bot', 'requester', 'group', 'builder')),
  requester_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
