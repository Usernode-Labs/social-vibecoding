'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../src/services/shots-state');
const contract = require('../src/services/visible-changes');
const shots = require('../src/services/shots-files');
const { intent } = require('./fixtures/shots');

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

// A shots verdict as the orchestrator folds it: one change ready, one skipped.
function shotsVerdict(stories = [
  { id: 'invite-suggestions', status: 'ready', files: 2 },
]) {
  return { passed: stories.some((story) => story.status === 'ready'), mode: shots.SHOTS_MODE, runs: 1, stories };
}

test('controlled failure shots is clearly labeled in reviewer-visible flow', () => {
  const declaration = intent();
  declaration.stories[0].intent.controlledFailurePath = '/api/lists/demo';
  declaration.stories[0].intent.steps.unshift(contract.CONTROLLED_FAILURE_LABEL);
  const claims = state.claimsFromIntent(contract.parseIntent(declaration));
  assert.equal(claims[0].steps[0], contract.CONTROLLED_FAILURE_LABEL);
});

test('a run moves exploring -> reviewing -> verified and nothing re-enters replaying', () => {
  const allowed = [
    ['planned', 'provisioning'],
    ['provisioning', 'exploring'],
    ['exploring', 'reviewing'],
    ['reviewing', 'verified'],
    ['verified', 'stale'],
    ['failed', 'stale'],
    ['exploring', 'failed'],
    ['exploring', 'cancelled'],
    ['reviewing', 'failed'],
    ['reviewing', 'cancelled'],
  ];
  for (const [from, to] of allowed) assert.doesNotThrow(() => state.assertTransition(from, to), `${from} -> ${to}`);
  for (const [from, to] of [
    // The retired replay loop.
    ['exploring', 'replaying'], ['replaying', 'replaying'], ['replaying', 'reviewing'],
    ['reviewing', 'replaying'], ['replaying', 'verified'],
    // Shots are always stored (reviewing) before they are published.
    ['provisioning', 'reviewing'], ['exploring', 'verified'], ['planned', 'verified'],
    ['failed', 'planned'], ['stale', 'verified'], ['cancelled', 'planned'],
    ['verified', 'reviewing'], ['exploring', 'nonsense'],
  ]) {
    assert.throws(() => state.assertTransition(from, to), { code: 'invalid_shots_transition' }, `${from} -> ${to}`);
  }
});

test('a legacy replaying row can only be failed or cancelled by recovery', () => {
  assert.ok(state.STATES.includes('replaying'));
  assert.deepEqual([...state.TRANSITIONS.replaying].sort(), ['cancelled', 'failed']);
  for (const [from, targets] of Object.entries(state.TRANSITIONS)) {
    if (from === 'replaying') continue;
    assert.equal(targets.has('replaying'), false, `${from} must not lead to replaying`);
  }
});

test('terminal-state and required-shots policy distinguish an explicit no-impact rationale', () => {
  assert.equal(state.isTerminal('verified'), true);
  assert.equal(state.isTerminal('reviewing'), false);
  const none = { version: 1, impact: 'none', rationale: 'Backend-only.', stories: [] };
  assert.equal(state.requiredForIntent(none), false);
  assert.equal(state.requiredForIntent(none, { heuristicUi: true }), false);
  assert.equal(state.requiredForIntent(null, { heuristicUi: true }), true);
  assert.equal(state.requiredForIntent(null), false);
  assert.equal(state.requiredForIntent({ ...none, impact: 'ui' }), true);
  assert.deepEqual(state.missingIntentDetail({ headSha: 'a'.repeat(40) }), {
    version: 1,
    required: true,
    impact: null,
    rationale: null,
    claims: [],
    headSha: 'a'.repeat(40),
    reason: 'This proposal appears to change the UI but has not declared the change for before/after shots yet.',
  });
});

test('an intent conflict does not offer a retry that would repeat the same failure', () => {
  const row = {
    state: 'failed', failure_code: 'visible_changes_conflict',
    intent: { version: 1, impact: 'none', rationale: 'Error UI changed.', stories: [] },
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
  };
  assert.equal(state.runSummary(row).repairAvailable, false);
  assert.equal(state.runSummary({ ...row, failure_code: 'shots_capture_incomplete' }).repairAvailable, true);
  assert.equal(state.runSummary({ ...row, state: 'exploring', failure_code: null }).repairAvailable, false);
});

