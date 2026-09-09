// The "sign out before signing in again" dead end (#1608).
//
// Reported from a browser: the sign-in screen came back although nobody had
// signed out, and every attempt to sign in answered "Sign out before signing
// in again." — from a shell whose only sign-out lives on the Settings screen,
// which an anonymous shell cannot reach. Two owners of the truth had drifted
// apart: the server still held a live session for the cookie, the shell was
// painting the signed-out screens, and the session-mint boundary
// (src/routes/auth.js) refused to bridge them.
//
// This file pins the repair on the client side of that boundary: when the
// shell is anonymous, `409 logout_required` ends the stale session and
// replays the credentials instead of reporting an impossible instruction.
// The boundary itself is unchanged and still pinned by
// tests/login-email-identifier.test.js.
//
// Run with: node --test tests/session-mint-stale-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const authSharedSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'auth', 'shared.ts'),
  'utf8'
);

function loadAuthShared(window, fetchImpl) {
  const compiled = ts.transpileModule(authSharedSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    window,
    fetch: fetchImpl,
    console: { warn() {} },
    require(specifier) {
      if (specifier === '../../lib/legacy-dom') {
        return { useIsomorphicLayoutEffect() {} };
      }
      throw new Error(`unexpected auth shared import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(compiled, sandbox);
  return module.exports;
}

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return data; } };
}

const LOGOUT_REQUIRED = response(
  { error: 'Sign out before signing in again.', code: 'logout_required' },
  { ok: false, status: 409 }
);

// A browser realm: no native bridge, no live App.user (the shell is showing
// the sign-in screen), and an App that records the cache drop.
function browserRealm(overrides = {}) {
  const dropped = { count: 0 };
  const window = {
    App: {
      user: null,
      _dropCachedSession() { dropped.count += 1; },
    },
    ...overrides,
  };
  return { window, dropped };
}

// Scripts the fetch responses in order and records every call.
function scriptedFetch(steps) {
  const calls = [];
  return {
    calls,
    impl: async (input, init) => {
      calls.push({ input, init });
      const step = steps.shift();
      if (!step) throw new Error(`unscripted fetch: ${input}`);
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const LOGIN_INIT = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'ada', password: 'pw' }),
};

test('an anonymous shell clears the stale session and signs in, rather than asking for the impossible', async () => {
  const { window, dropped } = browserRealm();
  const ok = response({ user: { id: 7 } });
  const fetches = scriptedFetch([LOGOUT_REQUIRED, response({ ok: true }), ok]);
  const shared = loadAuthShared(window, fetches.impl);

  const res = await shared.fetchSessionMint('/api/auth/login', LOGIN_INIT);

  assert.equal(res, ok, 'the caller receives the retry, not the refusal');
  assert.deepEqual(
    fetches.calls.map((c) => c.input),
    ['/api/auth/login', '/api/auth/logout', '/api/auth/login'],
    'the stale session is ended between the two attempts'
  );
  assert.equal(fetches.calls[1].init.method, 'POST');
  assert.equal(fetches.calls[2].init, LOGIN_INIT,
    'the same credentials are replayed verbatim');
  assert.equal(dropped.count, 1,
    'the display-only residue of the ended session goes with it');
});

test('a live session keeps the original instruction — that viewer really can reach Settings', async () => {
  const { window, dropped } = browserRealm();
  window.App.user = { id: 41 };
  const fetches = scriptedFetch([LOGOUT_REQUIRED]);
  const shared = loadAuthShared(window, fetches.impl);

  const res = await shared.fetchSessionMint('/api/auth/login', LOGIN_INIT);

  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(),
    { error: 'Sign out before signing in again.', code: 'logout_required' });
  assert.deepEqual(fetches.calls.map((c) => c.input), ['/api/auth/login'],
    'no session is ended behind a signed-in viewer');
  assert.equal(dropped.count, 0);
});

test('an unrelated 409 is relayed with its body intact', async () => {
  // Registration answers 409 for a taken username. Reading the body to look
  // for the recovery code must not consume it.
  const { window } = browserRealm();
  const fetches = scriptedFetch([
    response({ error: 'Username already taken' }, { ok: false, status: 409 }),
  ]);
  const shared = loadAuthShared(window, fetches.impl);

  const res = await shared.fetchSessionMint('/api/auth/register', LOGIN_INIT);

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'Username already taken' });
  assert.equal(fetches.calls.length, 1);
});

test('a sign-out the server refuses leaves the original answer on screen', async () => {
  const { window, dropped } = browserRealm();
  const fetches = scriptedFetch([
    LOGOUT_REQUIRED,
    response({ error: 'Internal server error' }, { ok: false, status: 500 }),
  ]);
  const shared = loadAuthShared(window, fetches.impl);

  const res = await shared.fetchSessionMint('/api/auth/login', LOGIN_INIT);

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(),
    { error: 'Sign out before signing in again.', code: 'logout_required' });
  assert.equal(fetches.calls.length, 2, 'the credentials are not replayed blind');
  assert.equal(dropped.count, 0,
    'nothing local is dropped while the server still holds the session');
});

test('a logout that never lands is not treated as one that did', async () => {
  const { window } = browserRealm();
  const fetches = scriptedFetch([LOGOUT_REQUIRED, new Error('offline')]);
  const shared = loadAuthShared(window, fetches.impl);

  const res = await shared.fetchSessionMint('/api/auth/login', LOGIN_INIT);

  assert.equal(res.status, 409);
  assert.equal(fetches.calls.length, 2);
});

test('the retry is an ordinary mint request, so native prepares for it again', async () => {
  // The A -> B ordering the native protocol requires is per REQUEST: the
  // shell closes, drains and revokes its retained native session before each
  // one. A replay that skipped it would mint B against an un-drained A.
  let prepared = 0;
  const { window } = browserRealm({
    usernode: { isNative: true },
    NativeChrome: {
      async prepareForLogin() { prepared += 1; return true; },
      lastSessionFailure() { return null; },
    },
  });
  const ok = response({ user: { id: 7 } });
  const fetches = scriptedFetch([LOGOUT_REQUIRED, response({ ok: true }), ok]);
  const shared = loadAuthShared(window, fetches.impl);

  assert.equal(await shared.fetchSessionMint('/api/auth/login', LOGIN_INIT), ok);
  assert.equal(prepared, 2, 'once per credential submit, including the replay');
});

test('native preparation still gates the first request, and its failure is reported as itself', async () => {
  const failure = new Error('bridge is gone');
  const { window } = browserRealm({
    usernode: { isNative: true },
    NativeChrome: {
      async prepareForLogin() { throw failure; },
      lastSessionFailure() {
        return { stage: 'prepare-login', code: 'native_session_recovery_uncertain' };
      },
    },
  });
  const fetches = scriptedFetch([]);
  const shared = loadAuthShared(window, fetches.impl);

  const error = await shared.fetchSessionMint('/api/auth/login', LOGIN_INIT)
    .then(() => null, (e) => e);
  assert.equal(fetches.calls.length, 0);
  assert.match(shared.sessionMintFailureMessage(error),
    /Secure app session could not be prepared/);
});
