// GET /api/users/search — the platform's own collaborator / app-admin
// invite typeahead (src/routes/collaborators.js).
//
// #1195 moved its matching, LIKE escaping, ordering and projection onto
// the shared services/user-directory.js so the app-facing directory
// endpoints cannot drift from it. That refactor must be exactly
// behaviour-preserving, which is what this file pins:
//
//   • the wire shape stays { users: [...] } — no has_more, which the
//     four call sites in features/dialogs/members-controller.js and the
//     Dev-screen typeahead in public/js/app-view.js do not read,
//   • the cap stays 10,
//   • `excludeApp=<slug>` still resolves to an app id and still filters
//     out users who already hold a row on that app — this endpoint is
//     the one directory surface that MAY answer a membership question,
//     because it is gated on the platform's own session,
//   • an empty query still short-circuits to an empty list without
//     touching the database.
//
// Run with: node --test tests/user-search-typeahead.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

const state = {
  users: [],
  // app slug -> id
  apps: new Map([['tier-lists', 7]]),
  // app id -> Set(user id)
  members: new Map([[7, new Set()]]),
  queries: [],
  lastSearchParams: null,
};

function unescapeLike(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const s = String(sql);
    state.queries.push(s);
    if (/SELECT id FROM apps WHERE slug = \$1/.test(s)) {
      const id = state.apps.get(params[0]);
      return { rows: id ? [{ id }] : [] };
    }
    if (/LIKE LOWER\(\$1\)/.test(s)) {
      state.lastSearchParams = params;
      const prefix = unescapeLike(params[0]).toLowerCase();
      const excludeAppId = params[1];
      const excluded = excludeAppId != null
        ? (state.members.get(excludeAppId) || new Set())
        : new Set();
      const rows = state.users
        .filter((u) => u.username.toLowerCase().startsWith(prefix))
        .filter((u) => !excluded.has(u.id))
        .sort((a, b) =>
          a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || (a.id - b.id))
        .slice(0, params[2]);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
});

const { collaboratorRoutes } = require('../src/routes/collaborators');
const express = require('express');

let server;
test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 100, username: 'viewer' }; next(); });
  app.use(collaboratorRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

async function search(qs = '') {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/users/search${qs}`);
  return { status: res.status, body: await res.json() };
}

test.beforeEach(() => {
  state.users = [];
  state.members = new Map([[7, new Set()]]);
  state.queries = [];
  state.lastSearchParams = null;
});

test('the response shape is { users } — no has_more', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const { status, body } = await search('?q=ali');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ['users']);
  assert.deepEqual(body.users, [{ id: 1, username: 'alice' }]);
});

test('an empty query short-circuits without touching the database', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  for (const qs of ['', '?q=', '?q=%20%20']) {
    state.queries = [];
    const { status, body } = await search(qs);
    assert.equal(status, 200);
    assert.deepEqual(body, { users: [] });
    assert.deepEqual(state.queries, []);
  }
});

test('the cap stays at 10', async () => {
  state.users = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, username: `user${String(i).padStart(2, '0')}`,
  }));
  const { body } = await search('?q=user');
  assert.equal(body.users.length, 10);
  // limit + 1 is fetched so the shared helper can compute has_more; the
  // extra row is dropped before it reaches the wire.
  assert.equal(state.lastSearchParams[2], 11);
});

test('excludeApp filters out users already on that app', async () => {
  state.users = [{ id: 1, username: 'alice' }, { id: 2, username: 'alina' }];
  state.members.set(7, new Set([1]));
  const { body } = await search('?q=ali&excludeApp=tier-lists');
  assert.equal(state.lastSearchParams[1], 7);
  assert.deepEqual(body.users.map((u) => u.username), ['alina']);
});

test('an unknown excludeApp slug degrades to no filter', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const { body } = await search('?q=ali&excludeApp=no-such-app');
  assert.equal(state.lastSearchParams[1], null);
  assert.deepEqual(body.users.map((u) => u.username), ['alice']);
});

test('LIKE metacharacters are still escaped', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const { body } = await search('?q=%25');
  assert.deepEqual(body.users, []);
  assert.equal(state.lastSearchParams[0], '\\%');
});

test('the query is still clipped to 32 characters', async () => {
  await search(`?q=${'a'.repeat(50)}`);
  assert.equal(state.lastSearchParams[0].length, 32);
});
