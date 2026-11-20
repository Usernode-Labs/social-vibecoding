'use strict';

// The inputs of tests/work-state-derive-table.test.js: a wide, generated set
// of facts rows (a request's, REQUEST_FACTS_SQL; a change's, CHANGE_FACTS_SQL)
// and what the derive says of each, written short enough to record.
//
// The recording (tests/fixtures/work-state-derive.before.json) was made from
// the derive as it stood at 6b83931c0, before a request's row was composed
// from its change's. It is the "before" of that refactor and is never made
// again: a deliberate difference is listed in the test file, with its reason.
//
//   node tests/lib/work-state-cases.js <file>     record what the derive says now
//
// Cases are generated in a fixed order and recorded by position, so add new
// cases as a NEW group at the end, never inside an existing one.

const crypto = require('node:crypto');

const NOW = new Date('2026-11-19T12:00:00Z');
const T = Object.freeze(Object.fromEntries(Object.entries({
  request_at: 600, run_at: 200, enqueued_at: 40, started_at: 5, question_at: 30, older_question_at: 400,
  proposal_at: 120, checks_at: 20, shots_at: 10, merged_at: 3, live_at: 2, plan_waiting_at: 90, build_waiting_at: 80,
  build_started_at: 70, spec_at: 60, build_turn_at: 55, build_last_activity: 50, review_started_at: 45,
  claimed_at: 150, late_claimed_at: 100, reply_at: 1, lc_created_at: 180, lc_last_activity_at: 35, lc_promoted_at: 110,
  lc_checks_at: 25, lc_merged_at: 8, lc_live_at: 7, proposal_closed_at: 15, closed_at: 12, hold_until: -600,
  stale_run_at: 3000, long_ago: 100000,
}).map(([k, min]) => [k, new Date(NOW.getTime() - min * 60 * 1000).toISOString()])));
const LABEL = new Map(Object.entries(T).map(([k, v]) => [v, k]));

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const FAILED = [{ name: 'one', status: 'fail' }, { name: 'two', status: 'fail' }, { name: 'three', status: 'pass' }];

// ── The facts of a change, in both rows' column names ─────────────────────

const CHECKS = ['passing', 'skipped', 'failing', 'error', 'unknown', 'pending', null];
const MERGES = ['clean', 'yes', 'syncing', 'author', 'deferred'];
const HOLDS = [null, 'github_stuck', 'github_checks_failing', 'github_checks', 'github_refused'];

function mergeFacts(merge, hold) {
  const reasons = hold ? [hold] : [];
  if (merge === 'yes') return { merge_conflict_state: 'conflict', integration_merges_clean: false, integration_block_reasons: ['awaiting_approval', ...reasons] };
  if (merge === 'syncing') return { merge_conflict_state: 'conflict', integration_merges_clean: null, integration_block_reasons: reasons };
  if (merge === 'author') return { merge_conflict_state: null, integration_merges_clean: false, integration_block_reasons: ['unresolvable', ...reasons] };
  return { merge_conflict_state: null, integration_merges_clean: merge === 'deferred' ? null : true, integration_block_reasons: reasons };
}

const shotsFacts = (held) => (held ? {
  shots_state: 'exploring', shots_run_id: 77, shots_updated_at: T.shots_at,
  shots_detail: { headSha: HEAD, required: true, intent: { stories: [{ id: 's1' }] } },
} : { shots_state: null, shots_run_id: null, shots_updated_at: null, shots_detail: null });

/**
 * One change's facts as a request's row carries its own change (`row`:
 * REQUEST_RECORD_COLUMNS) and as the change's own row does (`change`:
 * CHANGE_FACTS_SQL), from one description of it.
 */
