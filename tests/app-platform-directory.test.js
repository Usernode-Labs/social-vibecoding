// Tests for the app-facing user directory (issue #1195) —
// GET /api/app-platform/users/lookup and /users/search in
// src/routes/app-platform-api.js, the `{ requireUser: true }` variant of
// appPlatformAuth in src/middleware/app-llm-auth.js, and the shared
// matcher in src/services/user-directory.js.
//
// Covers: the auth matrix (private-IP gate, missing/malformed/unknown
// app token, missing/forged/cross-app user token, and the #1213
// user-token-only path staging previews use — including that the feed's
// plain appPlatformAuth config still rejects it), the FIELD ALLOWLIST
// (only id + username ever reach the wire, even when the row carries
// email/password/is_admin), exact lookup including the case-collision
// rule, prefix search with limit clamping and has_more, LIKE-metacharacter
// escaping, and the absence of any app-membership parameter.
//
// Harness shape: same as tests/app-platform-feed.test.js — stub the
// logger, override getPool with an in-memory fixture pool BEFORE
// requiring the route module, mount on a real express app, hit it over
// HTTP (loopback passes the private-IP gate; the non-private case uses
// the verified-proxy client-IP middleware). User tokens are real
// platform-minted RS256 identities from tests/platform-keys.
//
// Run with: node --test tests/app-platform-directory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

const keys = require('./platform-keys').setPlatformKeys();
const jwt = require('jsonwebtoken');
const platformJwt = require('../src/services/platform-jwt');

const APP_A_TOKEN = 'a'.repeat(64);
const APP_B_TOKEN = 'b'.repeat(64);
const APP_A_ID = 1;
const APP_B_ID = 2;

// Fixture rows deliberately carry columns the directory must NEVER
// return, so a widened SELECT list shows up as a failing assertion
// rather than as a quiet privacy regression.
const SENSITIVE = {
  password: '$2b$10$notarealhash',
  email: 'private@example.com',
  usernode_pubkey: 'npub-secret',
  locale: 'fr',
  is_admin: true,
  created_at: '2020-01-01T00:00:00.000Z',
};

const state = {
  apps: [
    { id: APP_A_ID, slug: 'tier-lists', llm_proxy_token: APP_A_TOKEN },
    { id: APP_B_ID, slug: 'game-corner', llm_proxy_token: APP_B_TOKEN },
  ],
  users: [],
  lastSearchParams: null,
};

function user(id, username) {
  return { id, username, ...SENSITIVE };
}

// Assert no sensitive column reached the wire — by key on every user
// object, and by value for the string-valued ones (a bare `true` would
// collide with `found: true`, so booleans are covered by the key check).
function assertNoLeak(body, users) {
  for (const u of users) {
    for (const key of Object.keys(SENSITIVE)) {
      assert.equal(key in u, false, `leaked column ${key}`);
    }
  }
  const wire = JSON.stringify(body);
  for (const value of Object.values(SENSITIVE)) {
    if (typeof value !== 'string') continue;
    assert.equal(wire.includes(value), false, `leaked value ${value}`);
  }
}

