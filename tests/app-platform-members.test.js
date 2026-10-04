// Who is in this project, as an app (and its staging preview) sees it.
//
// A 4 October 2026 first-session run: a group's chore rota, "rotates between
// whoever is in the group", opened as a preview and showed "Staging demo
// Maya's turn · next: Staging demo Jasper" and "next: usernode-capture-admin".
// The app had no way to ask who was in the group, so it guessed: a staging
// fixture of fake people plus the users it had seen, and the check runner
// (usernode-capture-admin) opens every preview.
//
// Covers:
//   • GET /api/app-platform/members (src/routes/app-platform-api.js): a
//     member gets the project's real members, on the app-token path and on
//     the user-token-only path a staging preview uses, with the same body;
//     a non-member (the check runner, an admin looking in) gets 403
//     not_a_member; the `{ id, username }` projection; limit clamping.
//   • src/services/user-directory.js: the platform's own accounts (the
//     usernode-* service identities and synthetic users) are left out of the
//     member list AND the handle lookup/search every app directory reads,
//     while a person whose old handle merely starts with "usernode" is not.
//
// Harness: the same shape as tests/app-platform-directory.test.js (stubbed
// logger, an in-memory pool installed before the route loads, real HTTP on
// loopback, real platform-minted RS256 identities). The fixture pool applies
// the hidden-account filter ONLY when the query carries the clause and binds
// the list, so a service that stopped sending either fails here.
//
// Run with: node --test tests/app-platform-members.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const APP_TOKEN = 'c'.repeat(64);
const APP_ID = 11;
const COMMUNITY_ID = 501;

// Columns a member row must never carry onto the wire.
const SENSITIVE = { email: 'private@example.com', is_admin: true, locale: 'fr', display_name: 'Jordan T' };

const state = {
  users: [],
  members: [],
  blocks: [],
  queries: [],
};

function person(id, username, extra = {}) {
  return { id, username, is_synthetic: false, ...SENSITIVE, ...extra };
}

function hiddenBy(sql, list) {
  return /is_synthetic IS NOT TRUE/.test(sql) && /<> ALL\(\$\d+::text\[\]\)/.test(sql)
    ? (u) => u.is_synthetic || list.includes(u.username.toLowerCase())
    : () => false;
}

function unescapeLike(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

const pool = {
  async query(sql, params = []) {
    const s = String(sql);
    state.queries.push({ sql: s, params });
    if (/SELECT id FROM users WHERE id = \$1/.test(s)) {
      return { rows: state.users.some((u) => u.id === params[0]) ? [{ id: params[0] }] : [] };
    }
    if (/FROM apps WHERE llm_proxy_token/.test(s)) {
      return {
        rows: params[0] === APP_TOKEN
          ? [{ id: APP_ID, slug: 'flat-4b-chores-e98ecd', llm_proxy_token: APP_TOKEN }]
          : [],
      };
    }
    if (/FROM apps WHERE id = \$1/.test(s)) {
      return { rows: params[0] === APP_ID ? [{ id: APP_ID, slug: 'flat-4b-chores-e98ecd' }] : [] };
    }
    // communities.isMember
    if (/JOIN community_members m/.test(s) && /m\.user_id = \$2/.test(s)) {
      const ok = params[0] === APP_ID && state.members.some((m) => m.user_id === params[1]);
      return { rows: ok ? [{ '?column?': 1 }] : [] };
    }
    // user-directory.listAppMembers
    if (/JOIN community_members m/.test(s) && /ORDER BY \(m\.source = 'creator'\) DESC/.test(s)) {
      if (params[0] !== APP_ID) return { rows: [] };
      const hidden = hiddenBy(s, params[1]);
      const blocked = /user_app_blocks/.test(s)
        ? (u) => state.blocks.some((b) => b.user_id === u.id && b.app_id === APP_ID)
        : () => false;
      const rows = state.members
        .slice()
        .sort((a, b) => (Number(b.source === 'creator') - Number(a.source === 'creator'))
          || (a.joined_at - b.joined_at) || (a.user_id - b.user_id))
        .map((m) => state.users.find((u) => u.id === m.user_id))
        .filter((u) => u && !hidden(u) && !blocked(u))
        .slice(0, params[2]);
      return { rows };
    }
    // user-directory.lookupExact
    if (/WHERE LOWER\(username\) = LOWER\(\$1\)/.test(s)) {
      const hidden = hiddenBy(s, params[1]);
      const rows = state.users
        .filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase() && !hidden(u))
        .sort((a, b) => a.id - b.id)
        .slice(0, 2);
      return { rows };
    }
    // user-directory.searchPrefix
    if (/LIKE LOWER\(\$1\)/.test(s)) {
      const hidden = hiddenBy(s, params[3]);
      const prefix = unescapeLike(params[0]).toLowerCase();
      const rows = state.users
        .filter((u) => u.username.toLowerCase().startsWith(prefix) && !hidden(u))
        .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || a.id - b.id)
        .slice(0, params[2]);
      return { rows };
    }
    // usernames.resolveHandle, live arm: it reads users UNFILTERED, which is
    // why lookupExact must not let it answer for a hidden account.
    if (/SELECT id, username FROM users WHERE LOWER\(username\) = \$1/.test(s)) {
      return { rows: state.users.filter((u) => u.username.toLowerCase() === params[0]) };
    }
    // usernames.resolveHandle, retired arm: no renames in this fixture.
    return { rows: [], rowCount: 0 };
  },
};

