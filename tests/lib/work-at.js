'use strict';

// A request's work state at a named point of the bot's work, for tests that
// need "a request being fixed" or "a build waiting its turn" without writing
// its facts each time: the derive's own reading (services/work-state.js
// derive) of a facts row that is that situation. The names are the test's
// shorthand only; nothing in the product reads them.

const ws = require('../../src/services/work-state');

const AT = '2026-10-02T11:50:00.000Z';
const ready = { mode: 'live', verdict: 'ready', build_ok: null, run_proposal: null, run_at: AT };
const build = { ...ready, build_session_id: 7, build_status: 'active', build_started_at: AT };
const change = { proposal_status: 'promoted', proposal_at: AT, checks_at: AT };

/** The facts row of each named situation, as of `now`. */
function rowAt(name, now = new Date()) {
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const rows = {
    reading: { queue_id: 1, enqueued_at: AT, started_at: AT },
    queued: { queue_id: 1, enqueued_at: AT },
    on_hold: { queue_id: 1, enqueued_at: AT, held_until: later, held_reason: 'allowance' },
    question: { question_at: AT },
    plan: { ...ready, plan_waiting_at: AT },
    held: { ...ready, cap_suppressed: 'proposals_per_app' },
    build_queued: { ...ready, build_waiting_at: AT },
    starting: { ...ready, run_at: now.toISOString() },
    stalled: { ...ready, run_at: '2020-01-01T00:00:00.000Z' },
    planning: build,
    building: { ...build, spec_at: AT },
    reviewing: { ...build, review_state: 'reviewing', review_started_at: AT },
    proposing: { ...build, build_status: 'paused', build_last_activity: AT },
    checks: { ...change, check_state: 'pending' },
    checks_failed: { ...change, check_state: 'failing' },
    vote: { ...change, check_state: 'passing' },
    fixing: { ...change, check_state: 'failing', queue_id: 1, started_at: AT, queue_reason: 'checks_failing' },
    revising: { ...change, check_state: 'passing', queue_id: 1, started_at: AT, queue_reason: 'reply' },
    fix_queued: { ...change, check_state: 'failing', queue_id: 1, enqueued_at: AT, queue_reason: 'checks_failing' },
    followup_queued: { ...change, check_state: 'passing', queue_id: 1, enqueued_at: AT, queue_reason: 'reply' },
    fix_stopped: { ...change, check_state: 'failing', fix_stopped: true },
    flake_fixing: { ...change, check_state: 'failing', flake_fixing: true },
    merging: { proposal_status: 'merging', proposal_at: AT },
  };
  if (!rows[name]) throw new Error(`work-at: no situation named ${name}`);
  return rows[name];
}

/**
 * The work state of a request at `name`, with `extra` facts over the
 * situation's own, read at `now`; `since` replaces when it began.
 */
function workAt(name, extra = {}, { now = new Date(), since = null } = {}) {
  const state = ws.derive({ ...rowAt(name, now), ...extra }, { now });
  return since ? { ...state, since } : state;
}

module.exports = { workAt, rowAt };
