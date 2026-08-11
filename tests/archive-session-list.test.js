// Regression guard for the "Archive button disappeared on cold proposals"
// fix. In dev-chat.js's renderSessionList(), the Archive button must be
// gated on a dedicated isArchivable predicate (status active/promoted/
// paused) — NOT on isActionable, which excludes a promoted session whose
// worker has gone cold (warm:false). This test executes the REAL
// DevChat.renderSessionList against a minimal fake DOM and asserts on the
// emitted .dc-archive-btn markup:
//
//   1. A promoted session with warm:false still renders .dc-archive-btn
//      (the regression — it used to vanish once the worker cooled).
//   2. merged / archived rows do NOT render .dc-archive-btn (they fall
//      outside the archivable set; the backend would 404 them).
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`), so we
// load its source into a vm context, stub the globals renderSessionList
// touches (document, escapeHtml), expose DevChat, and drive it.
//
// Run with: node --test tests/archive-session-list.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

// Captures the last innerHTML written to the #dc-session-list container.
// querySelectorAll returns an empty, forEach-able list so the handler-
// wiring tail of renderSessionList is a no-op (we only assert on markup).
function makeHarness() {
  const container = {
    innerHTML: '',
    querySelectorAll: () => ({ forEach: () => {} }),
  };
  const document = {
    getElementById: (id) => (id === 'dc-session-list' ? container : null),
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {} }),
    body: { appendChild: () => {}, addEventListener: () => {} },
  };
  const sandbox = {
    console,
    document,
    escapeHtml: (s) => String(s == null ? '' : s),
    requestAnimationFrame: () => {},
    alert: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // AppView is referenced by some handlers; renderSessionList itself only
  // reads DevChat.sessions, but keep a stub to avoid ReferenceErrors if
  // the no-op forEach path ever touches it.
  sandbox.AppView = { appData: null };
  return { DevChat, container };
}

test('promoted session with a cold worker (warm:false) still renders Archive', () => {
  const { DevChat, container } = makeHarness();
  DevChat.sessions = [
    { id: 1, status: 'promoted', warm: false, session_title: 'Cold proposal',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  DevChat.renderSessionList();
  assert.match(container.innerHTML, /dc-archive-btn/,
    'cold promoted proposal must keep its Archive button');
  // And it must NOT offer Free worker (nothing to free when cold).
  assert.doesNotMatch(container.innerHTML, /data-freeing/,
    'a cold promoted session has no warm worker to free');
});

test('warm promoted session renders both Free worker and Archive', () => {
  const { DevChat, container } = makeHarness();
  DevChat.sessions = [
    { id: 2, status: 'promoted', warm: true, session_title: 'Warm proposal',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  DevChat.renderSessionList();
  assert.match(container.innerHTML, /dc-archive-btn/);
  assert.match(container.innerHTML, /data-freeing/);
});

test('active and paused sessions render Archive', () => {
  for (const status of ['active', 'paused']) {
    const { DevChat, container } = makeHarness();
    DevChat.sessions = [
      { id: 3, status, warm: false, session_title: `${status} session`,
        created_at: '2026-06-01T00:00:00Z' },
    ];
    DevChat.renderSessionList();
    assert.match(container.innerHTML, /dc-archive-btn/, `${status} should be archivable`);
  }
});

test('merged and archived rows do NOT render Archive', () => {
  for (const status of ['merged', 'merging', 'archived']) {
    const { DevChat, container } = makeHarness();
    DevChat.sessions = [
      { id: 4, status, warm: false, session_title: `${status} session`,
        created_at: '2026-06-01T00:00:00Z' },
    ];
    DevChat.renderSessionList();
    assert.doesNotMatch(container.innerHTML, /dc-archive-btn/,
      `${status} must not be archivable from the session list`);
  }
});

test('archived row renders Unarchive instead', () => {
  const { DevChat, container } = makeHarness();
  DevChat.sessions = [
    { id: 5, status: 'archived', warm: false, session_title: 'Archived',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  DevChat.renderSessionList();
  assert.match(container.innerHTML, /dc-unarchive-btn/);
});
