// Tests for the browser-session user directory (issue #1195) —
// GET /api/app-directory/users/lookup and /users/search in
// src/routes/app-directory.js.
//
// This is the surface the platform shell's `__usernode_directory` relay
// (public/js/app-view.js) fetches on behalf of the signed-in user, and
// therefore the ONLY directory path that works in a staging preview,
// where containers hold no platform token. It shares the matcher in
// src/services/user-directory.js with the app-token twin, so this file
// covers what is specific to it rather than re-testing the matcher:
//
//   • the same { id, username } allowlist reaches the wire,
//   • responses are Cache-Control: no-store (per-user, and the roster
//     changes as people register),
//   • there is NO membership parameter — unlike /api/users/search,
//     whose `excludeApp` filter would tell an app iframe who is already
//     on an app,
//   • 400 for an unusable handle stays distinct from a 200 miss.
//
// Harness shape: same as tests/apps-last-failure-route.test.js —
// override getPool before requiring the route module, mount on a real
// express app behind a stub that sets req.user (authMiddleware runs
// before this router in server.js), hit it over HTTP.
//
// Run with: node --test tests/app-directory-session-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

const SENSITIVE = {
  password: '$2b$10$notarealhash',
  email: 'private@example.com',
  usernode_pubkey: 'npub-secret',
  locale: 'fr',
  is_admin: true,
};

const state = { users: [], lastSearchParams: null, failNext: false };

function user(id, username) {
  return { id, username, ...SENSITIVE };
}

function unescapeLike(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    if (state.failNext) {
      state.failNext = false;
      throw new Error('boom');
    }
    const s = String(sql);
    if (/WHERE LOWER\(username\) = LOWER/.test(s)) {
      const name = params[0];
      const rows = state.users
        .filter((u) => u.username.toLowerCase() === name.toLowerCase())
        .sort((a, b) =>
          (Number(b.username === name) - Number(a.username === name)) || (a.id - b.id))
        .slice(0, 2);
      return { rows };
    }
    if (/LIKE LOWER\(\$1\)/.test(s)) {
      state.lastSearchParams = params;
      const prefix = unescapeLike(params[0]).toLowerCase();
      const rows = state.users
        .filter((u) => u.username.toLowerCase().startsWith(prefix))
        .sort((a, b) =>
          a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || (a.id - b.id))
        .slice(0, params[2]);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
});

const appDirectoryRoutes = require('../src/routes/app-directory');
const express = require('express');

let currentUser = { id: 100, username: 'viewer' };
let server;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appDirectoryRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

async function call(path, qs = '') {
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/app-directory/users/${path}${qs}`
  );
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test.beforeEach(() => {
  state.users = [];
  state.lastSearchParams = null;
  state.failNext = false;
  currentUser = { id: 100, username: 'viewer' };
});

test('lookup resolves a handle to id + username and nothing else', async () => {
  state.users = [user(42, 'alice')];
  const { status, body } = await call('lookup', '?username=alice');
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.deepEqual(body.user, { id: 42, username: 'alice' });
  const wire = JSON.stringify(body);
  for (const value of Object.values(SENSITIVE)) {
    if (typeof value !== 'string') continue;
    assert.equal(wire.includes(value), false, `leaked ${value}`);
  }
});

test('a miss is a 200 with found:false', async () => {
  const { status, body } = await call('lookup', '?username=nobody');
  assert.equal(status, 200);
  assert.deepEqual(body, { found: false, user: null });
});

test('a case-collided pair with no exact match is flagged ambiguous', async () => {
  state.users = [user(9, 'Nova'), user(110, 'nova')];
  const { body } = await call('lookup', '?username=NOVA');
  assert.equal(body.user.id, 9);
  assert.equal(body.ambiguous, true);
});

test('an unusable handle is a 400, distinct from a miss', async () => {
  for (const qs of ['', '?username=', `?username=${'x'.repeat(300)}`]) {
    const { status, body } = await call('lookup', qs);
    assert.equal(status, 400);
    assert.ok(body.error);
  }
});

test('search is a prefix typeahead with has_more', async () => {
  state.users = [
    user(1, 'carla'), user(2, 'carlos'), user(3, 'carmen'), user(4, 'natalie'),
  ];
  const page = await call('search', '?q=car&limit=2');
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.users.map((u) => u.username), ['carla', 'carlos']);
  assert.equal(page.body.has_more, true);

  const all = await call('search', '?q=car');
  assert.equal(all.body.users.length, 3);
  assert.equal(all.body.has_more, false);
});

test('an empty query returns nothing rather than the whole roster', async () => {
  state.users = [user(1, 'alice'), user(2, 'bob')];
  const { status, body } = await call('search', '?q=');
  assert.equal(status, 200);
  assert.deepEqual(body, { users: [], has_more: false });
});

// The reason this router exists instead of reusing /api/users/search:
// that endpoint's excludeApp filter answers "who is already on this
// app?", which nothing an app iframe can reach may expose.
test('no membership filter is honoured on the bridge surface', async () => {
  state.users = [user(1, 'alice')];
  await call('search', '?q=ali&excludeApp=some-app&excludeAppId=7');
  assert.equal(state.lastSearchParams[1], null);
});

test('responses are not cacheable by any shared cache', async () => {
  state.users = [user(1, 'alice')];
  for (const [path, qs] of [['lookup', '?username=alice'], ['search', '?q=ali']]) {
    const { headers } = await call(path, qs);
    const cc = headers.get('cache-control');
    assert.match(cc, /no-store/);
    assert.match(cc, /private/);
  }
});

test('a database failure is a 500 that leaks no detail', async () => {
  state.failNext = true;
  const { status, body } = await call('lookup', '?username=alice');
  assert.equal(status, 500);
  assert.deepEqual(body, { error: 'Internal server error' });
});
