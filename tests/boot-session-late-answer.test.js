// A boot read that never said no must not sign a signed-in viewer out for
// the rest of the document.
//
// App.init reads /api/auth/me with a 2s deadline (BOOT_SESSION_TIMEOUT_MS).
// With no session snapshot to paint, a read that times out, fails, or answers
// 5xx boots the anonymous shell, and nothing asked again: a viewer whose
// cookie the server still honoured stayed on the sign-in screen (or, at `/`,
// the landing) until they reloaded.
//
// Proposal checks met it on every retried run in October 2026: the capture
// pods' first pages on a just-started preview were signed in on the server
// (the preview logged a minted session for each) and showed the sign-in form
// or the landing with status 200 and no console error, and every retry
// passed. A device with no snapshot and a live cookie is every browser
// context opened on a preview, so people opening a fresh preview met it too.
//
// The fix asks once more (App._adoptLateSession) through the sign-in
// completion every login uses (AuthScreens.finishLogin). These tests run
// App.init's own source in a sandbox with a controllable fetch, so they pin
// the behaviour rather than the spelling.
//
// Run with: node --test tests/boot-session-late-answer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

// A top-level App method's source, from its name to the closing `},` at the
// same indent.
function methodSource(name) {
  let start = APP.indexOf(`\n  async ${name}(`);
  if (start === -1) start = APP.indexOf(`\n  ${name}(`);
  assert.ok(start > -1, `App.${name} not found`);
  const end = APP.indexOf('\n  },\n', start);
  assert.ok(end > -1, `end of App.${name} not found`);
  return APP.slice(start + 1, end + 4);
}

const REAL = ['init', '_adoptLateSession', '_fetchSession', '_fetchWebSession', '_answeredSignedOut'];

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Builds a sandboxed App whose boot runs the real methods above and records
// what the shell would have done. `firstRead` answers the boot's read:
// a Response-like object, or 'hang' for a read that never answers.
function boot({ firstRead, native = false, signInBegun = false } = {}) {
  const calls = { enterAnonymous: 0, enterAuthed: [], finishLogin: 0, dropCached: 0, reads: 0 };
  const fetch = (url, opts) => {
    calls.reads += 1;
    if (firstRead === 'hang') {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve(firstRead);
  };
  const AuthScreens = {
    async finishLogin() { calls.finishLogin += 1; return null; },
  };
  const window = {
    Offline: { nudge() {} },
    AuthScreens,
    ...(native ? { usernode: { isNative: true } } : {}),
  };
  const sandbox = {
    window, AuthScreens, fetch, AbortController, setTimeout, clearTimeout, console,
  };
  vm.createContext(sandbox);
  const methods = REAL.map(methodSource).join(',\n');
  vm.runInContext(`
    var App = {
      BOOT_SESSION_TIMEOUT_MS: 30,
      embeddedPanel: false,
      user: null,
      _authedBooted: false,
      _signInBegun: ${signInBegun ? 'true' : 'false'},
      _applySafeAreaShot() {},
      bindEvents() {},
      _anonShot() { return false; },
      _waitingShot() { return false; },
      _applyOfflineShot() { return null; },
      readSessionSnapshot() { return null; },
      Visibility: { publish() {} },
      ${methods},
    };
  `, sandbox);
  const App = sandbox.App;
  App.enterAnonymous = async () => { calls.enterAnonymous += 1; App.user = null; };
  App.enterAuthed = (user) => { calls.enterAuthed.push(user); App.user = user; };
  App._dropCachedSession = () => { calls.dropCached += 1; };
  return { App, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('a boot read that times out asks again through the sign-in completion', async () => {
  const { App, calls } = boot({ firstRead: 'hang' });
  await App.init();
  await settle();
  assert.equal(calls.enterAnonymous, 1, 'the anonymous shell is painted, as before');
  assert.equal(calls.finishLogin, 1,
    'and the session is asked for once more, so a slow answer still lets the viewer in');
});

test('a 5xx boot answer asks again too: it said nothing about the session', async () => {
  const { App, calls } = boot({ firstRead: response(503, {}) });
  await App.init();
  await settle();
  assert.equal(calls.enterAnonymous, 1);
  assert.equal(calls.dropCached, 0, 'the cached trace stays (#1608)');
  assert.equal(calls.finishLogin, 1);
});

test('a 401 is a real no: nothing asks again', async () => {
  const { App, calls } = boot({ firstRead: response(401, {}) });
  await App.init();
  await settle();
  assert.equal(calls.enterAnonymous, 1);
  assert.equal(calls.dropCached, 1);
  assert.equal(calls.finishLogin, 0);
});

test('an answered session enters the shell directly and never asks again', async () => {
  const { App, calls } = boot({ firstRead: response(200, { user: { id: 7 } }) });
  await App.init();
  await settle();
  assert.equal(calls.enterAuthed.length, 1);
  assert.equal(calls.enterAnonymous, 0);
  assert.equal(calls.finishLogin, 0);
});

test('the native app and a sign-in already under way are left to their own paths', async () => {
  for (const opts of [{ native: true }, { signInBegun: true }]) {
    const { App, calls } = boot({ firstRead: 'hang', ...opts });
    await App.init();
    await settle();
    assert.equal(calls.enterAnonymous, 1);
    assert.equal(calls.finishLogin, 0, JSON.stringify(opts));
  }
});

test('the boot asks again at most once per document', async () => {
  const { App, calls } = boot({ firstRead: 'hang' });
  await App.init();
  App._adoptLateSession();
  App._adoptLateSession();
  await settle();
  assert.equal(calls.finishLogin, 1);
});