function changeFacts(a) {
  const failing = a.check === 'failing' || a.check === 'error';
  const merge = mergeFacts(a.merge, a.hold);
  const shots = shotsFacts(a.shots);
  const phase = a.merge === 'deferred' ? 'deferred' : null;
  const row = {
    proposal_session_id: 500, run_proposal: 500, proposal_status: a.status || 'promoted', proposal_source: 'native',
    proposal_at: T.proposal_at, check_state: a.check, check_phase: phase, checks_at: T.checks_at,
    checks_sha: a.head === 'off' ? OTHER : HEAD, reviewed_head_sha: HEAD, imported_pr_head_sha: null,
    test_results: failing ? FAILED : [], ...merge, ...shots,
    first_version: a.first === true, votes_in: a.votes === true, earlier_yes: a.earlier || 0,
    fix_stopped: a.bot === 'fix_stopped', flake_fixing: a.bot === 'flake_fixing',
    update_coming: a.update || null, update_failed: a.failed ? 'it did not finish' : null,
    merged_at: a.status === 'merging' && a.merged ? T.merged_at : null,
  };
  const change = {
    id: 500, app_id: 1, user_id: 9, status: a.status === 'merging' && a.merged ? 'merged' : a.status || 'promoted',
    pr_number: 61, is_headless: false, source: 'native', check_state: a.check, check_phase: phase,
    checks_at: T.checks_at, checks_commit_sha: a.head === 'off' ? OTHER : HEAD, reviewed_head_sha: HEAD,
    imported_pr_head_sha: null, failed_checks: failing ? 2 : null, ...merge, ...shots,
    first_version: a.first === true, votes_in: a.votes === true, earlier_yes: a.earlier || 0,
    flake_fixing: a.bot === 'flake_fixing', update_coming: a.update || null,
    update_failed: a.failed ? 'it did not finish' : null,
    promoted_at: T.proposal_at, merged_at: a.status === 'merging' && a.merged ? T.merged_at : null, live_at: null,
    created_at: T.long_ago, last_activity_at: T.build_last_activity, has_requests: true, offers: [],
  };
  return { row, change };
}

// What Homeroom bot is doing about a request whose change is open.
const BOT = Object.freeze({
  none: {},
  fixing: { queue_id: 3, started_at: T.started_at, enqueued_at: T.enqueued_at, queue_reason: 'checks_failing' },
  revising: { queue_id: 3, started_at: T.started_at, enqueued_at: T.enqueued_at, queue_reason: 'reply' },
  fix_queued: { queue_id: 3, started_at: null, enqueued_at: T.enqueued_at, queue_reason: 'checks_failing' },
  followup_queued: { queue_id: 3, started_at: null, enqueued_at: T.enqueued_at, queue_reason: 'reply' },
  question: { question_at: T.question_at },
  question_closed: { question_at: T.question_at, request_closed: true },
  fix_stopped: {},
  flake_fixing: {},
});

const REQUEST = Object.freeze({
  app_id: 1, issue_number: 7, app_slug: 'demo', requester_id: 9, mode: 'live', verdict: 'ready', build_ok: true,
  run_id: 11, run_at: T.run_at, request_at: T.request_at, request_closed: false, build_session_id: 500,
});

const name = (a) => Object.entries(a).filter(([, v]) => v !== undefined && v !== false && v !== 0)
  .map(([k, v]) => `${k}=${v === true ? 'y' : v}`).join(' ');

