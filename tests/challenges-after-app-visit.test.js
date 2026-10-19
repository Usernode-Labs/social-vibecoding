// Challenge progress catches up when the app visit is acknowledged (#5235).
//
// "I completed the required app visits and the challenge page still showed
// the old count until I logged out and back in." The visit that credits a
// "Try apps" challenge is often uploaded as the person LEAVES the app
// (app-activity.js's stop()), at the same moment the screen they return to
// reads its progress — so that read is answered with the pre-credit count,
// and after it nothing read again until a reload. Now:
//
//   * EngagedAppUsage announces an acknowledged upload on `document`
//     (`sv:app-activity-recorded`, the `sv:membership-changed` pattern);
//   * the Challenges tab listens while it is open and re-reads fresh, in
//     place (_reread: the cards stay up, a failed read keeps them), or queues
//     the re-read behind a first load still out;
//   * Home's Challenges block listens the same way and re-reads fresh, past
//     its minute, while Home is the screen showing it.
//
// The vm setups follow tests/challenges-live-reads.test.js (the pane) and
// tests/home-challenges-after-join.test.js (the block, with a real
// EventTarget for `document`, so the event one module dispatches is the one
// the other hears).
//
// Run with: node --test tests/challenges-after-app-visit.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PANELS_SRC } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const CHALLENGES_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');

// The event app-activity.js dispatches once the server acknowledges an
// upload — the literal the pane spells, because it stays import-free.
const EVENT = 'sv:app-activity-recorded';

