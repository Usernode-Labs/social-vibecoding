// Topochain v4 foundation (plan Task 3): helpers, auth middlewares, mounts.
//
// Covers:
//   - src/routes/topochain/helpers.js — envelope shapes, iso() offset
//     format, num() casting, paginate()/meta() pagination contract.
//   - src/middleware/topochain-auth.js — partnerApiKey 500/401 paths,
//     mobileTokenAuth 401/403 paths (mock pool), optionalSessionAuth
//     swallowing every failure mode (never produces a response itself).
//   - server.js — static source assertion that the five topochain
//     routers mount on the correct side of authMiddleware, plus a live
//     HTTP check of the documented "unmatched /api/v4/* path" decision
//     (falls through to authMiddleware -> 401 for anonymous, NOT 404) and
//     that the admin group's __ping sits behind adminMiddleware.
//
// Same harness styles as tests/board-order.test.js (HTTP-level, throwaway
// express app) and tests/public-api.test.js (pool injection via
// require.cache).
//
// Run with: node --test tests/topochain-foundation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('../src/routes/topochain/helpers');
const {
  optionalSessionAuth, partnerApiKey, mobileTokenAuth,
} = require('../src/middleware/topochain-auth');

// ─── helpers.js ──────────────────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return this.headers.get(name.toLowerCase()); },
  };
}

test('ok() envelopes success + merges data/extra flat', () => {
  const res = fakeRes();
  ok(res, { items: [1, 2] }, { meta: { page: 1 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, items: [1, 2], meta: { page: 1 } });
});

test('ok() defaults data/extra to empty objects', () => {
  const res = fakeRes();
  ok(res);
  assert.deepEqual(res.body, { success: true });
});

test('fail() envelopes the one v4 error shape, omitting details/code when absent', () => {
  const res = fakeRes();
  fail(res, 404, 'Not found.');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, error: 'Not found.' });
  assert.ok(!('details' in res.body));
  assert.ok(!('code' in res.body));
});

test('fail() includes details/code when given', () => {
  const res = fakeRes();
  fail(res, 422, 'Validation failed.', {
    details: { per_page: ['bad'] },
    code: 'invalid_per_page',
  });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    success: false,
    error: 'Validation failed.',
    details: { per_page: ['bad'] },
    code: 'invalid_per_page',
  });
});

test('iso() renders ISO-8601 with a +00:00 offset, never a bare Z', () => {
  const rendered = iso(new Date('2026-07-27T12:00:00.000Z'));
  assert.equal(rendered, '2026-07-27T12:00:00.000+00:00');
  assert.ok(!rendered.includes('Z'));
});

test('iso() accepts a date string and is null-safe', () => {
  assert.equal(iso('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000+00:00');
  assert.equal(iso(null), null);
  assert.equal(iso(undefined), null);
  assert.equal(iso('not a date'), null);
});

test('num() casts a decimal string to a JSON number and is null-safe', () => {
  assert.equal(num('12.50'), 12.5);
  assert.equal(num('0'), 0);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num('not-a-number'), null);
});

test('paginate() defaults page=1 and per_page=25', () => {
  assert.deepEqual(paginate({ query: {} }), { page: 1, perPage: 25 });
});

test('paginate() reads valid page/per_page from the query', () => {
  assert.deepEqual(paginate({ query: { page: '3', per_page: '50' } }), { page: 3, perPage: 50 });
});

test('paginate() clamps a nonsense page silently (not a validation error)', () => {
  assert.deepEqual(paginate({ query: { page: '-5' } }), { page: 1, perPage: 25 });
  assert.deepEqual(paginate({ query: { page: 'abc' } }), { page: 1, perPage: 25 });
});

test('paginate() rejects per_page outside 1..100 with a 422 ValidationError', () => {
  for (const bad of ['0', '-1', '101', '1000', 'abc', '1.5']) {
    assert.throws(
      () => paginate({ query: { per_page: bad } }),
      (err) => err instanceof ValidationError && err.status === 422,
      `per_page=${bad} should throw a 422 ValidationError`
    );
  }
});

test('paginate() accepts the boundary values 1 and 100', () => {
  assert.deepEqual(paginate({ query: { per_page: '1' } }), { page: 1, perPage: 1 });
  assert.deepEqual(paginate({ query: { per_page: '100' } }), { page: 1, perPage: 100 });
});