// Undo the service's LIKE escaping so the fixture can do a plain
// JS prefix compare. Escaping itself is asserted directly further down.
function unescapeLike(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

const pool = {
  async query(sql, params) {
    const s = String(sql);
    if (/FROM apps WHERE llm_proxy_token/.test(s)) {
      const app = state.apps.find((a) => a.llm_proxy_token === params[0]);
      return { rows: app ? [app] : [] };
    }
    // The user-token-only path (#1213): the middleware loads the app row
    // by the id the verified token's audience names.
    if (/FROM apps WHERE id = \$1/.test(s)) {
      const app = state.apps.find((a) => a.id === params[0]);
      return { rows: app ? [{ id: app.id, slug: app.slug }] : [] };
    }
    // lookupExact: case-insensitive equality, exact-case first, then id.
    if (/WHERE LOWER\(username\) = LOWER/.test(s)) {
      const name = params[0];
      const rows = state.users
        .filter((u) => u.username.toLowerCase() === name.toLowerCase())
        .sort((a, b) =>
          (Number(b.username === name) - Number(a.username === name)) || (a.id - b.id))
        .slice(0, 2);
      return { rows };
    }
    // searchPrefix: case-insensitive prefix, ordered by lower(name), id.
    if (/LIKE LOWER\(\$1\)/.test(s)) {
      state.lastSearchParams = params;
      const prefix = unescapeLike(params[0]).toLowerCase();
      const limit = params[2];
      const rows = state.users
        .filter((u) => u.username.toLowerCase().startsWith(prefix))
        .sort((a, b) =>
          a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || (a.id - b.id))
        .slice(0, limit);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
};

const poolMod = require('../src/db/pool');
poolMod.getPool = () => pool;

const appPlatformApiRoutes = require('../src/routes/app-platform-api');
const { trustedProxyClientIp } = require('../src/services/client-ip');

const express = require('express');

let server;
test.before(async () => {
  const app = express();
  // Model Caddy as this test server's loopback peer, exactly as the
  // feed test does — forwarded client data is trusted only from it.
  app.set('trust proxy', false);
  app.use(trustedProxyClientIp({
    hostname: 'caddy.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  app.use(appPlatformApiRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

// A real platform-minted identity for the given app.
function userJwt({ appId = APP_A_ID, id = 7, username = 'tester', ttl } = {}) {
  return platformJwt.signAppIdentityToken({ appId, user: { id, username }, ttl });
}

function url(path, qs = '') {
  return `http://127.0.0.1:${server.address().port}/api/app-platform/users/${path}${qs}`;
}

async function call(path, {
  token = APP_A_TOKEN, userToken = userJwt(), qs = '', headers = {},
} = {}) {
  const h = { ...headers };
  if (token != null) h['x-usernode-app-token'] = token;
  if (userToken != null) h['x-usernode-user-token'] = userToken;
  const res = await fetch(url(path, qs), { headers: h });
  return { status: res.status, body: await res.json() };
}

const lookup = (opts) => call('lookup', opts);
const search = (opts) => call('search', opts);

test.beforeEach(() => {
  state.users = [];
  state.lastSearchParams = null;
});

// ── Auth matrix ──────────────────────────────────────────────────────

test('non-private source IP is rejected', async () => {
  const { status, body } = await lookup({
    qs: '?username=alice', headers: { 'x-forwarded-for': '8.8.8.8' },
  });
  assert.equal(status, 403);
  assert.equal(body.code, 'forbidden_ip');
});

test('neither credential is still missing_app_token — the pre-#1213 contract', async () => {
  for (const path of ['lookup', 'search']) {
    const { status, body } = await call(path, {
      token: null, userToken: null, qs: '?username=alice&q=a',
    });
    assert.equal(status, 401);
    assert.equal(body.code, 'missing_app_token');
  }
});

test('malformed app token is rejected without a lookup', async () => {
  for (const bad of ['deadbeef', 'Z'.repeat(64), 'a'.repeat(63)]) {
    const { status, body } = await lookup({ token: bad, qs: '?username=alice' });
    assert.equal(status, 401);
    assert.equal(body.code, 'missing_app_token');
  }
});

test('unknown app token is rejected', async () => {
  const { status, body } = await lookup({ token: 'f'.repeat(64), qs: '?username=alice' });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_app_token');
});

// The directory is the user-token variant — unlike the governance feed,
// which is app-token only. An app token on its own must not read it.
test('app token alone is not enough — the user token is required', async () => {
  for (const path of ['lookup', 'search']) {
    const { status, body } = await call(path, { userToken: null, qs: '?username=a&q=a' });
    assert.equal(status, 401);
    assert.equal(body.code, 'missing_user_token');
  }
});

test('garbage user token is rejected', async () => {
  const { status, body } = await lookup({ userToken: 'not.a.jwt', qs: '?username=alice' });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_user_token');
});

test('expired user token is rejected', async () => {
  const { status, body } = await lookup({ userToken: userJwt({ ttl: -60 }), qs: '?username=alice' });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_user_token');
});

// The cross-app replay closure: a token minted for app A carries
// audience usernode:app:1 and must not be spendable through app B.
test('a user token minted for another app is rejected', async () => {
  state.users = [user(42, 'alice')];
  const { status, body } = await lookup({
    token: APP_B_TOKEN,
    userToken: userJwt({ appId: APP_A_ID }),
    qs: '?username=alice',
  });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_user_token');
});

test('a scoped infrastructure token is rejected even when otherwise valid', async () => {
  const forged = jwt.sign(
    { id: 7, username: 'tester', pur: 'iframe', scope: 'infra' },
    keys.IFRAME_JWT_PRIVATE_KEY,
    { algorithm: 'RS256', issuer: 'usernode', audience: `usernode:app:${APP_A_ID}`, expiresIn: '1h' }
  );
  const { status, body } = await lookup({ userToken: forged, qs: '?username=alice' });
  assert.equal(status, 403);
  assert.equal(body.code, 'bad_user_token');
});

// ── User-token-only (staging previews, #1213) ────────────────────────
//
// Preview containers get USERNODE_PLATFORM_API_URL but no app token, so
// the two directory routes — and only these — also accept the caller's
// forwarded iframe token on its own. The token's audience picks which
// app id the verifier pins; the SIGNATURE is what authenticates it.

// Rebuild a signed token with a swapped audience, keeping the original
// signature — the forgery the unverified-aud read must not fall for.
function tamperAudience(token, aud) {
  const [h, p, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.aud = aud;
  const p2 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${h}.${p2}.${sig}`;
}

test('no app token + a valid user token succeeds, same body, no leak', async () => {
  state.users = [user(42, 'alice')];
  const viaAppToken = await lookup({ qs: '?username=alice' });
  const viaUserToken = await lookup({ token: null, qs: '?username=alice' });
  assert.equal(viaUserToken.status, 200);
  // Byte-identical answer on both auth paths.
  assert.deepEqual(viaUserToken.body, viaAppToken.body);
  assert.deepEqual(viaUserToken.body.user, { id: 42, username: 'alice' });
  assertNoLeak(viaUserToken.body, [viaUserToken.body.user]);

  state.users = [user(1, 'alice'), user(2, 'alina')];
  const s = await search({ token: null, qs: '?q=ali' });
  assert.equal(s.status, 200);
  assert.equal(s.body.users.length, 2);
  for (const u of s.body.users) {
    assert.deepEqual(Object.keys(u).sort(), ['id', 'username']);
  }
  assertNoLeak(s.body, s.body.users);
});

test('a tampered audience cannot redirect the app identity', async () => {
  state.users = [user(42, 'alice')];
  // Minted for app A, aud swapped to app B without re-signing: the aud
  // read picks app B, so verification pins app B's audience and the
  // signature no longer verifies.
  const forged = tamperAudience(userJwt({ appId: APP_A_ID }), `usernode:app:${APP_B_ID}`);
  const { status, body } = await lookup({ token: null, userToken: forged, qs: '?username=alice' });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_user_token');
});

test('an audience naming an unknown app is rejected', async () => {
  const { status, body } = await lookup({
    token: null, userToken: userJwt({ appId: 999 }), qs: '?username=alice',
  });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_app_token');
});

test('garbage / non-app-audience / expired tokens fail alone too', async () => {
  for (const bad of [
    'not.a.jwt',
    // Signed, but the audience is not usernode:app:<id> — nothing to pin.
    jwt.sign({ id: 7, username: 'tester', pur: 'iframe' }, keys.IFRAME_JWT_PRIVATE_KEY, {
      algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:infra', expiresIn: '1h',
    }),
    userJwt({ ttl: -60 }),
  ]) {
    const { status, body } = await lookup({ token: null, userToken: bad, qs: '?username=alice' });
    assert.equal(status, 401);
    assert.equal(body.code, 'bad_user_token');
  }
});

test('the governance feed does NOT accept a user token alone', async () => {
  // The feed keeps plain appPlatformAuth (allowUserTokenOnly unset) —
  // app-scoped data that unreviewed preview code has no business reading.
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/app-platform/governance/feed`,
    { headers: { 'x-usernode-user-token': userJwt() } }
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'missing_app_token');
});

// ── Field allowlist ──────────────────────────────────────────────────

test('lookup returns only id and username — never anything else on the row', async () => {
  state.users = [user(42, 'alice')];
  const { status, body } = await lookup({ qs: '?username=alice' });
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.deepEqual(Object.keys(body.user).sort(), ['id', 'username']);
  assert.deepEqual(body.user, { id: 42, username: 'alice' });
  assertNoLeak(body, [body.user]);
});

test('search returns only id and username for every row', async () => {
  state.users = [user(1, 'alice'), user(2, 'alina')];
  const { status, body } = await search({ qs: '?q=ali' });
  assert.equal(status, 200);
  assert.equal(body.users.length, 2);
  for (const u of body.users) {
    assert.deepEqual(Object.keys(u).sort(), ['id', 'username']);
  }
  assertNoLeak(body, body.users);
});

// ── Exact lookup ─────────────────────────────────────────────────────

test('a miss is a 200 with found:false, not a 404', async () => {
  state.users = [user(1, 'alice')];
  const { status, body } = await lookup({ qs: '?username=nobody' });
  assert.equal(status, 200);
  assert.deepEqual(body, { found: false, user: null });
});

test('lookup is case-insensitive and returns the canonical stored casing', async () => {
  state.users = [user(9, 'Alice')];
  const { status, body } = await lookup({ qs: '?username=ALICE' });
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.equal(body.user.username, 'Alice');
  assert.equal(body.ambiguous, undefined);
});

// users.username is UNIQUE but case-SENSITIVE, and registration
// normalizes nothing — Drea/drea exists in production today.
test('an exact-case match wins outright over a case-collided sibling', async () => {
  state.users = [user(9, 'Drea'), user(110, 'drea')];
  const exact = await lookup({ qs: '?username=drea' });
  assert.equal(exact.body.user.id, 110);
  assert.equal(exact.body.ambiguous, undefined);

  const other = await lookup({ qs: '?username=Drea' });
  assert.equal(other.body.user.id, 9);
  assert.equal(other.body.ambiguous, undefined);
});

test('a case-collided pair with no exact match is flagged ambiguous', async () => {
  state.users = [user(9, 'Drea'), user(110, 'drea')];
  const { status, body } = await lookup({ qs: '?username=DREA' });
  assert.equal(status, 200);
  assert.equal(body.found, true);
  // Lowest id, so the answer is at least deterministic.
  assert.equal(body.user.id, 9);
  assert.equal(body.ambiguous, true);
});

test('a missing or empty username is a 400, distinct from a miss', async () => {
  for (const qs of ['', '?username=', '?username=%20%20']) {
    const { status, body } = await lookup({ qs });
    assert.equal(status, 400);
    assert.equal(body.code, 'bad_request');
  }
});

test('an over-long username is a 400, not a table scan', async () => {
  const { status } = await lookup({ qs: `?username=${'x'.repeat(300)}` });
  assert.equal(status, 400);
});

// ── Prefix search ────────────────────────────────────────────────────

test('search is a prefix match, not a substring match', async () => {
  state.users = [user(1, 'alice'), user(2, 'natalie')];
  const { body } = await search({ qs: '?q=ali' });
  assert.deepEqual(body.users.map((u) => u.username), ['alice']);
});

test('search orders case-insensitively by username', async () => {
  state.users = [user(3, 'carter'), user(1, 'Carla'), user(2, 'carmen')];
  const { body } = await search({ qs: '?q=car' });
  assert.deepEqual(body.users.map((u) => u.username), ['Carla', 'carmen', 'carter']);
});

test('has_more reports whether the prefix has more rows than the limit', async () => {
  state.users = [
    user(1, 'car1'), user(2, 'car2'), user(3, 'car3'),
    user(4, 'car4'), user(5, 'car5'),
  ];
  const limited = await search({ qs: '?q=car&limit=4' });
  assert.equal(limited.body.users.length, 4);
  assert.equal(limited.body.has_more, true);

  const all = await search({ qs: '?q=car&limit=10' });
  assert.equal(all.body.users.length, 5);
  assert.equal(all.body.has_more, false);
});

test('limit clamps at both ends and defaults when absent', async () => {
  state.users = [user(1, 'alice')];
  await search({ qs: '?q=a&limit=999' });
  assert.equal(state.lastSearchParams[2], 26); // 25 + 1

  await search({ qs: '?q=a&limit=0' });
  assert.equal(state.lastSearchParams[2], 2); // 1 + 1

  await search({ qs: '?q=a&limit=notanumber' });
  assert.equal(state.lastSearchParams[2], 11); // default 10 + 1

  await search({ qs: '?q=a' });
  assert.equal(state.lastSearchParams[2], 11);
});

test('an empty query returns nothing rather than the whole table', async () => {
  state.users = [user(1, 'alice'), user(2, 'bob')];
  for (const qs of ['?q=', '', '?q=%20']) {
    const { status, body } = await search({ qs });
    assert.equal(status, 200);
    assert.deepEqual(body, { users: [], has_more: false });
  }
});

// A bare % would otherwise match every row.
test('LIKE metacharacters in the query are escaped', async () => {
  state.users = [user(1, 'alice'), user(2, 'bob')];
  const { body } = await search({ qs: '?q=%25' });
  assert.deepEqual(body.users, []);
  assert.equal(state.lastSearchParams[0], '\\%');

  await search({ qs: '?q=a_b' });
  assert.equal(state.lastSearchParams[0], 'a\\_b');
});

test('the app-facing search has no membership filter to tamper with', async () => {
  state.users = [user(1, 'alice')];
  // excludeApp is the platform typeahead's parameter; it must not be
  // honoured here — an app must not learn who is on another app.
  await search({ qs: '?q=ali&excludeApp=tier-lists' });
  assert.equal(state.lastSearchParams[1], null);
});

// ── Service-level unit checks ────────────────────────────────────────

const userDirectory = require('../src/services/user-directory');

test('the projection allowlist is exactly id + username', () => {
  assert.deepEqual(userDirectory.USER_FIELDS, ['id', 'username']);
  assert.deepEqual(
    userDirectory.projectUser({ id: 1, username: 'a', ...SENSITIVE }),
    { id: 1, username: 'a' }
  );
});

test('escapeLike escapes backslash, percent and underscore', () => {
  assert.equal(userDirectory.escapeLike('100%_a\\b'), '100\\%\\_a\\\\b');
});
