'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../src/services/shots-view');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const ARTIFACT = 'd'.repeat(32);

function session(overrides = {}) {
  return {
    id: 42,
    source: 'native',
    reviewed_head_sha: HEAD,
    shots_state: 'verified',
    shots_detail: {
      impact: 'ui',
      rationale: 'The dialog changed.',
      headSha: HEAD,
    },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog', claim: 'The dialog shows suggestions.', persona: 'member',
      viewports: ['desktop'], steps: ['Open dialog'], baseState: 'present', animation: 'none',
    }],
    baseSha: BASE,
    headSha: HEAD,
    failureCode: null,
    failureReason: null,
    repairAvailable: false,
    planHash: 'e'.repeat(64),
    shotResults: [{ id: 'dialog', status: 'ready', reason: null }],
    verifiedReason: 'A model said the images show the claimed state.',
    artifactSummary: [{
      id: ARTIFACT, storyId: 'dialog', viewport: 'desktop', side: 'head',
      variant: 'focus', media: 'png', contentType: 'image/png', bytes: 120,
    }],
    ...overrides,
  };
}

test('a declared persona survives serialization, the guest included; anything else reads as a member', () => {
  const claim = run().claims[0];
  const persona = (value) => view.cleanClaims([{ ...claim, persona: value }])[0].persona;
  assert.deepEqual(['member', 'read_only_admin', 'full_admin', 'guest', 'owner'].map(persona),
    ['member', 'read_only_admin', 'full_admin', 'guest', 'member']);
});

test('verified shots exposes only authenticated artifact metadata for the exact head', () => {
  const result = view.serialize(run(), session(), 'demo-app', HEAD);
  assert.equal(result.state, 'verified');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].url,
    `/api/apps/demo-app/proposals/42/shots/${ARTIFACT}`);
  assert.equal(Object.hasOwn(result.artifacts[0], 'data'), false);
  assert.equal(result.claims[0].baseState, 'present');
  assert.deepEqual(result.shotResults, [{ id: 'dialog', status: 'ready', reason: null, note: null }]);
  // People judge the shots; no model verdict is ever passed through.
  assert.equal(result.verifiedReason, null);
  for (const key of ['replayCount', 'repairCount', 'relativePointer', 'captureMode', 'claimResults']) {
    assert.equal(Object.hasOwn(result, key), false, key);
  }
});

test('a newer head makes the whole set stale and suppresses every artifact', () => {
  const result = view.serialize(run(), session({ reviewed_head_sha: OTHER }), 'demo-app', OTHER);
  assert.equal(result.state, 'stale');
  assert.equal(result.failureCode, 'superseded');
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.shotResults, []);
  assert.match(result.failureReason, /newer revision of this proposal/i);
});

test('pending, failed, and malformed artifact rows never leak media URLs', () => {
  for (const state of ['planned', 'failed', 'reviewing']) {
    const result = view.serialize(run({ state }), session({ shots_state: state }), 'demo-app', HEAD);
    assert.deepEqual(result.artifacts, [], state);
    assert.deepEqual(result.shotResults, [], state);
  }
  assert.deepEqual(view.cleanArtifacts([{ ...run().artifactSummary[0], id: '../secret' }], {
    slug: 'demo-app', sessionId: 42, verified: true,
  }), []);
});

test('active progress shows the last stage only for the current proposal head', () => {
  const progress = { phase: 'build_revisions', at: '2026-09-22T18:42:00Z' };
  const active = run({ state: 'provisioning', progress });
  assert.deepEqual(view.serialize(active, session(), 'demo-app', HEAD).progress, progress);
  assert.equal(view.serialize(active, session({ reviewed_head_sha: OTHER }), 'demo-app', OTHER).progress, null);
});

test('snapshot serialization is truthful before a durable run exists', () => {
  const result = view.fromSnapshot(session({
    shots_state: 'planned',
    shots_detail: {
      required: true, impact: 'ui', rationale: 'Visible change', headSha: HEAD,
      claims: [{
        id: 'new-screen', claim: 'A new route is available.', persona: 'member',
        viewports: ['mobile'], steps: ['Open the route'], baseState: 'not_present', animation: 'none',
      }],
    },
  }), HEAD);
  assert.equal(result.state, 'planned');
  assert.equal(result.claims[0].baseState, 'not_present');
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.shotResults, []);
});

