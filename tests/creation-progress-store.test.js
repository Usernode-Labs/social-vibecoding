// The create dialog's progress model —
// frontend/src/features/dialogs/creation-progress-store.js.
//
// The dialog stays open after a successful POST /api/apps and narrates
// what the server is doing. Two halves live here, both pure and both
// testable in Node:
//
//   1. A plain-store the legacy `app_status` WS handler writes through
//      (public/js/app.js has no imports, so it goes via the
//      window.UsernodeReact bridge every other chunk-H store uses).
//   2. `stepStates()` — the (phase, status) → four-step view model the
//      component renders. Keeping the branching here rather than in JSX
//      is what makes the awkward cases (a phase we never heard, a
//      failure mid-step) assertable without a browser.
//
// Run with: node --test tests/creation-progress-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

let cached = null;
function mod() {
  if (!cached) cached = loadTsx('frontend/src/features/dialogs/creation-progress-store.js');
  return cached;
}

function fresh() {
  const m = mod();
  m.creationProgressStore.set({ ...m.INITIAL_CREATION_PROGRESS });
  return m;
}

// ── The store ─────────────────────────────────────────────────────

test('watch pins the app being created and starts from a clean slate', () => {
  const m = fresh();
  m.creationProgressStore.set({ phase: 'build', status: 'error' });
  m.watchCreation('my-app');
  const state = m.creationProgressStore.get();
  assert.equal(state.slug, 'my-app');
  assert.equal(state.phase, null, 'a previous run must not leak into this one');
  assert.equal(state.status, 'creating');
});

test('a phase broadcast for the watched app is recorded', () => {
  const m = fresh();
  m.watchCreation('my-app');
  m.publishAppStatus({ slug: 'my-app', status: 'creating', phase: 'repository' });
  assert.equal(m.creationProgressStore.get().phase, 'repository');
});

test('a broadcast for a DIFFERENT app is ignored', () => {
  const m = fresh();
  m.watchCreation('my-app');
  m.publishAppStatus({ slug: 'my-app', status: 'creating', phase: 'database' });
  m.publishAppStatus({ slug: 'someone-elses-app', status: 'running' });
  const state = m.creationProgressStore.get();
  assert.equal(state.phase, 'database', 'another app finishing must not move my steps');
  assert.equal(state.status, 'creating');
});

test('nothing is recorded before the dialog watches an app', () => {
  const m = fresh();
  m.publishAppStatus({ slug: 'my-app', status: 'running' });
  assert.equal(m.creationProgressStore.get().status, null);
});

test('a terminal broadcast carries its outcome detail through', () => {
  const m = fresh();
  m.watchCreation('my-app');
  m.publishAppStatus({ slug: 'my-app', status: 'running', url: 'https://my-app.example.test' });
  const live = m.creationProgressStore.get();
  assert.equal(live.status, 'running');
  assert.equal(live.url, 'https://my-app.example.test');

  m.watchCreation('other-app');
  m.publishAppStatus({ slug: 'other-app', status: 'error', errorReason: 'Build failed: no Dockerfile' });
  assert.equal(m.creationProgressStore.get().errorReason, 'Build failed: no Dockerfile');

  m.watchCreation('third-app');
  m.publishAppStatus({ slug: 'third-app', status: 'awaiting_secrets', missingSecrets: ['API_KEY'] });
  assert.deepEqual(m.creationProgressStore.get().missingSecrets, ['API_KEY']);
});

test('the last phase survives a terminal broadcast that carries none', () => {
  const m = fresh();
  m.watchCreation('my-app');
  m.publishAppStatus({ slug: 'my-app', status: 'creating', phase: 'build' });
  m.publishAppStatus({ slug: 'my-app', status: 'error', errorReason: 'boom' });
  assert.equal(m.creationProgressStore.get().phase, 'build',
    'the failure view needs to say WHICH step failed');
});

// ── outcomeOf ─────────────────────────────────────────────────────

test('outcomeOf maps each server status to what the dialog shows', () => {
  const m = mod();
  assert.equal(m.outcomeOf('creating'), 'pending');
  assert.equal(m.outcomeOf('running'), 'live');
  assert.equal(m.outcomeOf('awaiting_secrets'), 'needs-secrets');
  assert.equal(m.outcomeOf('error'), 'failed');
  assert.equal(m.outcomeOf(null), 'pending', 'no word from the server yet is still in progress');
  assert.equal(m.outcomeOf('something-new'), 'pending',
    'an unknown status must not render as a failure');
});

// ── stepStates ────────────────────────────────────────────────────

const states = (m, over) => m.stepStates({ phase: null, status: 'creating', ...over });

