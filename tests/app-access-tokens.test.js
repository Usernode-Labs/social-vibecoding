// Personal access tokens for an app (25 Nov 2026).
//
// A team's private app wanted its members' own assistants to call it (an
// MCP server at /mcp). Nothing with no browser behind it could reach a
// private app, and an app could not check on such a call that its caller
// was still a member. So Homeroom makes the tokens and checks them at the
// app's door on every request.
//
// What this pins:
//   * src/services/app-access-tokens.js: which Authorization values are
//     ours, which dapp.json `agentPaths` are accepted, and what a declared
//     path matches;
//   * the door (src/services/edge-gate.js): a live token of a member opens a
//     private app's declared path, as that member, and nothing else does:
//     not another path, not a preview, not another app's token, not a
//     revoked one, not one whose owner has left (whose tokens are then
//     revoked), and every refusal is the same bare 401;
//   * the app API (src/routes/app-platform-api.js): only a member makes,
//     lists and revokes their own tokens, with both credentials; the token
//     is returned once and only its hash is stored.
//
// The pool is stubbed via require.cache, the tests/edge-gate.test.js pattern.
//
// Run with: node --test tests/app-access-tokens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.EDGE_JWT_SECRET = 'app-access-tokens-test-edge-secret';
delete process.env.APP_HOST_SIGNIN;
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

// USERNODE_DOMAIN env is unset in tests: services/caddy.js default.
const DOMAIN = 'social-vibecoding.usernodelabs.org';
const HOST = `team.${DOMAIN}`;
const PREVIEW_HOST = `team--s42.${DOMAIN}`;
const OTHER_HOST = `other.${DOMAIN}`;
const PLAIN_HOST = `plain.${DOMAIN}`;
const APP_TOKEN = 'd'.repeat(64);
const APPS = {
  team: { id: 7, slug: 'team', view_visibility: 'private', agent_paths: ['/mcp'] },
  other: { id: 8, slug: 'other', view_visibility: 'private', agent_paths: ['/mcp'] },
  plain: { id: 9, slug: 'plain', view_visibility: 'private', agent_paths: null },
};
const MEMBER = 10;
const SECOND = 11;
const OUTSIDER = 99;

const state = { members: new Set(), joined: new Map(), tokens: [], nextId: 1 };
function reset() {
  state.members = new Set([`7:${MEMBER}`, `7:${SECOND}`, `8:${MEMBER}`, `9:${MEMBER}`]);
  state.joined = new Map();
  state.tokens = [];
  state.nextId = 1;
}
reset();
const byId = (id) => Object.values(APPS).find((a) => a.id === Number(id));
const live = (t) => !t.revoked_at;