test('recordIntentInTransaction appends the declaration in its caller-owned transaction, and waits for nothing', async (t) => {
  // PR import owns the transaction that inserts the proposal row: the
  // declaration is appended to the shots machine in that same transaction,
  // and applies once it commits (src/workflow/shots/).
  const appended = [];
  state._setWorkflowForTests({ shotsDeclared: async (d) => { appended.push(d); return null; } });
  t.after(() => state._setWorkflowForTests(null));
  const client = {
    async connect() { throw new Error('a checked-out PoolClient must not be connected again'); },
    release() { throw new Error('the route retains ownership of its client'); },
    async query() { throw new Error('the declaration writes nothing itself'); },
  };
  const result = await state.recordIntentInTransaction(client, 42, intent(), { headSha: 'a'.repeat(40) });
  assert.equal(result.accepted, true);
  assert.equal(result.state, 'planned');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].db, client, 'appended inside the caller\'s transaction');
  assert.equal(appended[0].sessionId, 42);
  assert.equal(appended[0].head, 'a'.repeat(40));
  assert.deepEqual(appended[0].intent, contract.parseIntent(intent()), 'validated before it is appended');
  await assert.rejects(state.recordIntentInTransaction(client, 42, { version: 1, impact: 'ui', stories: [] }),
    'an invalid declaration is refused before anything is appended');
  assert.equal(appended.length, 1);
});

test('schema carries private revision-scoped runs, artifacts, session pointers and stale uniqueness', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS shot_runs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS shot_artifacts/);
  assert.match(schema, /shot_runs_verified_integrity_check/);
  assert.doesNotMatch(schema, /AND semantic_verdict IS NOT NULL AND completed_at/);
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS shots_state/);
  assert.match(schema, /idx_shot_runs_current_head[\s\S]*state NOT IN \('stale', 'cancelled'\)/);
  assert.match(schema, /COMMENT ON TABLE shot_runs IS 'staging:private'/);
  assert.match(schema, /COMMENT ON TABLE shot_artifacts IS 'staging:private'/);
});

// ── storeArtifacts: the fence between a run and the proposal's slot ──────

// ── The public summary ──────────────────────────────────────────────────

test('public run summary includes claims, artifact metadata and shot results but no plan or internal fixture', () => {
  const summary = state.runSummary({
    state: 'verified', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    intent: {
      version: 1, impact: 'ui', rationale: 'Visible change',
      stories: [{
        id: 'dialog', claim: 'The dialog is usable.', persona: 'member',
        viewports: [{ name: 'desktop' }],
        intent: { steps: ['Open dialog'], animation: 'none' },
      }, {
        id: 'toast', claim: 'A toast confirms saving.', persona: 'member',
        viewports: [{ name: 'desktop' }],
        intent: { steps: ['Press Save'], animation: 'none' },
      }],
    },
    hard_verdict: shotsVerdict([
      { id: 'dialog', status: 'ready', files: 2, note: 'The dialog\'s error line needs a failed save.' },
      { id: 'toast', status: 'skipped', reason: 'Saving needs a list the fixture does not have.' },
    ]),
    semantic_verdict: null,
    trace_summary: { runs: 2, relativePointer: true, captureMode: 'capture', progress: { phase: 'store_shots', at: 'now' } },
    repair_attempt: 1, plan_hash: 'c'.repeat(64), updated_at: new Date('2026-09-17T00:00:00Z'),
    replay_plan: { secret: 'must not escape' }, author_plan: { secret: 'must not escape' },
    fixture_fingerprint: 'private-fixture',
  }, [{ id: 'd'.repeat(32), storyId: 'dialog', side: 'base', variant: 'focus', media: 'png' }]);
  assert.equal(summary.state, 'verified');
  assert.equal(summary.claims[0].claim, 'The dialog is usable.');
  assert.equal(summary.artifactSummary.length, 1);
  assert.equal(summary.planHash, 'c'.repeat(64));
  assert.deepEqual(summary.progress, { phase: 'store_shots', at: 'now' });
  assert.deepEqual(summary.shotResults, [
    { id: 'dialog', status: 'ready', reason: null, note: 'The dialog\'s error line needs a failed save.' },
    { id: 'toast', status: 'skipped', reason: 'Saving needs a list the fixture does not have.', note: null },
  ]);
  assert.equal(summary.verifiedReason, null);
  for (const key of ['replayCount', 'repairCount', 'relativePointer', 'captureMode', 'claimResults', 'mode',
    'replayPlan', 'authorPlan', 'fixtureFingerprint', 'hardVerdict', 'traceSummary']) {
    assert.equal(Object.hasOwn(summary, key), false, key);
  }
  assert.doesNotMatch(JSON.stringify(summary), /must not escape|private-fixture/);
});