const poolMod = require('../src/db/pool');
poolMod.getPool = () => pool;

const appPlatformApiRoutes = require('../src/routes/app-platform-api');
const userDirectory = require('../src/services/user-directory');
const usernames = require('../src/services/usernames');
const { trustedProxyClientIp } = require('../src/services/client-ip');
const express = require('express');

let server;
test.before(async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(trustedProxyClientIp({
    hostname: 'caddy.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  app.use(appPlatformApiRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

// The run's people: the maker, the invited member, and the accounts that
// must never be listed even when a row puts them in the community.
const JORDAN = person(1004, 'jordan_t1004');
const SAM = person(1005, 'sam_t1004');
const CAPTURE_ADMIN = person(3, 'usernode-capture-admin', { is_admin: true });
const CAPTURE = person(2, 'usernode-capture');
const BOT = person(9, 'homeroom_bot', { is_synthetic: true });
const LEGACY = person(40, 'usernode_fan'); // a person, from before the prefix was reserved
const BLOCKER = person(41, 'left_the_flat');

test.beforeEach(() => {
  state.users = [JORDAN, SAM, CAPTURE_ADMIN, CAPTURE, BOT, LEGACY, BLOCKER];
  state.members = [
    { user_id: SAM.id, source: 'collaborator', joined_at: 2 },
    { user_id: JORDAN.id, source: 'creator', joined_at: 1 },
    { user_id: CAPTURE_ADMIN.id, source: 'collaborator', joined_at: 3 },
    { user_id: BOT.id, source: 'joined', joined_at: 4 },
    { user_id: BLOCKER.id, source: 'joined', joined_at: 5 },
  ];
  state.blocks = [{ user_id: BLOCKER.id, app_id: APP_ID }];
  state.queries = [];
});

function identity(user, appId = APP_ID) {
  return platformJwt.signAppIdentityToken({ appId, user: { id: user.id, username: user.username } });
}

async function get(pathAndQuery, { appToken = APP_TOKEN, as = JORDAN, root = '/api/app-platform' } = {}) {
  const headers = { 'x-usernode-user-token': identity(as) };
  if (appToken) headers['x-usernode-app-token'] = appToken;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${root}${pathAndQuery}`, { headers });
  return { status: res.status, body: await res.json() };
}

// ── Members ────────────────────────────────────────────────────────────

test('a member gets the real members: creator first, then oldest member first', async () => {
  const { status, body } = await get('/members');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    members: [{ id: 1004, username: 'jordan_t1004' }, { id: 1005, username: 'sam_t1004' }],
    has_more: false,
  });
});

test('a staging preview (user token alone) gets the same real members', async () => {
  const preview = await get('/members', { appToken: null, as: SAM });
  const live = await get('/members', { as: SAM });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, live.body);
  assert.deepEqual(preview.body.members.map((m) => m.username), ['jordan_t1004', 'sam_t1004']);
});

test('the check runner, the bot and someone who blocked the app are never listed', async () => {
  const { body } = await get('/members');
  const names = body.members.map((m) => m.username);
  for (const hidden of ['usernode-capture-admin', 'homeroom_bot', 'left_the_flat']) {
    assert.equal(names.includes(hidden), false, `${hidden} is not one of the group`);
  }
  assert.doesNotMatch(JSON.stringify(body), /Staging demo|usernode/);
});

test('only { id, username } reaches the wire', async () => {
  const { body } = await get('/members');
  for (const m of body.members) assert.deepEqual(Object.keys(m).sort(), ['id', 'username']);
  for (const value of Object.values(SENSITIVE)) {
    if (typeof value === 'string') assert.equal(JSON.stringify(body).includes(value), false);
  }
});

test('a non-member (the check runner opening a preview) gets 403 not_a_member, and no roster is read', async () => {
  state.members = state.members.filter((m) => m.user_id !== CAPTURE_ADMIN.id);
  for (const appToken of [APP_TOKEN, null]) {
    state.queries = [];
    const { status, body } = await get('/members', { appToken, as: CAPTURE_ADMIN });
    assert.equal(status, 403);
    assert.equal(body.code, 'not_a_member');
    assert.equal(body.members, undefined);
    assert.equal(state.queries.some((q) => /ORDER BY \(m\.source = 'creator'\)/.test(q.sql)), false);
  }
});

test('a token minted for another app is refused', async () => {
  const headers = { 'x-usernode-user-token': identity(JORDAN, 99) };
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/app-platform/members`, { headers });
  assert.equal(res.status, 401);
});

test('the v1 path and the unversioned alias answer the same', async () => {
  assert.deepEqual(await get('/members', { root: '/api/app-platform/v1' }), await get('/members'));
});

test('limit defaults to 100, clamps to 1..200, and has_more reports a cut', async () => {
  const listed = () => state.queries.filter((q) => /ORDER BY \(m\.source = 'creator'\)/.test(q.sql)).pop();
  await get('/members');
  assert.equal(listed().params[2], 101);
  await get('/members?limit=999');
  assert.equal(listed().params[2], 201);
  await get('/members?limit=0');
  assert.equal(listed().params[2], 2);
  const { body } = await get('/members?limit=1');
  assert.deepEqual(body.members.map((m) => m.username), ['jordan_t1004']);
  assert.equal(body.has_more, true);
});

// ── The directory leaves the platform's own accounts out ────────────────

test('handle lookup does not find the platform accounts, and still finds people', async () => {
  for (const handle of ['usernode-capture-admin', 'USERNODE-CAPTURE', 'homeroom_bot']) {
    const { status, body } = await get(`/users/lookup?username=${encodeURIComponent(handle)}`);
    assert.equal(status, 200);
    assert.deepEqual(body, { found: false, user: null }, handle);
  }
  const { body } = await get('/users/lookup?username=sam_t1004');
  assert.deepEqual(body.user, { id: 1005, username: 'sam_t1004' });
});

test('prefix search skips the platform accounts but keeps a person whose handle starts with usernode', async () => {
  const { body } = await get('/users/search?q=user');
  assert.deepEqual(body.users.map((u) => u.username), ['usernode_fan']);
  const bot = await get('/users/search?q=home');
  assert.deepEqual(bot.body.users, []);
});

test('the hidden list is the usernode-* service identities, not the staging fixtures', () => {
  for (const name of usernames.SERVICE_IDENTITIES) {
    const lower = name.toLowerCase();
    assert.equal(userDirectory.HIDDEN_USERNAMES.includes(lower), lower.startsWith('usernode'), name);
  }
  // The staging clone's directory fixtures are staging-demo-* handles a
  // preview is meant to find (migrate.js seedStagingUserDirectory).
  assert.equal(userDirectory.HIDDEN_USERNAMES.includes('staging-demo-user'), false);
  assert.ok(userDirectory.HIDDEN_USERNAMES.includes('usernode-capture-admin'));
});

test('every directory query carries the filter, so the platform typeahead and the shell relay get it too', async () => {
  state.queries = [];
  await userDirectory.lookupExact(pool, 'sam_t1004');
  await userDirectory.searchPrefix(pool, 'sam', 5, { excludeAppId: APP_ID });
  await userDirectory.listAppMembers(pool, APP_ID);
  const reads = state.queries.filter((q) => /FROM users|JOIN users/.test(q.sql));
  assert.equal(reads.length, 3);
  for (const q of reads) {
    assert.match(q.sql, /is_synthetic IS NOT TRUE/);
    assert.match(q.sql, /<> ALL\(\$\d+::text\[\]\)/);
    assert.ok(q.params.some((p) => Array.isArray(p) && p.includes('usernode-capture-admin')));
  }
});