const fakePool = {
  async query(sql, params = []) {
    const s = String(sql);
    if (/SELECT id, view_visibility, moderation_suspended_at,[\s\S]*?FROM apps WHERE slug/.test(s)) {
      const app = APPS[params[0]];
      return { rows: app ? [{ id: app.id, view_visibility: app.view_visibility, agent_paths: app.agent_paths }] : [] };
    }
    if (/SELECT view_visibility, moderation_suspended_at FROM apps WHERE id/.test(s)) {
      const app = byId(params[0]);
      return { rows: app ? [{ view_visibility: app.view_visibility }] : [] };
    }
    if (/FROM apps WHERE llm_proxy_token/.test(s)) {
      return { rows: params[0] === APP_TOKEN ? [{ id: 7, slug: 'team', llm_proxy_token: APP_TOKEN }] : [] };
    }
    if (/FROM user_app_blocks/.test(s)) return { rows: [] };
    if (/FROM app_collaborators WHERE app_id = \$1 AND status = 'member'/.test(s)) {
      return { rows: [...state.members].filter((k) => k.startsWith(`${params[0]}:`)).map((k) => ({ user_id: Number(k.split(':')[1]) })) };
    }
    if (/SELECT is_admin FROM users WHERE id/.test(s)) return { rows: [{ is_admin: false }] };
    if (/SELECT id FROM users WHERE id = \$1/.test(s)) return { rows: [{ id: params[0] }] };
    // app-access-tokens.heldSinceJoining
    if (/SELECT m\.joined_at\s+FROM apps a\s+JOIN community_members m/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      return { rows: state.members.has(key) ? [{ joined_at: state.joined.get(key) || new Date('2026-01-01T00:00:00Z') }] : [] };
    }
    // communities.isMember
    if (/JOIN community_members m/.test(s) && /m\.user_id = \$2/.test(s)) {
      return { rows: state.members.has(`${params[0]}:${params[1]}`) ? [{ '?column?': 1 }] : [] };
    }
    // edge-gate mintIdentity
    if (/SELECT id, username, usernode_pubkey, locale, is_synthetic,/.test(s)) {
      return { rows: [{ id: params[0], username: `u${params[0]}`, usernode_pubkey: null, locale: 'en', is_synthetic: false }] };
    }
    if (/INSERT INTO app_access_tokens/.test(s)) {
      const [appId, userId, name, hash, hint, max] = params;
      if (state.tokens.filter((t) => t.app_id === appId && t.user_id === userId && live(t)).length >= max) return { rows: [] };
      const row = { id: state.nextId++, app_id: appId, user_id: userId, name, token_hash: hash, hint,
        created_at: new Date('2026-11-25T10:00:00Z'), last_used_at: null, revoked_at: null };
      state.tokens.push(row);
      return { rows: [row] };
    }
    if (/SELECT id, name, hint, created_at, last_used_at\s+FROM app_access_tokens/.test(s)) {
      return { rows: state.tokens.filter((t) => t.app_id === params[0] && t.user_id === params[1] && live(t)) };
    }
    if (/SELECT id, app_id, user_id, created_at FROM app_access_tokens\s+WHERE token_hash = \$1 AND revoked_at IS NULL/.test(s)) {
      return { rows: state.tokens.filter((t) => t.token_hash === params[0] && live(t)) };
    }
    if (/UPDATE app_access_tokens SET revoked_at = NOW\(\)\s+WHERE id = \$1 AND app_id = \$2 AND user_id = \$3/.test(s)) {
      const hit = state.tokens.filter((t) => String(t.id) === params[0] && t.app_id === params[1] && t.user_id === params[2] && live(t));
      hit.forEach((t) => { t.revoked_at = new Date(); });
      return { rows: hit.map((t) => ({ id: t.id })) };
    }
    if (/UPDATE app_access_tokens SET revoked_at = NOW\(\)\s+WHERE app_id = \$1 AND user_id = \$2/.test(s)) {
      state.tokens.filter((t) => t.app_id === params[0] && t.user_id === params[1]).forEach((t) => { t.revoked_at = t.revoked_at || new Date(); });
      return { rows: [] };
    }
    if (/UPDATE app_access_tokens SET last_used_at = NOW\(\) WHERE id = \$1/.test(s)) {
      state.tokens.filter((t) => String(t.id) === String(params[0])).forEach((t) => { t.last_used_at = new Date(); });
      return { rows: [] };
    }
    throw new Error(`app-access-tokens stub: unexpected query: ${s}`);
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };
for (const mod of ['app-access', 'app-domains', 'edge-gate', 'app-access-tokens']) {
  delete require.cache[require.resolve(`../src/services/${mod}`)];
}
delete require.cache[require.resolve('../src/routes/internal')];
delete require.cache[require.resolve('../src/routes/app-platform-api')];

const accessTokens = require('../src/services/app-access-tokens');
const appAccess = require('../src/services/app-access');
const edgeGate = require('../src/services/edge-gate');
const { internalRoutes } = require('../src/routes/internal');
const appPlatformApiRoutes = require('../src/routes/app-platform-api');

let server;
let baseUrl;
test.before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(internalRoutes({}));
  app.use(appPlatformApiRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  reset();
  appAccess.invalidateAllVisibility();
  edgeGate._resetCachesForTest();
  accessTokens.resetForTest();
});