const json = (body, ok = true) => ({
  ok, status: ok ? 200 : 500,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

// ── The Challenges tab ────────────────────────────────────────────────────

// Like challenges-live-reads.test.js's loadPane, but `document` is a real
// EventTarget (so the test can dispatch the acknowledgement at it) and
// UsernodeReact is absent, so the live-reads watcher is out of the way.
function loadPane() {
  const bus = new EventTarget();
  const server = { credits: 1, fail: false, hold: null };
  const reads = [];
  const context = { eventId: 10, onChange: () => () => {} };
  const sandbox = {
    console, setTimeout, clearTimeout,
    location: { hash: '', search: '' },
    document: Object.assign(bus, {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    }),
    window: { TopochainEventContext: context },
    fetch: async (url, init) => {
      reads.push({ url: String(url), cache: init && init.cache });
      if (server.hold) await server.hold;
      if (server.fail) return json({ success: false, error: 'boom' }, false);
      if (String(url).startsWith('/challenges-api/')) {
        return json({ success: true, data: [{ id: 1, points: server.credits * 100 }] });
      }
      return json({
        success: true,
        data: [{
          id: 1,
          card_preview: { goal: 'Try three apps' },
          metric: { kind: 'apps_tried', target: 3, label: 'Apps tried' },
          progress: { done: server.credits >= 3, current: server.credits, target: 3 },
        }],
      });
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.TopochainEventContext = context;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CHALLENGES_SRC, sandbox, { filename: 'topochain-challenges.js' });
  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: false, grid: null, detail: null, profile: null };
  const grids = [];
  pane._store = {
    get: () => state,
    set: (patch) => { Object.assign(state, patch); if ('grid' in patch) grids.push(patch.grid); },
  };
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
  return { pane, bus, server, reads, state, grids, settle };
}

test('an acknowledged app visit re-reads the open pane fresh, in place', async () => {
  const { pane, bus, server, reads, state, grids, settle } = loadPane();
  pane.open();
  await settle();
  assert.equal(state.grid.kind, 'cards');
  reads.length = 0;
  grids.length = 0;

  // The visit is counted server-side, and the upload that carried it answers.
  server.credits = 2;
  bus.dispatchEvent(new Event(EVENT));
  await settle();

  assert.deepEqual(reads.map((r) => r.cache), ['no-cache', 'no-cache'],
    'both the list and the viewer\'s own rows ask for the current answer');
  assert.ok(grids.every((g) => g.kind === 'cards'), 'the cards never give way to a loading state');
  assert.equal(pane._challenges[0].progress.current, 2, 'the new count is what the grid reads');
});

test('a pane that is closed reads nothing for the acknowledgement', async () => {
  const { pane, bus, reads, settle } = loadPane();
  pane.open();
  await settle();
  pane.close();
  reads.length = 0;
  bus.dispatchEvent(new Event(EVENT));
  await settle();
  assert.equal(reads.length, 0, 'the listener went with the screen');
});

test('while the first load is still out, exactly one re-read follows it', async () => {
  const { pane, bus, server, reads, settle } = loadPane();
  let release;
  server.hold = new Promise((r) => { release = r; });
  pane.open();
  await Promise.resolve();
  assert.equal(pane._challengesLoading, true, 'the first load is out');

  // The acknowledgement lands mid-load: it must not put a skeleton back over
  // the load that already started, so it queues.
  bus.dispatchEvent(new Event(EVENT));
  assert.equal(pane._rereadQueued, true);

  release();
  await settle();
  const listReads = reads.filter((r) => r.url.startsWith('/api/v4/'));
  assert.deepEqual(listReads.map((r) => r.cache), [undefined, 'no-cache'],
    'the first read, then exactly one re-read of it');
});

test('a first load that fails clears the queued re-read instead of re-reading over the error', async () => {
  const { pane, bus, server, reads, state, settle } = loadPane();
  let release;
  server.hold = new Promise((r) => { release = r; });
  server.fail = true;
  pane.open();
  await Promise.resolve();
  bus.dispatchEvent(new Event(EVENT));
  release();
  await settle();
  const listReads = reads.filter((r) => r.url.startsWith('/api/v4/'));
  assert.deepEqual(listReads.map((r) => r.cache), [undefined], 'no second read');
  assert.equal(state.grid.kind, 'error');
  assert.equal(pane._rereadQueued, false, 'the flag did not outlive its load');
});

// ── Home's Challenges block ───────────────────────────────────────────────

// Like tests/home-challenges-after-join.test.js, with a real EventTarget for
// `document` and an _isScreenVisible that the test can point at Home or away.
function loadPanels({ homeVisible = true } = {}) {
  const bus = new EventTarget();
  const reads = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams,
    location: { search: '', hash: '' },
    App: {
      user: { id: 7 },
      _announceRefreshIntent() {},
      _isScreenVisible: (id) => id === 'home-screen' && homeVisible,
    },
    document: Object.assign(bus, {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    }),
    CustomEvent,
    fetch: async (url, init) => {
      reads.push({ url: String(url), cache: init && init.cache });
      return { ok: true, status: 200, json: async () => ({ registry: [], hidden: [], panels: [] }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  installPanelsStore(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  const HP = sandbox.__HP;
  HP.render = () => {};
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      const pending = HP._queued || HP._inflight;
      if (pending) await pending;
      await new Promise((r) => setImmediate(r));
    }
  };
  return { HP, bus, reads, settle };
}

test('an acknowledged app visit re-reads Home\'s block fresh, inside its minute', async () => {
  const { HP, bus, reads, settle } = loadPanels();
  await HP.ensureLoaded();
  await settle();
  assert.equal(reads.length, 1, 'the first read');
  await HP.ensureLoaded();
  assert.equal(reads.length, 1, 'inside the minute an ordinary call reads nothing');

  bus.dispatchEvent(new Event(EVENT));
  await settle();
  assert.deepEqual(reads.map((r) => r.cache), [undefined, 'no-cache'],
    'the forced, fresh read went anyway');
});

test('Home\'s block reads nothing for the acknowledgement while Home is not on screen', async () => {
  const { HP, bus, reads, settle } = loadPanels({ homeVisible: false });
  await HP.ensureLoaded();
  await settle();
  bus.dispatchEvent(new Event(EVENT));
  await settle();
  assert.equal(reads.length, 1, 'only the first read ran');
});

test('Home\'s block reads nothing for the acknowledgement before its first read', async () => {
  const { HP, bus, reads, settle } = loadPanels();
  bus.dispatchEvent(new Event(EVENT));
  await settle();
  assert.equal(reads.length, 0, 'Home\'s own first load brings the current answer');
});