function changeCases() {
  const cases = [];
  const add = (group, a) => {
    const { row, change } = changeFacts(a);
    const request = { ...REQUEST, ...row, ...(BOT[a.bot || 'none']) };
    cases.push({ group: `request.${group}`, name: name(a), a, kind: 'request', row: request, change });
    cases.push({ group: `request-alone.${group}`, name: name(a), a, kind: 'request', row: request, change: null });
    if (!a.bot || a.bot === 'none' || a.bot === 'flake_fixing') cases.push({ group: `change.${group}`, name: name(a), a, kind: 'change', change });
  };
  // Every combination of what a change up for a vote can wait on.
  for (const check of CHECKS) for (const head of ['on', 'off']) for (const merge of MERGES) for (const hold of HOLDS) {
    for (const shots of [false, true]) for (const first of [false, true]) for (const votes of [false, true]) {
      add('core', { check, head, merge, hold, shots, first, votes });
    }
  }
  // What the bot is doing about it, an update on its way and a failed
  // takeover, over the combinations that decide a stage.
  for (const check of ['passing', 'failing', 'unknown', 'pending']) for (const merge of ['clean', 'yes', 'syncing', 'author']) {
    for (const hold of [null, 'github_checks']) for (const first of [false, true]) for (const votes of [false, true]) {
      const core = { check, head: 'on', merge, hold, shots: false, first, votes };
      for (const bot of Object.keys(BOT).filter((b) => b !== 'none')) add('bot', { ...core, bot });
      for (const update of ['running', 'queued']) add('update', { ...core, update });
      add('update', { ...core, failed: true });
      add('update', { ...core, bot: 'fixing', update: 'running' });
      add('update', { ...core, bot: 'followup_queued', update: 'queued' });
      add('update', { ...core, bot: 'question', update: 'queued' });
    }
  }
  // A push retired earlier yes votes; a verdict off its head with shots held.
  for (const check of ['passing', 'failing', 'pending']) for (const votes of [false, true]) {
    add('more', { check, head: 'on', merge: 'clean', hold: null, shots: false, first: false, votes, earlier: 3 });
    add('more', { check, head: 'on', merge: 'yes', hold: null, shots: true, first: false, votes, earlier: 3 });
  }
  // Merging: handed to the merge, and merged but not live yet.
  for (const bot of ['none', 'fixing', 'revising', 'fix_queued', 'question', 'question_closed']) {
    for (const merged of [false, true]) add('merging', { status: 'merging', check: 'passing', head: 'on', merge: 'clean', hold: null, merged, bot });
  }
  return cases;
}

// ── Requests with no change of the bot's up for a vote ────────────────────