function request(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// What an edge sends for an agent's call: no cookie, no browser headers.
function gate({ host = HOST, uri = '/mcp', method = 'POST', bearer, extra } = {}) {
  return request('GET', '/__caddy/access', {
    Host: host,
    'X-Forwarded-Host': host,
    'X-Forwarded-Method': method,
    'X-Forwarded-Uri': uri,
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(extra || {}),
  });
}

const identity = (id, appId = 7) => platformJwt.signAppIdentityToken({ appId, user: { id, username: `u${id}` } });
function api(method, pathname, { user = MEMBER, appToken = APP_TOKEN, body } = {}) {
  return request(method, `/api/app-platform/v1${pathname}`, {
    ...(appToken ? { 'x-usernode-app-token': appToken } : {}),
    ...(user ? { 'x-usernode-user-token': identity(user) } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
  }, body);
}
async function makeToken(appId = 7, userId = MEMBER, name = 'Laptop') {
  const made = await accessTokens.create(fakePool, { appId, userId, name });
  return made.token;
}
// The one answer every refusal gives.
function assertBare401(r) {
  assert.equal(r.status, 401);
  assert.equal(r.body, 'Unauthorized');
  assert.equal(r.headers['www-authenticate'], 'Bearer');
  assert.equal(r.headers['x-usernode-identity'], undefined);
}

// ── the service ────────────────────────────────────────────────────────

test('only a Bearer hrat_ value is one of ours', () => {
  assert.equal(accessTokens.bearerOf('Bearer hrat_abc'), 'hrat_abc');
  assert.equal(accessTokens.bearerOf('bearer  hrat_abc '), 'hrat_abc');
  assert.equal(accessTokens.bearerOf('Bearer some-app-key'), null);
  assert.equal(accessTokens.bearerOf('Basic aHJhdF86eA=='), null);
  assert.equal(accessTokens.bearerOf(undefined), null);
});

test('agentPaths are kept only when every entry is a plain path', () => {
  assert.deepEqual(accessTokens.cleanAgentPaths(['/mcp']), ['/mcp']);
  assert.deepEqual(accessTokens.cleanAgentPaths(['/mcp', '/agents/v1', '/mcp']), ['/mcp', '/agents/v1']);
  for (const bad of [
    null, '/mcp', [], ['/'], ['mcp'], ['/mcp/'], ['/a/../b'], ['/a/./b'], ['/mcp?x=1'], ['/m cp'],
    ['/%6dcp'], ['/__usernode_access'], ['/__Usernode_access/x'], ['/mcp', 7],
    ['/a', '/b', '/c', '/d'], ['/' + 'a'.repeat(64)],
  ]) {
    assert.deepEqual(accessTokens.cleanAgentPaths(bad), [], JSON.stringify(bad));
  }
});

test('a declared path matches itself and what is under it, nothing beside it', () => {
  const paths = ['/mcp'];
  assert.equal(accessTokens.onAgentPath(paths, '/mcp'), true);
  assert.equal(accessTokens.onAgentPath(paths, '/mcp/messages'), true);
  for (const other of ['/', '/mcpx', '/api/mcp', '/mcp/../api/people', '/mcp/%2e%2e/api', '/MCP', '/mcp\\x']) {
    assert.equal(accessTokens.onAgentPath(paths, other), false, other);
  }
  assert.equal(accessTokens.onAgentPath([], '/mcp'), false);
});

test('a token is 32 random bytes behind the prefix and only its hash is kept', async () => {
  const token = await makeToken();
  assert.match(token, /^hrat_[A-Za-z0-9_-]{43}$/);
  const row = state.tokens[0];
  assert.equal(row.token_hash, accessTokens.hashToken(token));
  assert.equal(JSON.stringify(row).includes(token), false);
  assert.equal(row.hint, token.slice(-4));
  assert.deepEqual(await accessTokens.resolve(fakePool, token),
    { id: '1', appId: 7, userId: MEMBER, createdAt: new Date('2026-11-25T10:00:00Z') });
  assert.equal(await accessTokens.resolve(fakePool, 'hrat_nope'), null);
  assert.equal(await accessTokens.resolve(fakePool, `${token}x`), null);
});

// ── the door ───────────────────────────────────────────────────────────

test('a member\'s token opens the declared path of a private app, as that member', async () => {
  const token = await makeToken();
  for (const uri of ['/mcp', '/mcp/messages?session=1']) {
    const r = await gate({ bearer: token, uri });
    assert.equal(r.status, 200, uri);
    const claims = platformJwt.verifyAppIdentityToken(r.headers['x-usernode-identity'], { appId: 7 });
    assert.equal(claims.id, MEMBER);
    assert.equal(claims.username, `u${MEMBER}`);
    // Marked, so the AI proxy, storage and the directory refuse it.
    assert.equal(claims.scope, 'access_token');
  }
  assert.ok(state.tokens[0].last_used_at, 'its use is noted');
});

test('without a token, or with a wrong one, a declared path answers a bare 401', async () => {
  assertBare401(await gate({}));
  assertBare401(await gate({ bearer: 'hrat_' + 'A'.repeat(43) }));
  assertBare401(await gate({ bearer: 'hrat_short' }));
});

test('a token opens nothing but the declared path', async () => {
  const token = await makeToken();
  for (const uri of ['/', '/api/people', '/mcpx', '/mcp/../api/people', '/mcp/%2e%2e/api/people']) {
    assertBare401(await gate({ bearer: token, uri }));
  }
  // An app that declared no path: its member's token opens nothing.
  const plain = await makeToken(9);
  assertBare401(await gate({ host: PLAIN_HOST, bearer: plain }));
});

test('a token never works on a preview, on another app, or over a WebSocket', async () => {
  const token = await makeToken();
  assertBare401(await gate({ host: PREVIEW_HOST, bearer: token }));
  // The same member belongs to the other app too: the token is still not its.
  assertBare401(await gate({ host: OTHER_HOST, bearer: token }));
  assertBare401(await gate({ bearer: token, method: 'GET', extra: { 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } }));
});

test('a revoked token is refused at once', async () => {
  const token = await makeToken();
  assert.equal((await gate({ bearer: token })).status, 200);
  assert.equal(await accessTokens.revoke(fakePool, { appId: 7, userId: MEMBER, id: '1' }), true);
  assertBare401(await gate({ bearer: token }));
});

test('a member who has left is refused, and their tokens are revoked for good', async () => {
  const token = await makeToken();
  const second = await makeToken(7, MEMBER, 'Phone');
  state.members.delete(`7:${MEMBER}`);
  appAccess.invalidateAllVisibility();
  assertBare401(await gate({ bearer: token }));
  assert.equal(state.tokens.every((t) => t.revoked_at), true);
  // Let back in: the old tokens stay dead.
  state.members.add(`7:${MEMBER}`);
  appAccess.invalidateAllVisibility();
  assertBare401(await gate({ bearer: token }));
  assertBare401(await gate({ bearer: second }));
});

test('a token made before its owner came back does not count, even if never seen while they were out', async () => {
  const token = await makeToken();
  // Left and let back in, with no call in between: a new membership row.
  state.joined.set(`7:${MEMBER}`, new Date('2026-11-25T11:00:00Z'));
  assertBare401(await gate({ bearer: token }));
  assert.equal(state.tokens.every((t) => t.revoked_at), true);
});

test('the identity a token carries is refused by the platform services an app can call', async () => {
  const token = await makeToken();
  const passed = await gate({ bearer: token });
  const asAgent = await request('GET', '/api/app-platform/v1/access-tokens', {
    'x-usernode-app-token': APP_TOKEN, 'x-usernode-user-token': passed.headers['x-usernode-identity'],
  });
  assert.equal(asAgent.status, 403);
  const made = await request('POST', '/api/app-platform/v1/access-tokens', {
    'x-usernode-app-token': APP_TOKEN, 'x-usernode-user-token': passed.headers['x-usernode-identity'],
    'content-type': 'application/json',
  }, { name: 'another' });
  assert.equal(made.status, 403, 'a token cannot make more tokens');
  assert.equal(state.tokens.length, 1);
});

test('a private app with no token still treats a browser as before', async () => {
  // A person's visit to the declared path goes round the sign-in hop.
  const visit = await gate({ method: 'GET', extra: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } });
  assert.equal(visit.status, 302);
  // Another path, no credential: nothing changed.
  assert.equal((await gate({ uri: '/api/people' })).status, 404);
  // Somebody else's kind of Authorization header is not ours to answer.
  const foreign = await gate({ uri: '/api/people', extra: { Authorization: 'Bearer some-app-key' } });
  assert.equal(foreign.status, 404);
});

// ── the app API ────────────────────────────────────────────────────────

test('a member makes a token, sees it listed without the token, and revokes it', async () => {
  const made = await api('POST', '/access-tokens', { body: { name: '  My   laptop ' } });
  assert.equal(made.status, 201);
  assert.match(made.json.token, /^hrat_/);
  assert.equal(made.json.name, 'My laptop');
  assert.deepEqual(made.json.paths, ['/mcp']);
  assert.equal(made.headers['cache-control'], 'no-store');
  assert.equal((await gate({ bearer: made.json.token })).status, 200);

  const listed = await api('GET', '/access-tokens');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.tokens.length, 1);
  assert.deepEqual(Object.keys(listed.json.tokens[0]).sort(), ['created_at', 'hint', 'id', 'last_used_at', 'name']);
  assert.equal(listed.body.includes(made.json.token), false);

  // Another member sees none of them and cannot revoke one.
  assert.deepEqual((await api('GET', '/access-tokens', { user: SECOND })).json.tokens, []);
  assert.equal((await api('DELETE', `/access-tokens/${made.json.id}`, { user: SECOND })).status, 404);

  assert.equal((await api('DELETE', `/access-tokens/${made.json.id}`)).status, 200);
  assertBare401(await gate({ bearer: made.json.token }));
  assert.equal((await api('DELETE', `/access-tokens/${made.json.id}`)).status, 404);
});