test('shot results come only from a shots verdict and carry nothing but id, status, reason and note', () => {
  const base = { state: 'verified', base_sha: BASE_SHA, head_sha: HEAD_SHA, intent: intent() };
  // Runs from before shots (replay verdicts) and runs without a verdict.
  for (const hard_verdict of [null, undefined, { passed: true, runs: 2 }, { passed: true, mode: 'replay', stories: [
    { id: 'invite-suggestions', status: 'ready' },
  ] }, 'shots']) {
    assert.deepEqual(state.runSummary({ ...base, hard_verdict }).shotResults, [], JSON.stringify(hard_verdict));
  }
  assert.deepEqual(state.runSummary({ ...base, hard_verdict: { mode: 'shots', passed: false } }).shotResults, []);

  const odd = state.runSummary({ ...base, hard_verdict: shotsVerdict([
    { id: 'ready-with-reason', status: 'ready', reason: 'ignored', files: 4 },
    { id: 'unknown-status', status: 'published' },
    { id: 'skipped-silently', status: 'skipped' },
    // A note belongs to shots people can see; a skipped change has none.
    { id: 'skipped-with-note', status: 'skipped', reason: 'No list.', note: 'ignored' },
  ]) });
  assert.deepEqual(odd.shotResults, [
    { id: 'ready-with-reason', status: 'ready', reason: null, note: null },
    { id: 'unknown-status', status: 'skipped', reason: null, note: null },
    { id: 'skipped-silently', status: 'skipped', reason: null, note: null },
    { id: 'skipped-with-note', status: 'skipped', reason: 'No list.', note: null },
  ]);
});

// The verdict keeps it ready with `unchanged: true` (shots-files.markUnchanged);
// read as plain ready, a change whose shots show no difference looked shot.
test('a ready change whose before and after came out the same reads unchanged, with its note', () => {
  const base = { state: 'verified', base_sha: BASE_SHA, head_sha: HEAD_SHA, intent: intent() };
  const summary = state.runSummary({ ...base, hard_verdict: shotsVerdict([
    { id: 'invite-suggestions', status: 'ready', files: 2, unchanged: true, note: 'any visible difference.' },
    { id: 'invite-empty', status: 'ready', files: 2 },
  ]) });
  assert.deepEqual(summary.shotResults, [
    { id: 'invite-suggestions', status: 'unchanged', reason: null, note: 'any visible difference.' },
    { id: 'invite-empty', status: 'ready', reason: null, note: null },
  ]);
  // Nothing that decides whether a change works reads it as failing.
  const row = { shots_state: 'verified', shots_detail: { ...summary, intent: intent() } };
  assert.deepEqual(state.brokenOnHead(row, HEAD_SHA), []);
});

test('problems the shots agent noticed are kept beside the results and never read as a change failing', () => {
  const notices = [
    { text: 'The sort control overlaps the Done heading.', change: 'invite-suggestions', screen: 'desktop', shot: 'screen', alsoBefore: true },
  ];
  const base = { state: 'verified', base_sha: BASE_SHA, head_sha: HEAD_SHA, intent: intent() };
  const summary = state.runSummary({ ...base, hard_verdict: { ...shotsVerdict([
    { id: 'invite-suggestions', status: 'ready', files: 2 },
  ]), notices } });
  assert.deepEqual(summary.shotNotices, notices);
  assert.deepEqual(summary.shotResults, [{ id: 'invite-suggestions', status: 'ready', reason: null, note: null }]);
  // Only a shots verdict carries them.
  for (const hard_verdict of [null, { passed: true, runs: 2, notices }, { mode: 'shots', notices: 'x' }]) {
    assert.deepEqual(state.runSummary({ ...base, hard_verdict }).shotNotices, [], JSON.stringify(hard_verdict));
  }
  // The proposal's copy of the run carries them, and nothing that decides
  // whether the change works reads them.
  const row = { shots_state: 'verified', shots_detail: { ...summary, intent: intent() } };
  assert.deepEqual(state.brokenOnHead(row, HEAD_SHA), []);
  const AppView = require('../public/js/app-view.js');
  assert.equal(AppView._shotsBrokenCount({ ...summary, state: 'verified' }), 0);
});

// ── Taking the shots again ──────────────────────────────────────────────

test('ids and revision checks are strict', () => {
  assert.match(state.newId(), /^[0-9a-f]{32}$/);
  assert.equal(state.validSha('a'.repeat(40)), true);
  assert.equal(state.validSha('A'.repeat(40)), false);
  assert.equal(state.validSha('a'.repeat(39)), false);
});

// #4575: a run that ended because another turn held the proposal's agent
// says so in plain words, even one stored with the worker's own wording.
test('a run the proposal\'s busy agent stopped reads in plain words, not the worker\'s', () => {
  const row = {
    state: 'failed', failure_code: 'durable_turn_persist_failed',
    failure_reason: 'execInWorker: durable active turn could not be persisted',
    intent: null, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
  };
  for (const code of ['durable_turn_persist_failed', 'durable_retry_persist_failed', 'session_busy', 'TURN_IN_FLIGHT']) {
    const summary = state.runSummary({ ...row, failure_code: code });
    assert.equal(summary.failureReason, state.AGENT_BUSY_REASON, code);
    assert.equal(summary.repairAvailable, true, 'Take the shots again stays');
  }
  assert.doesNotMatch(state.AGENT_BUSY_REASON, /execInWorker|durable|turn could not/);
  assert.equal(state.runSummary({ ...row, failure_code: 'shots_capture_incomplete', failure_reason: 'No shot saved.' })
    .failureReason, 'No shot saved.');
});
