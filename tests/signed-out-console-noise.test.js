// QA 2026-09-24 Q35: the signed-out landing and the waiting room ask no
// member-only API.
//
// The shell is one document for everyone, so modules loaded on every page
// fetched `/api/models` (and, until they were removed, the agent sessions
// list and Global Chat's bootstrap) for signed-out visitors (each 401 a red
// "Failed to load resource" line on every anonymous screen) and for
// waiting-room accounts (403s). The model list (frontend/src/lib/
// platform-models.js) now waits for a viewer the endpoint answers (the test
// frontend/src/lib/platform-viewer.ts makes) and loads on `sv:authed`, the
// authed boot's once-per-document event, when there was none at load.
//
// Run with: node --test tests/signed-out-console-noise.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const MODELS_SRC = read('frontend/src/lib/platform-models.js');

// platform-models.js is a classic script: evaluated as the shell evaluates
// it, against this world's window, document and fetch.
function loadModels() {
  vm.runInNewContext(MODELS_SRC, {
    window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch,
  });
}

function world(user) {
  const listeners = {};
  const doc = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  const win = { App: { user }, UsernodeReact: {}, location: { hash: '' }, PlatformUI: { toast: () => {} } };
  const requests = [];
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const body = { sessions: [], models: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const authed = () => { for (const fn of listeners['sv:authed'] || []) fn(); };
  return { win, requests, authed, listeners };
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.fetch;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('signed out: no member request, and the load runs once the authed shell boots', async () => {
  const w = world(null);
  try {
    loadModels();
    await settle();
    assert.deepEqual(w.requests, [], 'nothing asked for a signed-out document');
    assert.equal((w.listeners['sv:authed'] || []).length, 1, 'one deferred load');

    // A reload-free sign-in: App.user lands, then sv:authed fires.
    w.win.App.user = { id: 1, username: 'ada', hasPlatformAccess: true };
    w.authed();
    await settle();
    await settle();
    assert.deepEqual(w.requests, ['/api/models']);
  } finally { cleanup(); }
});

test('the waiting room: an account without platform access asks nothing', async () => {
  const w = world({ id: 2, username: 'queued', hasPlatformAccess: false });
  try {
    loadModels();
    // sv:authed does not fire for a waiting-room session, and if it did the
    // gate would still hold.
    w.authed();
    await settle();
    assert.deepEqual(w.requests, []);
  } finally { cleanup(); }
});

test('a member loads straight away, as before', async () => {
  // `hasPlatformAccess` absent is a member too: app.js gates on `=== false`
  // so an older cached user without the field is never locked out.
  const w = world({ id: 3, username: 'member' });
  try {
    loadModels();
    await settle();
    assert.deepEqual(w.requests, ['/api/models']);
  } finally { cleanup(); }
});

test('the model list asks for /api/models only for such a viewer, else on sv:authed', () => {
  const src = MODELS_SRC;
  assert.match(src, /const hasPlatformViewer = \(\) => !!\(window\.App && window\.App\.user\s+&& window\.App\.user\.hasPlatformAccess !== false\);/);
  assert.match(src, /if \(hasPlatformViewer\(\)\) PlatformModels\.load\(\);\s+else if \(typeof document !== 'undefined'\) \{\s+document\.addEventListener\('sv:authed'/);
  assert.doesNotMatch(src, /\n  PlatformModels\.load\(\);\n\}/, 'no unconditional boot fetch');
});