test('only a member gets a token, and only with both credentials', async () => {
  const outsider = await api('POST', '/access-tokens', { user: OUTSIDER, body: { name: 'x' } });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.json.code, 'not_a_member');
  assert.equal((await api('GET', '/access-tokens', { user: OUTSIDER })).status, 403);
  // No app credential (a preview has none): no token, even for a member.
  assert.equal((await api('POST', '/access-tokens', { appToken: null, body: { name: 'x' } })).status, 401);
  assert.equal((await api('POST', '/access-tokens', { user: null, body: { name: 'x' } })).status, 401);
  assert.equal(state.tokens.length, 0);
});

test('a token needs a name, and a member holds at most ten', async () => {
  assert.equal((await api('POST', '/access-tokens', { body: { name: '   ' } })).json.code, 'name_required');
  for (let i = 0; i < accessTokens.MAX_PER_MEMBER; i += 1) {
    assert.equal((await api('POST', '/access-tokens', { body: { name: `t${i}` } })).status, 201);
  }
  const over = await api('POST', '/access-tokens', { body: { name: 'one more' } });
  assert.equal(over.status, 409);
  assert.equal(over.json.code, 'too_many_tokens');
});

test('an app that declares no agentPaths cannot make tokens', async () => {
  APPS.team.agent_paths = null;
  try {
    appAccess.invalidateAllVisibility();
    const r = await api('POST', '/access-tokens', { body: { name: 'x' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'no_agent_paths');
  } finally {
    APPS.team.agent_paths = ['/mcp'];
  }
});