test('CREATION_STEPS is the four phases the server reports, in order', () => {
  const m = mod();
  assert.deepEqual(
    m.CREATION_STEPS.map((s) => s.key),
    ['database', 'repository', 'build', 'deploy']
  );
  for (const step of m.CREATION_STEPS) {
    assert.ok(step.label && step.label.length > 3, `${step.key} needs a human label`);
  }
});

test('everything before the current phase is done, the current one is active', () => {
  const m = mod();
  assert.deepEqual(states(m, { phase: 'build' }), ['done', 'done', 'active', 'idle']);
  assert.deepEqual(states(m, { phase: 'database' }), ['active', 'idle', 'idle', 'idle']);
  assert.deepEqual(states(m, { phase: 'deploy' }), ['done', 'done', 'done', 'active']);
});

test('an unknown phase leaves every step idle rather than guessing', () => {
  const m = mod();
  // The honest state after a page refresh into a platform process that
  // restarted mid-creation: still creating, step unknown.
  assert.deepEqual(states(m, { phase: null }), ['idle', 'idle', 'idle', 'idle']);
});

test('a live app has every step done, whatever the last phase was', () => {
  const m = mod();
  assert.deepEqual(states(m, { phase: 'build', status: 'running' }),
    ['done', 'done', 'done', 'done']);
  assert.deepEqual(states(m, { phase: null, status: 'running' }),
    ['done', 'done', 'done', 'done'],
    'a fast creation whose phases were all missed still ends complete');
});

test('a failure marks the step it died in, and leaves the later ones idle', () => {
  const m = mod();
  assert.deepEqual(states(m, { phase: 'build', status: 'error' }),
    ['done', 'done', 'failed', 'idle']);
  assert.deepEqual(states(m, { phase: null, status: 'error' }),
    ['idle', 'idle', 'idle', 'idle'],
    'no phase means no step to blame — the reason line carries it instead');
});

test('awaiting_secrets completes the steps that ran and stops, it does not fail them', () => {
  const m = mod();
  // The gate sits between the repository step and the build step, so
  // the steps that DID run are genuinely done.
  assert.deepEqual(states(m, { phase: 'repository', status: 'awaiting_secrets' }),
    ['done', 'done', 'idle', 'idle']);
  assert.ok(!states(m, { phase: 'repository', status: 'awaiting_secrets' }).includes('failed'),
    'a missing secret is a thing to fix, not a build failure');
});

// ── fetchCreationProgress ─────────────────────────────────────────
//
// The poll's body, extracted so the payload mapping is testable: the
// route calls the field `creationPhase` and carries the failure reason
// inside `lastFailure`, and neither name matches the store's. That
// rename is the part that can silently be wrong.

test('a polled payload is folded into the store under the store\'s own names', async () => {
  const m = fresh();
  m.watchCreation('my-app');
  await m.fetchCreationProgress('my-app', async () => ({
    ok: true,
    json: async () => ({ app: { status: 'creating', creationPhase: 'deploy' } }),
  }));
  assert.equal(m.creationProgressStore.get().phase, 'deploy');
});

test('a polled failure carries the reason out of lastFailure', async () => {
  const m = fresh();
  m.watchCreation('my-app');
  await m.fetchCreationProgress('my-app', async () => ({
    ok: true,
    json: async () => ({
      app: { status: 'error', creationPhase: null, lastFailure: { reason: 'Build failed: no Dockerfile' } },
    }),
  }));
  const state = m.creationProgressStore.get();
  assert.equal(state.status, 'error');
  assert.equal(state.errorReason, 'Build failed: no Dockerfile');
});

test('a polled payload with no lastFailure does not invent an error reason', async () => {
  const m = fresh();
  m.watchCreation('my-app');
  await m.fetchCreationProgress('my-app', async () => ({
    ok: true,
    json: async () => ({ app: { status: 'running', url: 'https://my-app.example.test' } }),
  }));
  const state = m.creationProgressStore.get();
  assert.equal(state.errorReason, null);
  assert.equal(state.url, 'https://my-app.example.test');
});

test('a failed or non-OK poll changes nothing and never throws', async () => {
  const m = fresh();
  m.watchCreation('my-app');
  m.publishAppStatus({ slug: 'my-app', status: 'creating', phase: 'build' });

  await m.fetchCreationProgress('my-app', async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal(m.creationProgressStore.get().phase, 'build', 'a 500 leaves the last known state');

  await m.fetchCreationProgress('my-app', async () => { throw new Error('offline'); });
  assert.equal(m.creationProgressStore.get().phase, 'build', 'so does a dropped connection');

  await m.fetchCreationProgress('my-app', async () => ({ ok: true, json: async () => ({}) }));
  assert.equal(m.creationProgressStore.get().phase, 'build', 'so does a body with no app');
});