// ── #2601/#2558: the run that never started ──────────────────────────────
test('a planned run carries the recorded reason it never started, as its own field', () => {
  const s = session({
    shots_state: 'planned',
    shots_detail: {
      impact: 'ui',
      headSha: HEAD,
      notStartedReason: 'Visual change previews are not being run on this deployment.',
    },
  });
  const snapshot = view.fromSnapshot(s, HEAD);
  assert.equal(snapshot.state, 'planned');
  assert.equal(snapshot.notStartedReason,
    'Visual change previews are not being run on this deployment.');
  // It is a SIBLING of failureReason, not a reuse of it: a run that never
  // started has not failed, and the two reach different copy.
  assert.equal(snapshot.failureReason, null);

  const serialized = view.serialize(run({ state: 'planned', headSha: HEAD }), s, 'demo', HEAD);
  assert.equal(serialized.notStartedReason,
    'Visual change previews are not being run on this deployment.');
});

test('the not-started reason is dropped once the run moves on, and on a superseded revision', () => {
  const detail = {
    impact: 'ui',
    headSha: HEAD,
    notStartedReason: 'Visual change previews are not being run on this deployment.',
  };
  // A run under way owns its own state; a note about it not starting is
  // stale the moment it does.
  assert.equal(view.notStartedReason(
    { shots_state: 'exploring', shots_detail: detail }, false
  ), null);
  assert.equal(view.notStartedReason(
    { shots_state: 'verified', shots_detail: detail }, false
  ), null);
  // A newer revision superseded the attempt the note describes.
  assert.equal(view.notStartedReason(
    { shots_state: 'planned', shots_detail: detail }, true
  ), null);
  assert.equal(view.notStartedReason(
    { shots_state: 'planned', shots_detail: detail }, false
  ), detail.notStartedReason);
});

test('a planned run with nothing recorded reports no reason rather than an empty string', () => {
  const snapshot = view.fromSnapshot(session({
    shots_state: 'planned',
    shots_detail: { impact: 'ui', headSha: HEAD, notStartedReason: '   ' },
  }), HEAD);
  assert.equal(snapshot.notStartedReason, null);
});

// ── Before/after shots: per-change results and clips ─────────────────────

test('shot results are exposed only for the verified run on the current head', () => {
  const state = require('../src/services/shots-state');
  const row = {
    state: 'verified', base_sha: BASE, head_sha: HEAD, plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories: [
      { id: 'dialog', status: 'ready', files: 2, note: 'The error line needs a failed save.' },
      { id: 'empty', status: 'skipped', reason: 'No list exists for this persona.' },
    ] },
  };
  const summary = state.runSummary(row);
  const current = view.serialize(summary, session(), 'demo', HEAD);
  assert.deepEqual(current.shotResults, [
    { id: 'dialog', status: 'ready', reason: null, note: 'The error line needs a failed save.' },
    { id: 'empty', status: 'skipped', reason: 'No list exists for this persona.', note: null },
  ]);
  assert.deepEqual(view.serialize(summary, session(), 'demo', OTHER).shotResults, [],
    'a superseded run publishes no per-change results');
  for (const active of ['exploring', 'reviewing', 'failed']) {
    assert.deepEqual(view.serialize({ ...summary, state: active }, session(), 'demo', HEAD).shotResults, [], active);
  }
  // A replay-era run has no per-change results.
  const replayRun = state.runSummary({ ...row, hard_verdict: { passed: true, runs: 2, stories: [] } });
  assert.deepEqual(view.serialize(replayRun, session(), 'demo', HEAD).shotResults, []);
  assert.deepEqual(view.fromSnapshot({ shots_state: 'planned', shots_detail: { required: true } }, null).shotResults, []);
});

