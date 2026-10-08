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

test('an interrupted run with an automatic retry to come says so, and is not offered for a manual retry', () => {
  const state = require('../src/services/shots-state');
  const row = {
    id: 'f'.repeat(32), session_id: 42, state: 'failed', base_sha: BASE, head_sha: HEAD,
    failure_code: 'shots_run_interrupted', failure_reason: 'Homeroom restarted.', intent: null,
    interrupted_retries: 0, unexplained_interruptions: 1,
  };
  const open = view.serialize(state.runSummary(row, []), session({ status: 'paused' }), 'demo', HEAD);
  assert.equal(open.automaticRetryPending, true);
  assert.equal(open.repairAvailable, false, 'the sweep starts it; a second way to start it is not offered');

  const spent = view.serialize(state.runSummary({ ...row, interrupted_retries: state.MAX_INTERRUPTED_RETRIES }, []),
    session({ status: 'paused' }), 'demo', HEAD);
  assert.equal(spent.automaticRetryPending, false, 'once the retries are used up it is a failure again');
  assert.equal(spent.repairAvailable, true);

  // Rollouts spend only the ceiling: a head interrupted by five deploys in a
  // row is still retried, where the old single budget of two gave up.
  const rollouts = state.runSummary({ ...row, interrupted_retries: 5, unexplained_interruptions: 0 }, []);
  assert.equal(rollouts.automaticRetryPending, true);
  // An interruption nothing explained keeps the original budget of two
  // retries, since the run itself may be what takes the process down.
  const crashes = state.runSummary({
    ...row, interrupted_retries: 2, unexplained_interruptions: state.MAX_UNEXPLAINED_RETRIES + 1,
  }, []);
  assert.equal(crashes.automaticRetryPending, false);
  assert.equal(state.runSummary({ ...row, interrupted_retries: 1, unexplained_interruptions: 2 }, [])
    .automaticRetryPending, true, 'a second crash still gets its retry');

  const merged = view.serialize(state.runSummary(row, []), session({ status: 'merged' }), 'demo', HEAD);
  assert.equal(merged.automaticRetryPending, false, 'a merged proposal gets no automatic retry');

  const superseded = view.serialize(state.runSummary(row, []), session({ status: 'paused' }), 'demo', OTHER);
  assert.equal(superseded.automaticRetryPending, false, 'nor does a commit the proposal has moved past');

  // The sweep matches the stored code exactly, so neither may a run
  // interrupted under the name from before the rename.
  assert.equal(state.runSummary({ ...row, failure_code: 'evidence_run_interrupted' }, []).automaticRetryPending, false);
  // A loader that did not count the retries cannot promise one.
  assert.equal(state.runSummary({ ...row, interrupted_retries: undefined }, []).automaticRetryPending, false);
  assert.equal(state.runSummary({ ...row, unexplained_interruptions: undefined }, []).automaticRetryPending, false);
  // Both loaders and the sweep count them the same way, under the trigger
  // the sweep writes and the marker the shutdown handler writes: if they
  // drifted, the card would promise a retry the sweep never starts.
  assert.equal(state.INTERRUPTED_RETRY_TRIGGER, 'interrupted-retry');
  assert.equal(state.SHUTDOWN_INTERRUPTION, 'shutdown');
  const counts = (file) => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, file), 'utf8');
    const start = src.indexOf('(SELECT COUNT(*) FROM shot_runs retry');
    const end = src.indexOf('AS unexplained_interruptions', start);
    assert.ok(start >= 0 && end > start, `${file} selects both counts`);
    return src.slice(start, end).replace(/\s+/g, ' ');
  };
  const reference = counts('../src/services/shots-state.js');
  assert.match(reference, /retry\.trigger = 'interrupted-retry'\)::int AS interrupted_retries/);
  assert.match(reference, /COALESCE\(crash\.trace_summary->>'interruptedBy', ''\) <> 'shutdown'\)::int/);
  for (const file of ['../src/services/shots-view.js', '../src/services/shots-gc.js']) {
    assert.equal(counts(file), reference, `${file} counts exactly as shots-state does`);
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