test('meta() builds the flat pagination envelope', () => {
  assert.deepEqual(meta(2, 25, 60), { page: 2, per_page: 25, total: 60, total_pages: 3 });
});

test('meta() never divides by a bad per_page (guards the source per_page=0 500)', () => {
  assert.deepEqual(meta(1, 25, 0), { page: 1, per_page: 25, total: 0, total_pages: 0 });
});

// ─── partnerApiKey ───────────────────────────────────────────────────────

// Runs a (possibly async) middleware and resolves as soon as EITHER
// next() is called OR the middleware sends a response via res.json —
// whichever happens first, however long the middleware's internal await
// chain (a mock pool query) takes. Racing on a synchronous check right
// after invoking `mw` (as opposed to this) would miss both outcomes for
// an async middleware that responds after its first `await`.
function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const originalJson = res.json.bind(res);
    res.json = (obj) => {
      const out = originalJson(obj);
      if (!settled) { settled = true; resolve({ next: false }); }
      return out;
    };
    Promise.resolve(mw(req, res, (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ next: true });
    })).catch((err) => {
      if (!settled) { settled = true; reject(err); }
    });
  });
}

test('partnerApiKey: unconfigured server -> 500 before the key is even checked', async () => {
  const mw = partnerApiKey({ topochainPartnerApiKey: '' });
  const res = fakeRes();
  await runMiddleware(mw, { headers: { 'x-api-key': 'anything' } }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, error: 'API key authentication not configured.' });
});

test('partnerApiKey: missing header -> 401', async () => {
  const mw = partnerApiKey({ topochainPartnerApiKey: 'secret' });
  const res = fakeRes();
  await runMiddleware(mw, { headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { success: false, error: 'Invalid or missing API key.' });
});

test('partnerApiKey: wrong key -> 401', async () => {
  const mw = partnerApiKey({ topochainPartnerApiKey: 'secret' });
  const res = fakeRes();
  await runMiddleware(mw, { headers: { 'x-api-key': 'nope' } }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { success: false, error: 'Invalid or missing API key.' });
});

test('partnerApiKey: correct key -> calls next(), no response sent', async () => {
  const mw = partnerApiKey({ topochainPartnerApiKey: 'secret' });
  const res = fakeRes();
  const result = await runMiddleware(mw, { headers: { 'x-api-key': 'secret' } }, res);
  assert.deepEqual(result, { next: true });
  assert.equal(res.body, null);
});

// ─── mobileTokenAuth (mock pool) ─────────────────────────────────────────

function sha256(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Swaps src/db/pool's getPool() for a canned mock for the duration of `fn`,
// mirroring tests/public-api.test.js's withMockPool. topochain-auth.js
// resolves the module at require time, so the swap must happen via
// require.cache (the middleware factories close over getPool() results
// captured when THEY are called, so re-requiring topochain-auth.js after
// swapping the cache entry is enough — no need to re-require per test).
function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const authModulePath = require.resolve('../src/middleware/topochain-auth');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  delete require.cache[authModulePath];
  try {
    return fn(require('../src/middleware/topochain-auth'));
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[authModulePath];
  }
}

function makeMobileTokenPool(tokensByHash, { failLookup = false } = {}) {
  const pool = {
    lastLookupSql: null,
    connectCalls: 0,
    async query(sql, params) {
      if (/JOIN mobile_auth_tokens/.test(sql) && /SELECT/.test(sql)) {
        pool.lastLookupSql = sql;
        if (failLookup) throw new Error('connection reset');
        const row = tokensByHash[params[0]];
        const credentialExpiry = row?.credential_expires_at ?? row?.expires_at;
        if (!row || row.nativeCredentialValid === false
            || new Date(row.expires_at) <= new Date()
            || new Date(row.expires_at).getTime() !== new Date(credentialExpiry).getTime()) {
          return { rows: [] };
        }
        return { rows: [{
          credential_reference: `nsc_${'A'.repeat(43)}`,
          credential_generation: 1,
          installation_id: `nsi_${'B'.repeat(43)}`,
          attempt_id: `nsa_${'C'.repeat(43)}`,
          renewal_due: false,
          ...row,
        }] };
      }
      throw new Error(`unexpected SQL in mock: ${sql.slice(0, 60)}`);
    },
    async connect() {
      pool.connectCalls += 1;
      throw new Error('a current lease must not open a write transaction');
    },
  };
  return pool;
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 1000);

test('mobileTokenAuth: missing Authorization header -> 401 Unauthenticated.', async () => {
  await withMockPool(makeMobileTokenPool({}), async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, { headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, error: 'Unauthenticated.' });
  });
});

