// HTTP tests for the prod-debug internal API (#616 —
// src/routes/internal.js): the requireProdDebug guard (claim check +
// per-request DB eligibility recheck), the SQL proxy's unavailable path
// + audit logging, the container-log allowlist/clamping/redaction, and
// the containers/status snapshots. Pool, docker, and status services are
// stubbed via require.cache, same pattern as tests/edge-gate.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

// Worker tokens are their own authority now (WORKER_JWT_SECRET); the
// legacy shared secret is kept set only to prove it grants nothing.
const WORKER_SECRET = 'prod-debug-routes-test-worker-secret';
process.env.WORKER_JWT_SECRET = WORKER_SECRET;
const JWT_SECRET = 'prod-debug-routes-test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// Session fixtures the fake pool serves for the eligibility recheck.
const ELIGIBLE_ID = 1;      // admin owner, self-hosted app
const NON_ADMIN_ID = 2;     // non-admin owner, self-hosted app
const NON_SELF_ID = 3;      // admin owner, ordinary app
const MISSING_ID = 404;

// ── stubs (must be installed BEFORE requiring the router) ──────────────

const fakePool = {
  async query(sql, params = []) {
    if (/SELECT a\.self_hosted, u\.is_admin, cs\.user_id/.test(sql)) {
      const id = params[0];
      if (id === ELIGIBLE_ID) return { rows: [{ self_hosted: true, is_admin: true, user_id: 50 }] };
      if (id === NON_ADMIN_ID) return { rows: [{ self_hosted: true, is_admin: false, user_id: 60 }] };
      if (id === NON_SELF_ID) return { rows: [{ self_hosted: false, is_admin: true, user_id: 50 }] };
      return { rows: [] };
    }
    throw new Error(`prod-debug stub: unexpected query: ${sql}`);
  },
};

function installStub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

installStub('../src/db/pool', { getPool: () => fakePool });

// docker stub: `docker logs` returns content that includes a secret so
// the route's redaction can be asserted; everything else errors.
const dockerCalls = [];
installStub('../src/services/docker', {
  async execFileAsync(cmd, args) {
    dockerCalls.push(args);
    if (args[0] === 'logs') {
      const name = args[args.length - 1];
      if (name === 'usernode-worker-99') {
        const err = new Error(`Error: No such container: ${name}`);
        throw err;
      }
      return {
        stdout: `[log] ${name} booted\n[log] key leaked: sk-ant-api03-abcdef123456\n`,
        stderr: '[stderr] container stderr line\n',
      };
    }
    throw new Error(`docker stub: unexpected command ${args[0]}`);
  },
});

installStub('../src/services/status', {
  async listContainers() {
    return [
      { name: 'usernode', id: 'aaa', state: 'running', status: 'Up 2 days', image: 'usernode:latest' },
      { name: 'usernode-db', id: 'bbb', state: 'running', status: 'Up 2 days', image: 'postgres:17-alpine' },
    ];
  },
  async getStats() {
    return { usernode: { mem: '512MiB / 3GiB', cpu: '3.2%' } };
  },
  async gather(_config, { isAdmin } = {}) {
    return { isAdmin: !!isAdmin, summary: { activeSessions: 4 }, stuckSessions: [] };
  },
  start() {},
});

const log = require('../src/services/logger');
const { internalRoutes } = require('../src/routes/internal');

// ── harness ────────────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: JWT_SECRET, platformRepoUrl: '' }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function mint(sessionId, { prodDebug = true, secret = WORKER_SECRET } = {}) {
  return jwt.sign(
    {
      session_id: sessionId,
      scope: 'worker:session',
      pur: 'worker:session',
      ...(prodDebug ? { prod_debug: true } : {}),
    },
    secret,
    { algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:worker', expiresIn: '10m' }
  );
}

function call({ method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── guard ──────────────────────────────────────────────────────────────

test('no auth header → 401', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    body: { query: 'SELECT 1' },
  });
  assert.equal(r.status, 401);
});

// Key separation: the retired shared secret is still present in the env
// (child containers hold it for the iframe path), so a token minted with
// it must buy nothing on the internal API.
test('token signed with the legacy shared secret → 401 bad_token', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    token: mint(ELIGIBLE_ID, { secret: JWT_SECRET }),
    body: { query: 'SELECT 1' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'bad_token');
});

// Same key, wrong job: an edge-shaped token must not pass as a worker
// token even if an operator ever reused one secret for both.
test('worker-secret token with the wrong purpose → 401 bad_token', async () => {
  const wrongPurpose = jwt.sign(
    { session_id: ELIGIBLE_ID, scope: 'worker:session', pur: 'edge:grant', prod_debug: true },
    WORKER_SECRET,
    { algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:worker', expiresIn: '10m' }
  );
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    token: wrongPurpose,
    body: { query: 'SELECT 1' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'bad_token');
});

test('valid worker JWT WITHOUT the prod_debug claim → 403 not_prod_debug', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    token: mint(ELIGIBLE_ID, { prodDebug: false }),
    body: { query: 'SELECT 1' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'not_prod_debug');
});