test('an unchanged result is served as unchanged, with its note and no reason', () => {
  const state = require('../src/services/shots-state');
  const summary = state.runSummary({
    state: 'verified', base_sha: BASE, head_sha: HEAD, plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories: [
      { id: 'dialog', status: 'ready', files: 2, unchanged: true, note: 'any visible difference.' },
    ] },
  });
  assert.deepEqual(view.serialize(summary, session(), 'demo', HEAD).shotResults, [
    { id: 'dialog', status: 'unchanged', reason: null, note: 'any visible difference.' },
  ]);
  assert.deepEqual(view.cleanShotResults([
    { id: 'dialog', status: 'unchanged', reason: 'ignored', note: 'The \\"Save\\" screens came out the same.' },
  ]), [{ id: 'dialog', status: 'unchanged', reason: null, note: 'The "Save" screens came out the same.' }]);
});

test('shot results are cleaned before they reach any reviewer surface', () => {
  assert.deepEqual(view.cleanShotResults(null), []);
  assert.deepEqual(view.cleanShotResults('ready'), []);
  // Never more than the three changes a declaration may carry, and never an
  // id that is not a declared-change slug.
  assert.deepEqual(view.cleanShotResults([
    { id: '../escape', status: 'ready' }, { id: 'one', status: 'ready' },
    { id: 'two', status: 'ready' }, { id: 'three', status: 'ready' },
  ]).map(({ id }) => id), ['one', 'two']);
  const cleaned = view.cleanShotResults([
    { id: 'ready-one', status: 'ready', reason: 'ignored for a ready change', files: 4, note: 'Left out. '.repeat(100) },
    { id: 'odd-status', status: 'published', reason: 'Clipped. '.repeat(200), note: 'ignored for a skipped change' },
    { id: 'no-reason', status: 'skipped', reason: { html: '<b>x</b>' } },
  ]);
  assert.deepEqual(cleaned.map(({ id, status }) => [id, status]),
    [['ready-one', 'ready'], ['odd-status', 'skipped'], ['no-reason', 'skipped']]);
  assert.equal(cleaned[0].reason, null);
  assert.equal(cleaned[0].note.length, 500, 'a ready change keeps its note, bounded');
  assert.equal(cleaned[1].reason.length, 1000);
  assert.equal(cleaned[1].note, null, 'a skipped change carries no note');
  assert.equal(cleaned[2].reason, null);
  assert.equal(view.cleanShotResults([{ id: 'x', status: 'ready', note: { html: '<b>x</b>' } }])[0].note, null);
  for (const result of cleaned) assert.deepEqual(Object.keys(result).sort(), ['id', 'note', 'reason', 'status']);
});

// control_request and upload_file: what the shots agent did to both builds
// to reach a change, in the fixed shapes shots-files.condition records.
test('what the shots agent did to reach a change reaches the view as recorded, and nothing else', () => {
  const state = require('../src/services/shots-state');
  const conditions = [
    { kind: 'request_held', request: '/api/items?page=1' },
    { kind: 'sample_file', files: ['landscape.png', 'table.csv'] },
  ];
  const row = {
    state: 'verified', base_sha: BASE, head_sha: HEAD, plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories: [
      { id: 'dialog', status: 'ready', files: 2, conditions },
      { id: 'empty', status: 'skipped', reason: 'No list exists for this persona.' },
    ] },
  };
  const summary = state.runSummary(row);
  assert.deepEqual(summary.shotResults[0].conditions, conditions);
  assert.equal('conditions' in summary.shotResults[1], false);
  assert.deepEqual(view.serialize(summary, session(), 'demo', HEAD).shotResults, [
    { id: 'dialog', status: 'ready', reason: null, note: null, conditions },
    { id: 'empty', status: 'skipped', reason: 'No list exists for this persona.', note: null },
  ]);
  const [cleaned] = view.cleanShotResults([{ id: 'dialog', status: 'ready', conditions: [
    { kind: 'request_failed', request: '/api/items', extra: '<b>x</b>' },
    { kind: 'request_held', request: 'https://evil.example/api/items' },
    { kind: 'sample_file', files: ['../state/member.json', 'portrait.png'] },
    { kind: 'evaluate', request: '/api/items' },
    { kind: 'sample_file', files: [] },
  ] }]);
  assert.deepEqual(cleaned.conditions, [
    { kind: 'request_failed', request: '/api/items' },
    { kind: 'sample_file', files: ['portrait.png'] },
  ]);
  assert.equal('conditions' in view.cleanShotResults([{ id: 'x', status: 'ready', conditions: 'held' }])[0], false);
});

