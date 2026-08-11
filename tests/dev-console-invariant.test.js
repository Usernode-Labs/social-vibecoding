// Regression test for issue #360: the platform shell's developer-console
// receiver already keys only off the `__usernodeDevConsole` sentinel and
// stores any `kind`, so an invariant-failure message (kind:'invariant',
// level:'error') posted by the bridge surfaces and badges exactly like a
// console.error — with no receiver change. This pins that behaviour.
//
// The receiver used to be public/js/dev-console.js, loaded here in a vm with a
// stubbed DOM. #1079 chunk B converted it: the module is now
// frontend/src/features/dev-console/store.ts, which is deliberately React-free
// and dependency-free precisely so it can still be loaded directly — node
// strips the types on require. The assertions below are unchanged.
//
// Run with: node --test tests/dev-console-invariant.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DevConsoleStore } = require(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-console', 'store.ts'),
);

// A fresh receiver per test. The module also exports a singleton and installs
// it as window.DevConsole in a browser, but the class is what the behaviour
// lives on — and instantiating it keeps the tests independent.
function loadDevConsole() {
  return new DevConsoleStore();
}

test('an invariant-failure message is stored and bumps the error badge', () => {
  const DevConsole = loadDevConsole();
  DevConsole._onMessage({
    data: {
      sentinel: '__usernodeDevConsole',
      level: 'error',
      kind: 'invariant',
      args: ['canvas-fills-window: canvas 800x600 != 1600x1200'],
      ts: 1,
      url: 'http://app.example/',
    },
  });
  assert.equal(DevConsole.entries.length, 1);
  const entry = DevConsole.entries[0];
  assert.equal(entry.kind, 'invariant');
  assert.equal(entry.level, 'error');
  assert.equal(entry.args[0], 'canvas-fills-window: canvas 800x600 != 1600x1200');
  // level === 'error' while the panel is closed → counts toward the badge.
  assert.equal(DevConsole.unseenErrors, 1);
});

test('an invariant recovery (info level) is stored but does not badge', () => {
  const DevConsole = loadDevConsole();
  DevConsole._onMessage({
    data: {
      sentinel: '__usernodeDevConsole',
      level: 'info',
      kind: 'invariant',
      args: ['flapping: recovered'],
      ts: 2,
      url: 'http://app.example/',
    },
  });
  assert.equal(DevConsole.entries.length, 1);
  assert.equal(DevConsole.unseenErrors, 0);
});

test('messages without the sentinel are ignored', () => {
  const DevConsole = loadDevConsole();
  DevConsole._onMessage({ data: { level: 'error', kind: 'invariant', args: ['nope'] } });
  DevConsole._onMessage({ data: null });
  assert.equal(DevConsole.entries.length, 0);
  assert.equal(DevConsole.unseenErrors, 0);
});

// ── What the conversion added, and therefore has to keep ───────────────

test('each app keeps its own buffer, and entries arrays are replaced not mutated', () => {
  // The island renders from `entries` through useSyncExternalStore, so a
  // mutated-in-place array would be an identity no-op and the log would stop
  // updating. This is the assertion that catches a `push` creeping back in.
  const DevConsole = loadDevConsole();
  DevConsole.setCurrentApp('alpha');
  const post = (level) => DevConsole._onMessage({
    data: { sentinel: '__usernodeDevConsole', level, args: [level], ts: 1 },
  });
  post('log');
  const first = DevConsole.entries;
  post('error');
  assert.notEqual(DevConsole.entries, first, 'entries must be a new array on every append');
  assert.equal(DevConsole.entries.length, 2);

  DevConsole.setCurrentApp('beta');
  assert.equal(DevConsole.entries.length, 0, 'a different app starts from an empty buffer');
  DevConsole.setCurrentApp('alpha');
  assert.equal(DevConsole.entries.length, 2, 'and switching back restores the first one');
});

test('the ring buffer is capped at MAX_ENTRIES', () => {
  const DevConsole = loadDevConsole();
  for (let i = 0; i < DevConsole.MAX_ENTRIES + 25; i += 1) {
    DevConsole._onMessage({
      data: { sentinel: '__usernodeDevConsole', level: 'log', args: [String(i)], ts: i },
    });
  }
  assert.equal(DevConsole.entries.length, DevConsole.MAX_ENTRIES);
  assert.equal(DevConsole.entries[0].args[0], '25', 'the oldest entries are the ones dropped');
});

test('the filter and counts summary the panel header renders', () => {
  const DevConsole = loadDevConsole();
  for (const level of ['log', 'error', 'error', 'warn']) {
    DevConsole._onMessage({
      data: { sentinel: '__usernodeDevConsole', level, args: [level], ts: 1 },
    });
  }
  assert.equal(DevConsole.countsLabel(), '4 total · 2 err · 1 warn');
  assert.equal(DevConsole.visibleEntries().length, 4);
  DevConsole.setFilter('error');
  assert.equal(DevConsole.visibleEntries().length, 2);
});

test('every change bumps the version the island subscribes to', () => {
  const DevConsole = loadDevConsole();
  // An app iframe has to be on screen or _refreshButtonVisibility() closes the
  // panel again the moment show() opens it — the classic module did the same.
  DevConsole.setCurrentApp('alpha');
  DevConsole.setButtonVisible(true);
  DevConsole.setMode(DevConsole.MODE_ALWAYS);

  let notified = 0;
  const unsubscribe = DevConsole.subscribe(() => { notified += 1; });
  const before = DevConsole.getSnapshot();
  DevConsole._onMessage({
    data: { sentinel: '__usernodeDevConsole', level: 'log', args: ['x'], ts: 1 },
  });
  assert.ok(DevConsole.getSnapshot() > before, 'an appended entry must change the snapshot');
  assert.equal(notified, 1);
  DevConsole.show();
  assert.equal(DevConsole.panelOpen, true);
  assert.equal(notified, 2);
  unsubscribe();
  DevConsole.clear();
  assert.equal(notified, 2, 'unsubscribe really unsubscribes');
  assert.equal(DevConsole.entries.length, 0);
});

test('setMode normalises anything that is not MODE_ALWAYS', () => {
  const DevConsole = loadDevConsole();
  DevConsole.setMode(DevConsole.MODE_ALWAYS);
  assert.equal(DevConsole.getMode(), 'always');
  DevConsole.setMode('true');
  assert.equal(DevConsole.getMode(), 'errors-only',
    'a truthy string from an older caller must not read as "always"');
});