test('JWT session id must match the route session id', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    token: mint(NON_ADMIN_ID),
    body: { query: 'SELECT 1' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'session_mismatch');
});

test('claimed JWT but owner is no longer admin → 403 not_eligible', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${NON_ADMIN_ID}/prod-debug/sql`,
    token: mint(NON_ADMIN_ID),
    body: { query: 'SELECT 1' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'not_eligible');
});

test('claimed JWT but app is not the self-edit app → 403 not_eligible', async () => {
  const r = await call({
    method: 'GET',
    path: `/api/internal/sessions/${NON_SELF_ID}/prod-debug/containers`,
    token: mint(NON_SELF_ID),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'not_eligible');
});

test('unknown session → 404', async () => {
  const r = await call({
    method: 'GET',
    path: `/api/internal/sessions/${MISSING_ID}/prod-debug/containers`,
    token: mint(MISSING_ID),
  });
  assert.equal(r.status, 404);
});

// ── SQL proxy ──────────────────────────────────────────────────────────

test('sql: 503 unavailable when the RO role was never bootstrapped, and the call is audit-logged', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    token: mint(ELIGIBLE_ID),
    body: { query: 'SELECT id FROM chat_sessions ORDER BY id DESC LIMIT 3' },
  });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'unavailable');

  // Audit trail: both the generic guard entry and the SQL-specific entry
  // land in the redacted ring buffer BEFORE execution, so even the
  // unavailable path is on the record.
  const recent = log.tail(50);
  assert.ok(
    recent.some((e) => e.category === 'prod-debug' && e.message === 'SQL query'
      && e.data && String(e.data.query).includes('FROM chat_sessions')),
    'expected an audit ring entry for the SQL query'
  );
  assert.ok(
    recent.some((e) => e.category === 'prod-debug' && e.message === 'Prod-debug call'),
    'expected the guard audit entry'
  );
});

test('sql: empty/missing query → 400', async () => {
  const r = await call({
    method: 'POST',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/sql`,
    token: mint(ELIGIBLE_ID),
    body: { query: '   ' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bad_query');
});

// ── logs endpoint ──────────────────────────────────────────────────────

test('logs: disallowed container names are rejected before touching docker', async () => {
  for (const name of ['caddy2', 'postgres', '..%2Fetc']) {
    dockerCalls.length = 0;
    const r = await call({
      method: 'GET',
      path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/logs/${name}`,
      token: mint(ELIGIBLE_ID),
    });
    assert.equal(r.status, 400, name);
    assert.equal(r.json.code, 'bad_container', name);
    assert.equal(dockerCalls.length, 0, name);
  }
});

test('logs: allowed container returns redacted output with clamped tail', async () => {
  dockerCalls.length = 0;
  const r = await call({
    method: 'GET',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/logs/usernode?tail=99999`,
    token: mint(ELIGIBLE_ID),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tail, 2000); // clamped from 99999
  assert.deepEqual(dockerCalls[0].slice(0, 3), ['logs', '--tail', '2000']);
  // Secret scrubbed, surrounding content + stderr stream preserved.
  assert.ok(!r.json.logs.includes('sk-ant-'), 'secret must be redacted');
  assert.ok(r.json.logs.includes('****'));
  assert.ok(r.json.logs.includes('usernode booted'));
  assert.ok(r.json.logs.includes('container stderr line'));
});

test('logs: docker failure (container gone) → 404 container_unavailable', async () => {
  const r = await call({
    method: 'GET',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/logs/usernode-worker-99`,
    token: mint(ELIGIBLE_ID),
  });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'container_unavailable');
});

// ── containers + status endpoints ──────────────────────────────────────

test('containers: merges docker ps inventory with stats', async () => {
  const r = await call({
    method: 'GET',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/containers`,
    token: mint(ELIGIBLE_ID),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.containers.length, 2);
  const platform = r.json.containers.find((c) => c.name === 'usernode');
  assert.equal(platform.state, 'running');
  assert.equal(platform.mem, '512MiB / 3GiB');
  assert.equal(platform.cpu, '3.2%');
  const db = r.json.containers.find((c) => c.name === 'usernode-db');
  assert.equal(db.mem, null); // no stats row for it in the stub
});

test('status: returns the admin snapshot plus the recent log ring', async () => {
  const r = await call({
    method: 'GET',
    path: `/api/internal/sessions/${ELIGIBLE_ID}/prod-debug/status`,
    token: mint(ELIGIBLE_ID),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status.isAdmin, true);
  assert.equal(r.json.status.summary.activeSessions, 4);
  assert.ok(Array.isArray(r.json.recentLog));
});