test('problems the shots agent noticed reach the view only for the verified run on the current head', () => {
  const state = require('../src/services/shots-state');
  const notices = [
    { text: 'The \\"Newest\\" sort control overlaps the Done heading.', change: 'dialog', screen: 'desktop', shot: 'screen', alsoBefore: true },
    { text: 'The table is cut off.', change: 'dialog', screen: 'phone', shot: null, alsoBefore: false },
  ];
  const row = {
    state: 'verified', base_sha: BASE, head_sha: HEAD, plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories: [{ id: 'dialog', status: 'ready', files: 2 }], notices },
  };
  const summary = { ...state.runSummary(row), claims: run().claims };
  assert.deepEqual(summary.shotNotices, notices, 'the stored summary keeps them as the verdict has them');
  const current = view.serialize(summary, session(), 'demo', HEAD);
  assert.deepEqual(current.shotNotices, [
    { text: 'The "Newest" sort control overlaps the Done heading.', change: 'dialog', screen: 'desktop', shot: 'screen', alsoBefore: true },
    { text: 'The table is cut off.', change: 'dialog', screen: 'phone', shot: null, alsoBefore: false },
  ]);
  assert.deepEqual(current.shotResults, [{ id: 'dialog', status: 'ready', reason: null, note: null }],
    'the results do not carry them');
  assert.deepEqual(view.serialize(summary, session(), 'demo', OTHER).shotNotices, [], 'a superseded run shows none');
  for (const other of ['exploring', 'reviewing', 'failed']) {
    assert.deepEqual(view.serialize({ ...summary, state: other }, session(), 'demo', HEAD).shotNotices, [], other);
  }
  // Runs from before notices, and a proposal with no run yet, have none.
  assert.deepEqual(state.runSummary({ ...row, hard_verdict: { ...row.hard_verdict, notices: undefined } }).shotNotices, []);
  assert.deepEqual(view.serialize(run(), session(), 'demo', HEAD).shotNotices, []);
  assert.deepEqual(view.fromSnapshot({ shots_state: 'planned', shots_detail: { required: true } }, null).shotNotices, []);
});

// A project's first version (services/shots-starter.js): its before was the
// starter template's placeholder, so the run took the after side only and
// the card says so.
test('an after-only run reaches the view only as the verified run on the current head', () => {
  const state = require('../src/services/shots-state');
  const row = {
    state: 'verified', base_sha: BASE, head_sha: HEAD, plan_hash: 'c'.repeat(64),
    intent: null, trace_summary: { runs: 1 },
    hard_verdict: {
      passed: true, mode: 'shots', runs: 1, stories: [{ id: 'dialog', status: 'ready', files: 1 }], afterOnly: true,
    },
  };
  const summary = { ...state.runSummary(row), claims: run().claims };
  assert.equal(summary.afterOnly, true);
  assert.equal(view.serialize(summary, session(), 'demo', HEAD).afterOnly, true);
  assert.equal(view.serialize(summary, session(), 'demo', OTHER).afterOnly, false, 'a superseded run says nothing');
  assert.equal(view.serialize({ ...summary, state: 'exploring' }, session(), 'demo', HEAD).afterOnly, false);
  // Every other run, and a proposal with no run yet, takes both sides.
  assert.equal(state.runSummary({ ...row, hard_verdict: { ...row.hard_verdict, afterOnly: undefined } }).afterOnly, false);
  assert.equal(state.runSummary({ ...row, hard_verdict: { ...row.hard_verdict, afterOnly: 'yes' } }).afterOnly, false);
  assert.equal(view.serialize(run(), session(), 'demo', HEAD).afterOnly, false);
  assert.equal(view.fromSnapshot({ shots_state: 'planned', shots_detail: { required: true } }, null).afterOnly, false);
});