function requestCases() {
  const fresh = { app_id: 1, issue_number: 7, app_slug: 'demo', requester_id: 9, request_at: T.request_at, request_closed: false };
  const looked = { ...fresh, run_id: 11, mode: 'live', run_at: T.run_at };
  const ready = { ...looked, verdict: 'ready', build_ok: null, run_proposal: null };
  const queue = { queue_id: 3, enqueued_at: T.enqueued_at, started_at: null, queue_reason: 'new', queue_place: 2, queue_priority: 5 };
  const build = { ...ready, build_session_id: 400, build_status: 'active', build_started_at: T.build_started_at, build_last_activity: T.build_last_activity };
  const lc = (status, more = {}) => ({
    lc_id: 300, lc_status: status, lc_by: 'ada', lc_check_state: 'passing', lc_checks_at: T.lc_checks_at, lc_check_phase: null,
    lc_merge_conflict_state: null, lc_integration_merges_clean: true, lc_integration_block_reasons: [],
    lc_promoted_at: T.lc_promoted_at, lc_merged_at: T.lc_merged_at, lc_live_at: null, lc_last_activity_at: T.lc_last_activity_at,
    lc_created_at: T.lc_created_at, lc_update_coming: null, lc_update_failed: null, lc_votes_in: false, lc_earlier_yes: 0, ...more,
  });
  const lcFacts = (status, more = {}) => ({
    id: 300, app_id: 1, user_id: 12, status, pr_number: 44, is_headless: false, source: 'native', check_state: 'passing',
    check_phase: null, checks_at: T.lc_checks_at, checks_commit_sha: HEAD, reviewed_head_sha: HEAD, imported_pr_head_sha: null,
    merge_conflict_state: null, integration_merges_clean: true, integration_block_reasons: [], failed_checks: null,
    shots_state: null, shots_run_id: null, shots_detail: null, shots_updated_at: null, first_version: false, votes_in: false,
    earlier_yes: 0, flake_fixing: false, update_coming: null, update_failed: null, promoted_at: T.lc_promoted_at,
    merged_at: T.lc_merged_at, live_at: null, created_at: T.lc_created_at, last_activity_at: T.lc_last_activity_at,
    has_requests: true, offers: [], ...more,
  });
  const list = {
    // Not read yet, queued, held.
    'nothing known': fresh,
    'looked, nothing came of it (skip)': { ...looked, verdict: 'skip' },
    'reading': { ...fresh, ...queue, started_at: T.started_at },
    'reading a reply': { ...looked, verdict: 'question', ...queue, started_at: T.started_at, reply_id: 8, reply_at: T.reply_at, reply_user_id: 9 },
    'reply about to be read, read queued': { ...looked, verdict: 'question', ...queue, reply_id: 8, reply_at: T.reply_at, reply_user_id: 9 },
    'reply about to be read, nothing queued': { ...looked, verdict: 'question', reply_id: 8, reply_at: T.reply_at, reply_user_id: 9 },
    'queued': { ...fresh, ...queue },
    'queued, no place': { ...fresh, ...queue, queue_place: null },
    'queued, asked for': { ...fresh, ...queue, queue_priority: 0 },
    'queued, held for the first version': { ...fresh, ...queue, held_first_version: true },
    'waiting, held for the first version': { ...fresh, held_first_version: true },
    'queued for credit': { ...ready, ...queue, queue_reason: 'credit_wait', build_session_id: 400, build_status: 'archived' },
    'queued for credit, claimed': { ...ready, ...queue, queue_reason: 'credit_wait', claimed_by: 'ada', claimed_at: T.claimed_at },
    'queued to write its plan again': { ...ready, build_ok: false, build_error: 'no plan could be written (timeout)', ...queue, queue_reason: 'plan_retry' },
    'queued after a failed plan': { ...looked, verdict: 'ready', build_ok: false, build_error: 'only part of a spec', ...queue },
    'on hold until Monday': { ...fresh, ...queue, held_until: T.hold_until, held_reason: 'allowance' },
    'paused after errors': { ...fresh, ...queue, held_until: T.hold_until, held_reason: 'cooldown' },
    'on hold, held for the first version': { ...fresh, ...queue, held_until: T.hold_until, held_reason: 'allowance', held_first_version: true },
    // Found ready: the build line.
    'held: project builds': { ...ready, cap_suppressed: 'builds_per_app', held_place: 2 },
    'held: changes waiting': { ...ready, cap_suppressed: 'proposals_per_app', held_place: 0 },
    'held: claimed first': { ...ready, cap_suppressed: 'builds_per_app', claimed_by: 'ada', claimed_at: T.claimed_at },
    'held: claimed after the look': { ...ready, cap_suppressed: 'builds_per_app', claimed_by: 'ada', claimed_at: T.late_claimed_at },
    'held: a person is building it': { ...ready, cap_suppressed: 'builds_per_app', ...lc('active') },
    'held: planning with you': { ...ready, cap_suppressed: 'builds_per_app', awaiting_plan: true },
    'plan waits for Build it (first version)': { ...ready, plan_waiting_at: T.plan_waiting_at },
    'build waits its turn': { ...ready, build_waiting_at: T.build_waiting_at, build_place: 3 },
    'build waits its turn, no place': { ...ready, build_waiting_at: T.build_waiting_at },
    'build waits its turn, planning with you': { ...ready, build_waiting_at: T.build_waiting_at, awaiting_plan: true },
    'starting': { ...ready, run_at: T.started_at },
    'stalled': { ...ready, run_at: T.stale_run_at },
    'build session archived': { ...build, build_status: 'archived' },
    'reviewing': { ...build, review_state: 'reviewing', review_round: 2, review_max_rounds: 3, review_started_at: T.review_started_at },
    'proposing (paused)': { ...build, build_status: 'paused' },
    'proposing (promoted)': { ...build, build_status: 'promoted' },
    'building (plan posted)': { ...build, spec_at: T.spec_at },
    'building (build turn)': { ...build, build_turn_mode: 'build', build_turn_at: T.build_turn_at },
    'planning': build,
    'closed while ready, no build yet': { ...ready, request_closed: true, closed_at: T.closed_at },
    'closed while building': { ...build, spec_at: T.spec_at, request_closed: true, closed_at: T.closed_at },
    // The requester's move.
    'plan waits': { ...ready, plan_waiting_at: T.plan_waiting_at, build_session_id: 400, build_status: 'paused' },
    'plan waits, the plan look asked': { ...ready, plan_waiting_at: T.plan_waiting_at, build_session_id: 400, build_status: 'paused', question_at: T.question_at },
    'plan waits, an older question': { ...ready, plan_waiting_at: T.plan_waiting_at, build_session_id: 400, build_status: 'paused', question_at: T.older_question_at },
    'question open': { ...looked, verdict: 'question', question_at: T.question_at },
    'question open, request closed': { ...looked, verdict: 'question', question_at: T.question_at, request_closed: true, closed_at: T.closed_at },
    'question verdict, none open': { ...looked, verdict: 'question' },
    'planning with you': { ...fresh, awaiting_plan: true },
    'planning with you, queued': { ...fresh, ...queue, awaiting_plan: true },
    // Handed back, stopped, closed.
    'already works': { ...looked, verdict: 'person', run_already_done: true, run_reason: 'It already does that. See the list.' },
    'decide': { ...looked, verdict: 'person', run_reason: 'It needs a person to decide. More follows.' },
    'decide, no reason': { ...looked, verdict: 'person' },
    'decide, claimed': { ...looked, verdict: 'person', claimed_by: 'ada', claimed_at: T.late_claimed_at },
    'build stopped': { ...looked, verdict: 'ready', build_ok: false, build_error: 'the build ran past its time limit' },
    'build stopped, its own session paused': { ...looked, verdict: 'ready', build_ok: false, build_error: 'x', build_session_id: 400, lc_id: 400, lc_status: 'paused', lc_by: null },
    'build skipped': { ...looked, verdict: 'ready', build_ok: false, build_error: 'skipped: answered meanwhile' },
    'build blocked': { ...looked, verdict: 'ready', build_ok: false, build_error: 'blocked: it cannot be built as written', run_reason: 'No such screen.' },
    'empty': { ...looked, verdict: 'empty' },
    'look failed': { ...looked, verdict: 'failed' },
    'closed': { ...looked, verdict: 'skip', request_closed: true, closed_at: T.closed_at },
    'closed, decide': { ...looked, verdict: 'person', request_closed: true, closed_at: T.closed_at },
    'claimed, nothing else': { ...looked, verdict: 'skip', claimed_by: 'ada', claimed_at: T.claimed_at },
    'plan failed, retry owed': { ...looked, verdict: 'ready', build_ok: false, build_error: 'no plan could be written (x)', build_last_activity: T.started_at },
    'plan failed, retry was read once': { ...looked, verdict: 'ready', build_ok: false, build_error: 'no plan could be written (x)', build_last_activity: T.started_at, run_read_reason: 'plan_retry' },
    'plan failed long ago': { ...looked, verdict: 'ready', build_ok: false, build_error: 'no plan could be written (x)', build_last_activity: T.run_at },
    // The bot's change no longer open.
    'bot change closed': { ...looked, verdict: 'ready', build_ok: true, run_proposal: 500, proposal_session_id: 500, proposal_status: 'archived', proposal_at: T.proposal_at, proposal_closed_at: T.proposal_closed_at },
    'bot change closed, a newer look decided': { ...looked, verdict: 'person', run_proposal: null, proposal_session_id: 500, proposal_status: 'archived', proposal_at: T.proposal_at },
    'bot change taken back to Underway': { ...looked, verdict: 'ready', build_ok: true, run_proposal: 500, proposal_session_id: 500, proposal_status: 'active', proposal_at: T.proposal_at },
    'bot change closed, a person\'s up for a vote': { ...looked, verdict: 'ready', build_ok: true, run_proposal: 500, proposal_session_id: 500, proposal_status: 'archived', proposal_at: T.proposal_at, ...lc('promoted') },
    'bot change live': { ...looked, verdict: 'ready', build_ok: true, run_proposal: 500, proposal_session_id: 500, proposal_status: 'merged', proposal_at: T.proposal_at, merged_at: T.live_at },
    'bot change live, an older queue row': { ...looked, verdict: 'ready', build_ok: true, run_proposal: 500, proposal_session_id: 500, proposal_status: 'merged', proposal_at: T.proposal_at, merged_at: T.live_at, ...queue },
  };
  // A person's change for it, by the row's own columns and by the change's facts.
  for (const status of ['active', 'paused', 'promoted', 'merging', 'merged']) {
    list[`a person's change: ${status}`] = { ...fresh, ...lc(status) };
    list[`a person's change, its facts read: ${status}`] = { ...fresh, ...lc(status), lc_facts: lcFacts(status) };
    list[`a person's change, nobody named: ${status}`] = { ...fresh, ...lc(status, { lc_by: null }) };
  }
  list['a person\'s change: failing'] = { ...fresh, ...lc('promoted', { lc_check_state: 'failing' }), lc_facts: lcFacts('promoted', { check_state: 'failing', failed_checks: 2 }) };
  list['a person\'s change: conflicting'] = { ...fresh, ...lc('promoted', { lc_merge_conflict_state: 'conflict' }), lc_facts: lcFacts('promoted', { merge_conflict_state: 'conflict' }) };
  list['a person\'s change: votes in'] = { ...fresh, ...lc('promoted', { lc_votes_in: true }), lc_facts: lcFacts('promoted', { votes_in: true }) };
  list['a person\'s change: an update queued'] = { ...fresh, ...lc('promoted', { lc_update_coming: 'queued' }), lc_facts: lcFacts('promoted', { update_coming: 'queued' }) };
  list['a person\'s change: live'] = { ...fresh, ...lc('merged', { lc_live_at: T.lc_live_at }), lc_facts: lcFacts('merged', { live_at: T.lc_live_at }) };
  list['a person\'s change, after a decide'] = { ...looked, verdict: 'person', ...lc('promoted') };
  return Object.entries(list).map(([n, row]) => ({ group: 'request.other', name: n, a: {}, kind: 'request', row, change: null }));
}