test('mobileTokenAuth: unknown token -> 401 Unauthenticated.', async () => {
  await withMockPool(makeMobileTokenPool({}), async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, { headers: { authorization: 'Bearer nope' } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, error: 'Unauthenticated.' });
  });
});

test('mobileTokenAuth: an orphan legacy bearer has no authority', async () => {
  const token = 'orphan-legacy-session';
  const pool = makeMobileTokenPool({
    [sha256(token)]: {
      id: 3,
      user_id: 9,
      ability: 'session',
      expires_at: FUTURE,
      username: 'p9',
      nativeCredentialValid: false,
    },
  });
  await withMockPool(pool, async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, {
      headers: { authorization: `Bearer ${token}` },
    }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, error: 'Unauthenticated.' });
  });
});

test('mobileTokenAuth: expired token -> 401 Unauthenticated.', async () => {
  const token = 'expired-token';
  const pool = makeMobileTokenPool({
    [sha256(token)]: { id: 1, user_id: 9, ability: 'session', expires_at: PAST, username: 'p9' },
  });
  await withMockPool(pool, async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, { headers: { authorization: `Bearer ${token}` } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, error: 'Unauthenticated.' });
  });
});

test('mobileTokenAuth: an unexpected non-session token fails closed -> 403', async () => {
  const token = 'legacy-token';
  const pool = makeMobileTokenPool({
    [sha256(token)]: { id: 2, user_id: 9, ability: 'legacy', expires_at: FUTURE, username: 'p9' },
  });
  await withMockPool(pool, async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, { headers: { authorization: `Bearer ${token}` } }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { success: false, error: 'A participant session token is required.' });
  });
});

test('mobileTokenAuth: valid session token -> next(), req.user resolved from the token (never trusted from the client)', async () => {
  const token = 'good-token';
  const pool = makeMobileTokenPool({
    [sha256(token)]: { id: 4, user_id: 42, ability: 'session', expires_at: FUTURE, username: 'racer42' },
  });
  await withMockPool(pool, async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    const req = { headers: { authorization: `Bearer ${token}` }, body: { user_id: 999 } };
    const result = await runMiddleware(mw, req, res);
    assert.deepEqual(result, { next: true });
    assert.equal(res.body, null);
    assert.deepEqual(req.user, { id: 42, username: 'racer42', isAdmin: false });
    assert.deepEqual(req.mobileAuth, {
      tokenId: 4,
      ability: 'session',
      expiresAt: FUTURE,
      credentialReference: `nsc_${'A'.repeat(43)}`,
      credentialGeneration: 1,
      attemptId: `nsa_${'C'.repeat(43)}`,
    });
    assert.equal(res.getHeader('Usernode-Credential-Reference'), `nsc_${'A'.repeat(43)}`);
    assert.equal(res.getHeader('Usernode-Credential-Generation'), '1');
    assert.equal(res.getHeader('Usernode-Credential-Lease-Expires-At'), FUTURE.toISOString());
    assert.equal(pool.connectCalls, 0);
    assert.match(pool.lastLookupSql,
      /FROM native_session_credentials c[\s\S]*JOIN mobile_auth_tokens t[\s\S]*t\.expires_at > NOW\(\)[\s\S]*c\.state = 'valid'[\s\S]*c\.expires_at > NOW\(\)[\s\S]*c\.expires_at = t\.expires_at/);
  });
});

test('mobileTokenAuth: credential/token expiry drift fails closed', async () => {
  const token = 'drifted-token';
  const pool = makeMobileTokenPool({
    [sha256(token)]: {
      id: 5,
      user_id: 42,
      ability: 'session',
      expires_at: FUTURE,
      credential_expires_at: new Date(FUTURE.getTime() + 1000),
      username: 'racer42',
    },
  });
  await withMockPool(pool, async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, {
      headers: { authorization: `Bearer ${token}` },
    }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, error: 'Unauthenticated.' });
    assert.equal(res.headers.size, 0);
  });
});