test('noticed problems are cleaned before they reach any reviewer surface', () => {
  const claims = run().claims;
  assert.deepEqual(view.cleanShotNotices(null, claims), []);
  assert.deepEqual(view.cleanShotNotices('broken', claims), []);
  const cleaned = view.cleanShotNotices([
    { text: 'Too long. '.repeat(60), change: 'dialog', screen: 'desktop', shot: 'clip', alsoBefore: 'yes' },
    { text: 'Not a change of this run.', change: 'someone-elses', screen: 'desktop' },
    { text: 'Not a screen name.', change: 'dialog', screen: '../desktop' },
    { text: '   ', change: 'dialog', screen: 'desktop' },
    { text: { html: '<b>x</b>' }, change: 'dialog', screen: 'desktop' },
    { text: 'Kept.', change: 'dialog', screen: 'phone', alsoBefore: false, extra: 'dropped' },
  ], claims);
  assert.deepEqual(cleaned.map((entry) => entry.text.slice(0, 9)), ['Too long.', 'Kept.']);
  assert.equal(cleaned[0].text.length, 300);
  assert.equal(cleaned[0].shot, null, 'only a screen or an element shot');
  assert.equal(cleaned[0].alsoBefore, 'unknown', 'only true, false or unknown');
  assert.equal(cleaned[1].alsoBefore, false);
  for (const entry of cleaned) assert.deepEqual(Object.keys(entry).sort(), ['alsoBefore', 'change', 'screen', 'shot', 'text']);
  const many = Array.from({ length: 8 }, (_, i) => ({ text: `Problem ${i}.`, change: 'dialog', screen: 'desktop' }));
  assert.equal(view.cleanShotNotices(many, claims).length, 5);
});

function artifact(overrides = {}) {
  return {
    id: ARTIFACT, storyId: 'dialog', viewport: 'desktop', side: 'head',
    variant: 'context', media: 'png', contentType: 'image/png', bytes: 120,
    ...overrides,
  };
}

function kept(item) {
  return view.cleanArtifacts([item], { slug: 'demo-app', sessionId: 42, verified: true });
}

test('a clip is one WebM per side; a legacy paired animation still plays', () => {
  for (const side of ['base', 'head']) {
    const [clip] = kept(artifact({ side, variant: 'animation', media: 'webm', contentType: 'video/webm' }));
    assert.ok(clip, side);
    assert.equal(clip.side, side);
    assert.equal(clip.media, 'webm');
    assert.equal(clip.url, `/api/apps/demo-app/proposals/42/shots/${ARTIFACT}`);
  }
  // Runs from before shots stored one paired before/after recording.
  for (const [media, contentType] of [['webm', 'video/webm'], ['gif', 'image/gif']]) {
    assert.equal(kept(artifact({ side: 'paired', variant: 'animation', media, contentType })).length, 1, media);
  }
  assert.equal(kept(artifact({ variant: 'focus' })).length, 1);
  assert.equal(kept(artifact({ side: 'base' })).length, 1);
});

test('mismatched media is refused: no PNG animation, no WebM shot, no paired still', () => {
  for (const [label, item] of [
    ['png animation', artifact({ variant: 'animation', media: 'png' })],
    ['paired png animation', artifact({ side: 'paired', variant: 'animation', media: 'png' })],
    ['gif clip on one side', artifact({ variant: 'animation', media: 'gif', contentType: 'image/gif' })],
    ['webm context', artifact({ variant: 'context', media: 'webm', contentType: 'video/webm' })],
    ['webm focus', artifact({ variant: 'focus', media: 'webm', contentType: 'video/webm' })],
    ['paired still', artifact({ side: 'paired' })],
    ['content type disagrees', artifact({ variant: 'animation', media: 'webm', contentType: 'image/png' })],
    ['unknown side', artifact({ side: 'before' })],
    ['unknown variant', artifact({ variant: 'clip', media: 'webm', contentType: 'video/webm' })],
  ]) {
    assert.deepEqual(kept(item), [], label);
  }
  assert.deepEqual(view.cleanArtifacts([artifact({ variant: 'animation', media: 'webm', contentType: 'video/webm' })], {
    slug: 'demo-app', sessionId: 42, verified: false,
  }), [], 'an unverified run serves no clip');
});