// ── Changes of their own ───────────────────────────────────────────────────

function ownChangeCases() {
  const base = changeFacts({ check: 'passing', head: 'on', merge: 'clean', hold: null }).change;
  const list = {
    'active': { ...base, status: 'active' },
    'paused': { ...base, status: 'paused' },
    'merging': { ...base, status: 'merging' },
    'merged, not live': { ...base, status: 'merged', merged_at: T.merged_at },
    'merged and live': { ...base, status: 'merged', merged_at: T.merged_at, live_at: T.live_at },
    'closed': { ...base, status: 'closed' },
    'archived': { ...base, status: 'archived' },
    'no status': { ...base, status: null },
    'checks running, an estimate': { ...base, check_state: 'running', check_phase: 'testing', checks_estimate: { buildMs: 600000, checksMs: 1200000 } },
    'checks queued, an estimate': { ...base, check_state: 'pending', check_phase: 'queued', checks_estimate: { buildMs: 600000, checksMs: 1200000 } },
    'checks running past the estimate': { ...base, check_state: 'running', check_phase: 'testing', checks_estimate: { buildMs: 60000, checksMs: 60000 } },
  };
  return Object.entries(list).map(([n, change]) => ({ group: 'change.other', name: n, a: {}, kind: 'change', change }));
}

