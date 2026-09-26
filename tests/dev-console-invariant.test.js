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

// #2514: the receiver only accepts a message posted by the document inside
// one of the shell's own app frames, on the origin that frame was pointed at.
// A stub document holding the App tab's frame stands in for the shell.
const APP_ORIGIN = 'http://app.example';
const APP_WINDOW = { name: 'app-iframe window' };
const APP_FRAME = {
  id: 'app-iframe',
  contentWindow: APP_WINDOW,
  src: `${APP_ORIGIN}/?token=t`,
  getAttribute(name) { return name === 'src' ? this.src : null; },
};
const shellFrames = { 'app-iframe': APP_FRAME };
globalThis.document = {
  getElementById(id) { return shellFrames[id] || null; },
};
globalThis.location = { href: 'https://platform.example/', origin: 'https://platform.example' };

// A fresh receiver per test. The module also exports a singleton and installs
// it as window.DevConsole in a browser, but the class is what the behaviour
// lives on — and instantiating it keeps the tests independent.
function loadDevConsole() {
  const store = new DevConsoleStore();
  // Every message below comes from the app frame unless a test says otherwise.
  const receive = store._onMessage;
  store._onMessage = (event) => receive({ source: APP_WINDOW, origin: APP_ORIGIN, ...event });
  return store;
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

// ── #2514: only the shell's own app frames may write to the console ────

const LOG = { sentinel: '__usernodeDevConsole', level: 'error', args: ['spoof'], ts: 1 };

test('a window that is not one of the shell\'s app frames cannot log', () => {
  const DevConsole = new DevConsoleStore();
  // A third-party iframe nested inside the app, a popup, or no source at all.
  DevConsole._onMessage({ data: LOG, source: { name: 'nested' }, origin: 'https://evil.example' });
  DevConsole._onMessage({ data: LOG, source: { name: 'nested' }, origin: APP_ORIGIN });
  DevConsole._onMessage({ data: LOG, origin: APP_ORIGIN });
  DevConsole._onMessage({ data: LOG, source: null, origin: APP_ORIGIN });
  assert.equal(DevConsole.entries.length, 0);
  assert.equal(DevConsole.unseenErrors, 0, 'and nothing badges');
});

test('an app frame navigated off its app origin cannot log', () => {
  const DevConsole = new DevConsoleStore();
  DevConsole._onMessage({ data: LOG, source: APP_WINDOW, origin: 'https://evil.example' });
  DevConsole._onMessage({ data: LOG, source: APP_WINDOW, origin: 'null' });
  DevConsole._onMessage({ data: LOG, source: APP_WINDOW, origin: '' });
  assert.equal(DevConsole.entries.length, 0);
});

test('every shell app frame, on its own origin, still logs', () => {
  const extra = {
    'staging-iframe': { name: 'staging window', origin: 'https://preview.example' },
    'app-viewer-frame': { name: 'viewer window', origin: 'https://viewer.example' },
  };
  for (const [id, win] of Object.entries(extra)) {
    shellFrames[id] = {
      id,
      contentWindow: win,
      src: `${win.origin}/deep?token=t`,
      getAttribute(name) { return name === 'src' ? this.src : null; },
    };
  }
  try {
    const DevConsole = new DevConsoleStore();
    DevConsole._onMessage({ data: LOG, source: APP_WINDOW, origin: APP_ORIGIN });
    for (const win of Object.values(extra)) {
      DevConsole._onMessage({ data: LOG, source: win, origin: win.origin });
    }
    assert.equal(DevConsole.entries.length, 3);
    assert.equal(DevConsole.unseenErrors, 3);
  } finally {
    delete shellFrames['staging-iframe'];
    delete shellFrames['app-viewer-frame'];
  }
});