test('mobileTokenAuth: a lookup failure fails closed as 500, never session invalidation', async () => {
  const pool = makeMobileTokenPool({}, { failLookup: true });
  await withMockPool(pool, async (mod) => {
    const mw = mod.mobileTokenAuth({});
    const res = fakeRes();
    await runMiddleware(mw, { headers: { authorization: 'Bearer whatever' } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { success: false, error: 'Internal server error.' });
  });
});

// ─── optionalSessionAuth (mock pool, swallows every failure) ────────────

function makeSessionPool({ rows = [], throwOnQuery = false } = {}) {
  return {
    async query() {
      if (throwOnQuery) throw new Error('connection reset');
      return { rows };
    },
  };
}

function withMockSessionPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const authModulePath = require.resolve('../src/middleware/topochain-auth');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  delete require.cache[authModulePath];
  try {
    return fn(require('../src/middleware/topochain-auth'));
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[authModulePath];
  }
}

test('optionalSessionAuth: no cookie -> next(), req.user left unset, no response', async () => {
  await withMockSessionPool(makeSessionPool(), async (mod) => {
    const mw = mod.optionalSessionAuth({});
    const res = fakeRes();
    const req = { cookies: {} };
    const result = await runMiddleware(mw, req, res);
    assert.deepEqual(result, { next: true });
    assert.equal(req.user, undefined);
    assert.equal(res.body, null);
  });
});

test('optionalSessionAuth: valid session cookie -> req.user resolved', async () => {
  const pool = makeSessionPool({
    rows: [{ user_id: 7, expires_at: FUTURE, username: 'alice', is_admin: true }],
  });
  await withMockSessionPool(pool, async (mod) => {
    const mw = mod.optionalSessionAuth({});
    const res = fakeRes();
    const req = { cookies: { session: 'tok123' } };
    const result = await runMiddleware(mw, req, res);
    assert.deepEqual(result, { next: true });
    assert.deepEqual(req.user, { id: 7, username: 'alice', isAdmin: true });
    assert.equal(res.body, null);
  });
});

test('optionalSessionAuth: expired session -> swallowed, req.user left unset, never 401', async () => {
  const pool = makeSessionPool({
    rows: [{ user_id: 7, expires_at: PAST, username: 'alice', is_admin: false }],
  });
  await withMockSessionPool(pool, async (mod) => {
    const mw = mod.optionalSessionAuth({});
    const res = fakeRes();
    const req = { cookies: { session: 'stale' } };
    const result = await runMiddleware(mw, req, res);
    assert.deepEqual(result, { next: true });
    assert.equal(req.user, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  });
});

test('optionalSessionAuth: unknown cookie -> swallowed, never 401', async () => {
  await withMockSessionPool(makeSessionPool({ rows: [] }), async (mod) => {
    const mw = mod.optionalSessionAuth({});
    const res = fakeRes();
    const req = { cookies: { session: 'unknown' } };
    const result = await runMiddleware(mw, req, res);
    assert.deepEqual(result, { next: true });
    assert.equal(req.user, undefined);
    assert.equal(res.body, null);
  });
});

test('optionalSessionAuth: a DB error is swallowed entirely — never 401, never 500', async () => {
  await withMockSessionPool(makeSessionPool({ throwOnQuery: true }), async (mod) => {
    const mw = mod.optionalSessionAuth({});
    const res = fakeRes();
    const req = { cookies: { session: 'whatever' } };
    const result = await runMiddleware(mw, req, res);
    assert.deepEqual(result, { next: true });
    assert.equal(req.user, undefined);
    assert.equal(res.body, null);
  });
});

// ─── server.js: mount order + admin auth gate (static + live) ───────────

test('server.js mounts public/partner/ingest/mobile BEFORE authMiddleware, admin AFTER', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const idx = (needle) => {
    const i = serverSrc.indexOf(needle);
    assert.ok(i >= 0, `server.js contains: ${needle}`);
    return i;
  };

  const publicIdx = idx('app.use(topochainPublicRoutes(config));');
  const partnerIdx = idx('app.use(topochainPartnerRoutes(config));');
  const ingestIdx = idx('app.use(topochainIngestRoutes(config));');
  const mobileIdx = idx('app.use(topochainMobileRoutes(config));');
  const authIdx = idx('app.use(authMiddleware(config));');
  const adminIdx = idx('app.use(topochainAdminRoutes(config));');

  for (const [name, i] of [['public', publicIdx], ['partner', partnerIdx], ['ingest', ingestIdx], ['mobile', mobileIdx]]) {
    assert.ok(i < authIdx, `topochain${name} router must mount before authMiddleware`);
  }
  assert.ok(adminIdx > authIdx, 'topochain admin router must mount after authMiddleware');
});