function allCases() {
  return [...changeCases(), ...requestCases(), ...ownChangeCases()];
}

// ── What the derive says, written short ────────────────────────────────────

/**
 * One case's derived row as the store would hold it, from the work-state
 * module handed in: a request's from its facts row and, when the refresh
 * read them, its change's own facts; a change's from its own.
 */
function subject(ws, c) {
  if (c.kind === 'change') return ws.deriveChange(c.change, { now: NOW });
  // The refresh hands a request's derive its change's own facts; a request
  // derived alone (no `change`) reads them off its own row.
  return ws.derive(c.row, { now: NOW, change: c.change });
}

// (The recording was made with the composition the refresh did then: a
// request derived up for a vote whose change was not open for votes took
// its change's state.)

// placeFor lists a live item for a week by the clock: read it at the cases' own time.
function atNow(fn) {
  const real = Date.now;
  Date.now = () => NOW.getTime();
  try { return fn(); } finally { Date.now = real; }
}

/** A derived state as fields a difference can be named by. */
function fieldsOf(ws, st) {
  const words = ws.phrasesOf(st) || {};
  const phrase = (p) => (p ? p.id.replace(/^core:work\./, '') + (p.values ? JSON.stringify(p.values) : '') : '');
  const bot = ws.botWorkOf(st);
  return {
    stage: st.stage,
    why: st.why || '',
    reason: st.reason || '',
    line: st.line ? JSON.stringify(st.line) : '',
    whoseMove: st.whoseMove || '',
    since: st.since ? LABEL.get(st.since) || st.since : '',
    words: [phrase(words.stage), phrase(words.stageOthers), phrase(words.line)].join(' / '),
    place: atNow(() => `${ws.placeFor(st, { requester: true }) || '-'},${ws.placeFor(st, { own: true }) || '-'},${ws.placeFor(st, {}) || '-'}`),
    bot: bot ? [bot.what, bot.held ? 'held' : '', bot.turn ? 'turn' : '', bot.plan ? 'plan' : ''].filter(Boolean).join('+') : '',
    busy: ws.busyNow(st) ? 'busy' : '',
  };
}
const FIELDS = Object.freeze(['stage', 'why', 'reason', 'line', 'whoseMove', 'since', 'words', 'place', 'bot', 'busy']);
const write = (fields) => FIELDS.map((f) => fields[f]).join(' | ');
const read = (text) => Object.fromEntries(String(text).split(' | ').map((v, i) => [FIELDS[i], v]));

