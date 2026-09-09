// The per-app creation-phase tracker — services/app-creation-phase.js.
//
// `apps.status` has no intermediate value between 'creating' and its
// terminal ones ('running' / 'awaiting_secrets' / 'error'), so the row
// cannot say WHICH part of createApp is running. This tiny in-memory
// map carries that, purely so the create dialog can tick its four steps
// off as they actually happen.
//
// It is deliberately a sibling of app-deploy-status.js rather than a
// field on it: that module broadcasts through the UNSCOPED
// broadcastGlobal, and a brand-new app may be view-private, so its
// phases have to go out through ws.pushAppCreationPhase (which uses
// broadcastGlobalScoped) instead.
//
// Run with: node --test tests/app-creation-phase.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'src', 'services', 'app-creation-phase.js');

// Each test gets a pristine module — the store is module-level state.
function load() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

test('PHASES is the ordered vocabulary the dialog steps through', () => {
  const { PHASES } = load();
  assert.deepEqual(PHASES, ['database', 'repository', 'build', 'deploy']);
});

test('read returns null for a slug that was never marked', () => {
  const store = load();
  assert.equal(store.read('never-marked'), null);
  assert.equal(store.read(''), null, 'falsy slug is safe');
  assert.equal(store.read(undefined), null);
});

test('markPhase records the phase and read reports it back', () => {
  const store = load();
  store.markPhase('my-app', 'repository');
  const entry = store.read('my-app');
  assert.equal(entry.phase, 'repository');
  assert.equal(typeof entry.startedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(entry.startedAt)), 'startedAt is an ISO timestamp');
});

test('markPhase advances an existing entry and keeps the original startedAt', async () => {
  const store = load();
  store.markPhase('my-app', 'database');
  const first = store.read('my-app').startedAt;
  await new Promise((r) => setTimeout(r, 5));
  store.markPhase('my-app', 'build');
  const entry = store.read('my-app');
  assert.equal(entry.phase, 'build');
  assert.equal(entry.startedAt, first, 'startedAt marks the start of creation, not of the phase');
});

test('markPhase rejects a phase outside the vocabulary', () => {
  const store = load();
  store.markPhase('my-app', 'teleporting');
  assert.equal(store.read('my-app'), null, 'an unknown phase records nothing');
});

test('markPhase ignores a missing slug', () => {
  const store = load();
  store.markPhase('', 'database');
  store.markPhase(null, 'database');
  assert.equal(store.read(''), null);
});

test('clear drops the entry so a finished app reports no phase', () => {
  const store = load();
  store.markPhase('my-app', 'deploy');
  store.clear('my-app');
  assert.equal(store.read('my-app'), null);
});

test('an entry older than the stale window reads as null', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = load();
  store.markPhase('my-app', 'build');
  assert.equal(store.read('my-app').phase, 'build');
  // Creation is watchdogged at 5 minutes (routes/apps.js), so anything
  // still claiming a phase well past that is an orphan from a process
  // that died mid-run — better to report nothing than to spin forever.
  t.mock.timers.tick(store.PHASE_STALE_AFTER_MS + 1000);
  assert.equal(store.read('my-app'), null);
});