test('a failed run the shots machine takes again says so, and is not offered for a manual retry', () => {
  // src/workflow/shots/: a platform fault's one retry is scheduled by the
  // machine, which marks the run so as it fails it (automaticRetry).
  const state = require('../src/services/shots-state');
  const row = {
    id: 'f'.repeat(32), session_id: 42, state: 'failed', base_sha: BASE, head_sha: HEAD,
    failure_code: 'shots_failed', intent: null,
    failure_reason: 'No answer from Postgres within 90 seconds, psql\'s time limit, so psql was stopped.',
    trace_summary: { platformFault: { kind: 'database' }, automaticRetry: true },
  };
  const open = view.serialize(state.runSummary(row, []), session({ status: 'paused' }), 'demo', HEAD);
  assert.equal(open.automaticRetryPending, true);
  assert.equal(open.repairAvailable, false, 'the machine starts it; a second way to start it is not offered');
  assert.equal(open.failureCode, 'shots_failed');
  // The retry that failed again, or a failure the machine does not take
  // again, carries no mark: a person can take them again.
  const spent = view.serialize(state.runSummary({ ...row, trace_summary: { platformFault: { kind: 'database' } } }, []),
    session({ status: 'paused' }), 'demo', HEAD);
  assert.equal(spent.automaticRetryPending, false);
  assert.equal(spent.repairAvailable, true);
  assert.equal(state.runSummary({ ...row, state: 'verified' }, []).automaticRetryPending, false);
  assert.equal(view.serialize(state.runSummary(row, []), session({ status: 'merged' }), 'demo', HEAD)
    .automaticRetryPending, false, 'a merged proposal gets no automatic retry');
  assert.equal(view.serialize(state.runSummary(row, []), session({ status: 'paused' }), 'demo', OTHER)
    .automaticRetryPending, false, 'nor does a commit the proposal has moved past');
  // No loader counts retries any more.
  for (const file of ['../src/services/shots-state.js', '../src/services/shots-view.js']) {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, file), 'utf8');
    assert.doesNotMatch(src, /interrupted_retries|platform_retries|unexplained_interruptions/, file);
  }
  assert.equal(view.fromSnapshot(session(), HEAD).automaticRetryPending, false);
});


test('a verified run\'s screens reach the card as integers and its own story ids only', () => {
  const screens = [{
    viewport: 'desktop', shot: 'dialog', stories: ['dialog', 'someone-else'],
    width: 1280, heightBefore: 800, heightAfter: 800,
    regions: [
      { story: 'dialog', b: [1, 2, 3, 4], a: [1, 2, 3, 4], bMark: null, aMark: null },
      { story: 'not-declared', b: null, a: [0, 0, 10, 10], bMark: [0, 0, 10], aMark: null },
      { story: 'dialog', b: ['1', 2, 3, 4], a: [1.5, 2, 3, 4] },
      { story: 'dialog', b: [-1, 0, 0, 0], a: null },
    ],
  }, { viewport: 'phone', shot: 'unknown-story', regions: [] }];
  const shown = view.serialize(run({ screens }), session(), 'demo', HEAD).screens;
  assert.equal(shown.length, 1, 'a screen for a change this run did not declare is dropped');
  assert.deepEqual(shown[0].stories, ['dialog']);
  assert.deepEqual(shown[0].regions, [
    { story: 'dialog', b: [1, 2, 3, 4], a: [1, 2, 3, 4], bMark: null, aMark: null },
    { story: null, b: null, a: [0, 0, 10, 10], bMark: [0, 0, 10], aMark: null },
  ]);
  // Only for the verified run on the current head.
  assert.deepEqual(view.serialize(run({ screens, state: 'failed' }), session(), 'demo', HEAD).screens, []);
  assert.deepEqual(view.serialize(run({ screens }), session(), 'demo', OTHER).screens, []);
  assert.deepEqual(view.fromSnapshot(session(), HEAD).screens, []);
});

test('a note or reason the agent wrote with escaped quotation marks reads with plain ones', () => {
  const results = view.cleanShotResults([
    { id: 'dialog', status: 'ready', note: 'The old \\"Continue\\" heading could not be shown.' },
    { id: 'other', status: 'skipped', reason: 'No \\\\"Invite\\\\" button for a member.' },
  ]);
  assert.equal(results[0].note, 'The old "Continue" heading could not be shown.');
  assert.equal(results[1].reason, 'No "Invite" button for a member.');
});