/** Record every case: the distinct outputs, and each case's by position. */
function record(ws, derive = subject) {
  const cases = allCases();
  const outputs = [];
  const index = new Map();
  const seq = cases.map((c) => {
    const text = write(fieldsOf(ws, derive(ws, c)));
    if (!index.has(text)) { index.set(text, outputs.length); outputs.push(text); }
    return index.get(text);
  });
  const names = crypto.createHash('sha1').update(cases.map((c) => `${c.group}: ${c.name}`).join('\n')).digest('hex');
  return { cases: cases.length, names, outputs, seq };
}

module.exports = { NOW, T, allCases, subject, fieldsOf, FIELDS, write, read, record };

if (require.main === module) {
  const fs = require('node:fs');
  const out = record(require('../../src/services/work-state'));
  // One output a line, and the sequence wrapped, so a diff of a recording reads.
  const seq = [];
  for (let i = 0; i < out.seq.length; i += 40) seq.push(`    ${out.seq.slice(i, i + 40).join(',')}`);
  fs.writeFileSync(process.argv[2], `{
  "cases": ${out.cases},
  "names": "${out.names}",
  "outputs": [
${out.outputs.map((o) => `    ${JSON.stringify(o)}`).join(',\n')}
  ],
  "seq": [
${seq.join(',\n')}
  ]
}
`);
  process.stdout.write(`${out.cases} cases, ${out.outputs.length} distinct outputs\n`);
}