test('server.js extends GET /health with topochain: true', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const healthIdx = src.indexOf("app.get('/health'");
  assert.ok(healthIdx >= 0);
  const block = src.slice(healthIdx, src.indexOf('});', healthIdx));
  assert.match(block, /topochain:\s*true/);
});

// Live HTTP check of the "unmatched /api/v4/* path" decision: /api/v4 is
// NOT in authMiddleware's PUBLIC_PATHS, so a request that doesn't match
// one of the pre-auth topochain routers' own paths falls through to
// authMiddleware and gets its standard 401 for an anonymous caller — NOT
// a 404. The __ping stubs, by contrast, ARE matched by their own router
// (mounted earlier) and never reach authMiddleware at all.
test('unmounted /api/v4/* paths fall through to authMiddleware (401 for anonymous), mounted __ping stubs do not', async () => {
  const { topochainPublicRoutes } = require('../src/routes/topochain/public');
  const { topochainPartnerRoutes } = require('../src/routes/topochain/partner');
  const { topochainIngestRoutes } = require('../src/routes/topochain/ingest');
  const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
  const { authMiddleware } = require('../src/middleware/auth');

  const cfg = { databaseUrl: 'postgres://fake/fake', jwtSecret: 'test-secret' };
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(topochainPublicRoutes(cfg));
  app.use(topochainPartnerRoutes(cfg));
  app.use(topochainIngestRoutes(cfg));
  app.use(topochainMobileRoutes(cfg));
  app.use(authMiddleware(cfg));
  app.use((req, res) => res.status(404).json({ error: 'fallback 404' }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pingRes = await fetch(`${base}/api/v4/public/__ping`);
    assert.equal(pingRes.status, 200);
    assert.deepEqual(await pingRes.json(), { success: true });

    const mobilePingRes = await fetch(`${base}/api/v4/mobile/__ping`);
    assert.equal(mobilePingRes.status, 200);

    // Task 3 originally probed `/api/v4/season-events` here as a stand-in
    // for "any path none of the pre-auth routers have mounted yet". Task 5
    // implements that exact endpoint (SPEC §4.2), so it's no longer an
    // unmounted path — swapped for a path no task mounts, to keep testing
    // the same mount-order behavior rather than one specific endpoint.
    const unmatchedRes = await fetch(`${base}/api/v4/this-path-is-never-mounted`);
    assert.equal(unmatchedRes.status, 401, 'unmounted v4 path must 401 for an anonymous caller, not fall to the 404 handler');
    assert.deepEqual(await unmatchedRes.json(), { error: 'Not authenticated' });
  } finally {
    server.close();
  }
});

test('topochainPartnerRoutes and topochainIngestRoutes __ping stubs respond 200 unauthenticated', async () => {
  const { topochainPartnerRoutes } = require('../src/routes/topochain/partner');
  const { topochainIngestRoutes } = require('../src/routes/topochain/ingest');

  const app = express();
  app.use(topochainPartnerRoutes({}));
  app.use(topochainIngestRoutes({}));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r1 = await fetch(`${base}/api/v4/partner/__ping`);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { success: true });

    const r2 = await fetch(`${base}/api/v4/ingest/__ping`);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { success: true });
  } finally {
    server.close();
  }
});

test('topochainAdminRoutes: __ping sits behind adminMiddleware — 403 for a non-admin, 200 for an admin', async () => {
  const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

  const app = express();
  // Injects req.user before the router, mirroring the real pipeline where
  // authMiddleware has already resolved the session by the time this
  // router's own adminMiddleware runs.
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role === 'admin') req.user = { id: 1, isAdmin: true };
    else if (role === 'user') req.user = { id: 2, isAdmin: false };
    next();
  });
  app.use(topochainAdminRoutes({}));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const asUser = await fetch(`${base}/api/v4/admin/__ping`, { headers: { 'x-test-role': 'user' } });
    assert.equal(asUser.status, 403);

    const anon = await fetch(`${base}/api/v4/admin/__ping`);
    assert.equal(anon.status, 403);

    const asAdmin = await fetch(`${base}/api/v4/admin/__ping`, { headers: { 'x-test-role': 'admin' } });
    assert.equal(asAdmin.status, 200);
    assert.deepEqual(await asAdmin.json(), { success: true });
  } finally {
    server.close();
  }
});
