'use strict';

// Settings → Connectors: GET /api/me/connectors/test (#6135).
//
// The button must be able to say what is wrong without ever claiming a fact
// it did not check, so this pins the three things that decide the answer:
//
//   1. the staging branch answers from a fixture, touches no DB and probes
//      nothing;
//   2. a probe that cannot reach the origin is `unknown`, not `failed` — the
//      page settles that leg itself, and a deployment that cannot hairpin to
//      its own public name would otherwise report a permanent outage;
//   3. the response carries codes and facts, never prose, so the client owns
//      every word.
//
// The grants aggregate gets a real PostgreSQL: it groups by GRANT (a consent,
// not a token) and leaves delegated grants out, which is exactly the part a
// stubbed pool cannot show.
//
// Run with: node --test tests/connector-test-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

// Stub what the router CALLS, not the router itself: the rate limiter (a
// bucket read against a DB this file does not have) and the pool handle.
const cliAuth = require('../src/services/cli-auth');
cliAuth.consumeSharedTokenBucket = async () => ({ allowed: true, retryAfter: 0 });

const grantsRow = {
  active: '1',
  inactive: '0',
  client_name: 'Claude.ai',
  last_used_at: new Date('2026-11-01T09:14:00Z'),
};

let dbCalls = 0;
const pool = {
  query: async (sql) => {
    dbCalls += 1;
    assert.match(sql, /FROM mcp_tokens/, 'only the grants aggregate is read');
    return { rows: [grantsRow] };
  },
};
require('../src/db/pool').getPool = () => pool;

const { mcpBrowserRoutes, demoConnectionTest, readConnectorTestGrants } = require('../src/routes/mcp-remote');
const express = require('express');

const CONFIG = { cliAuthEnabled: true, cliAuthOrigin: 'https://social-vibecoding.usernodelabs.org' };

function app({ signedIn = true } = {}) {
  const instance = express();
  instance.use((req, _res, next) => {
    dbCalls = 0;
    if (signedIn) req.user = { id: 7 };
    next();
  });
  instance.use(mcpBrowserRoutes(CONFIG));
  return instance;
}

async function get(path, application = app()) {
  const server = application.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Every probe answer, by URL, for the non-staging cases.
function stubOrigin({ discoveryStatus = 200, mcpStatus = 401, network = false } = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    // The route test's own HTTP call comes through node's real fetch, which
    // this replaces only for absolute public-origin URLs.
    const href = String(url);
    if (!href.startsWith(CONFIG.cliAuthOrigin)) {
      return realFetch(url, init);
    }
    calls.push({ url: href, init });
    if (network) throw new TypeError('fetch failed');
    if (href === `${CONFIG.cliAuthOrigin}/mcp`) {
      return {
        status: mcpStatus,
        ok: mcpStatus === 401,
        headers: {
          get: (name) => (String(name).toLowerCase() === 'www-authenticate'
            ? 'Bearer resource_metadata="https://social-vibecoding.usernodelabs.org/.well-known/oauth-protected-resource/mcp"'
            : null),
        },
        json: async () => ({}),
      };
    }
    return {
      status: discoveryStatus,
      ok: discoveryStatus === 200,
      headers: { get: () => 'application/json' },
      json: async () => (href.endsWith('/oauth-authorization-server')
        ? { issuer: CONFIG.cliAuthOrigin }
        : { resource: `${CONFIG.cliAuthOrigin}/mcp` }),
    };
  };
  return calls;
}

const realFetch = global.fetch;

test('without a session it answers 401 and reads nothing', async () => {
  const before = dbCalls;
  const { status, body } = await get('/api/me/connectors/test', app({ signedIn: false }));
  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'not_authenticated' });
  assert.equal(dbCalls, before, 'no DB read for an unauthenticated request');
});

test('a healthy origin and an active grant is ok, with facts and no prose', async () => {
  const calls = stubOrigin();
  const { status, body } = await get('/api/me/connectors/test');

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    'checked_at', 'code', 'connection', 'discovery', 'enabled', 'mcp',
  ], 'facts only: the client owns every word');
  assert.equal(body.code, 'ok');
  assert.equal(body.enabled, true);
  assert.equal(body.discovery, 'ok');
  assert.equal(body.mcp, 'ok');
  assert.deepEqual(body.connection, {
    active: 1,
    inactive: 0,
    client_name: 'Claude.ai',
    last_used_at: '2026-11-01T09:14:00.000Z',
  });
  assert.ok(Date.parse(body.checked_at) > 0);

  const mcpCall = calls.find((call) => call.url === `${CONFIG.cliAuthOrigin}/mcp`);
  assert.ok(mcpCall, 'the MCP endpoint was probed');
  assert.equal(mcpCall.init.method, 'POST');
  assert.equal(mcpCall.init.body, '{}');
  assert.equal(
    (mcpCall.init.headers || {}).authorization,
    undefined,
    'no credential on the probe: the 401 challenge is the reachable result'
  );
});

test('discovery_failed wins over a failing MCP leg', async () => {
  stubOrigin({ discoveryStatus: 500, mcpStatus: 500 });
  const { body } = await get('/api/me/connectors/test');
  assert.equal(body.discovery, 'failed');
  assert.equal(body.mcp, 'failed');
  assert.equal(body.code, 'discovery_failed');
});

test('an MCP leg that answers the wrong way is server_unreachable', async () => {
  stubOrigin({ mcpStatus: 200 });
  const { body } = await get('/api/me/connectors/test');
  assert.equal(body.code, 'server_unreachable');
});

test('a probe that cannot reach the origin is unknown, not failed', async () => {
  stubOrigin({ network: true });
  const { body } = await get('/api/me/connectors/test');
  assert.equal(body.discovery, 'unknown');
  assert.equal(body.mcp, 'unknown');
  // The client settles the unknown legs before it shows anything; the code
  // here is computed from the facts that remain.
  assert.equal(body.code, 'ok');
});

test('no grants is not_connected, and only an inactive grant is connection_expired', async () => {
  stubOrigin();
  pool.query = async () => ({ rows: [{ active: '0', inactive: '0', client_name: null, last_used_at: null }] });
  assert.equal((await get('/api/me/connectors/test')).body.code, 'not_connected');

  pool.query = async () => ({ rows: [{ active: '0', inactive: '1', client_name: 'Claude.ai', last_used_at: null }] });
  assert.equal((await get('/api/me/connectors/test')).body.code, 'connection_expired');

  pool.query = async () => ({ rows: [grantsRow] });
});

test('a grants read that fails is 503, not a guessed answer', async () => {
  stubOrigin();
  pool.query = async () => { throw new Error('connection reset'); };
  const { status, body } = await get('/api/me/connectors/test');
  assert.equal(status, 503);
  assert.deepEqual(body, { error: 'temporarily_unavailable' });
  pool.query = async () => ({ rows: [grantsRow] });
});

// ── Staging ────────────────────────────────────────────────────────────
//
// The staging branch must answer from the fixture alone: no DB call, no
// probe. It is the one branch a preview copy can reach at all.

test('every staging fixture is answered with no DB read and no fetch', async () => {
  const original = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  let fetchCalls = 0;
  const savedFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    fetchCalls += 1;
    throw new Error('staging must not probe');
  };
  try {
    for (const [query, expected] of [
      ['', 'unavailable_here'],
      ['?demo=1', 'ok'],
      ['?demo=connectors-test-unreachable', 'server_unreachable'],
      ['?demo=connectors-test-none', 'not_connected'],
    ]) {
      dbCalls = 0;
      const { body } = await get(`/api/me/connectors/test${query}`);
      assert.equal(body.code, expected, `?demo=${query.replace('?demo=', '')}`);
      assert.equal(dbCalls, 0, 'staging reads no grants');
      if (query === '') {
        assert.deepEqual(body, { code: 'unavailable_here', enabled: false },
          'without the flag, connectors are honestly unavailable');
      } else {
        assert.equal(body.demo, true, 'a fixture says so');
      }
    }
    assert.equal(fetchCalls, 0, 'staging probes nothing');
  } finally {
    global.fetch = savedFetch;
    process.env.USERNODE_ENV = original;
  }
});

test('the ok fixture names the demo connection and says when it was last used', () => {
  const fixture = demoConnectionTest('1');
  assert.equal(fixture.code, 'ok');
  assert.ok(fixture.connection.client_name);
  assert.ok(Date.parse(fixture.connection.last_used_at) > 0);
  assert.equal(fixture.demo, true);
});

// ── The grants aggregate, against real PostgreSQL ──────────────────────
//
// A token row is a refresh in a grant's life: counting tokens would say "3
// connected" for one consent that rotated twice. This is the query that has
// to count consents, and skip the platform's own delegated grants.

const DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function withSchema(t) {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try { await client.connect(); } catch {
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
    return null;
  }
  await client.query(`DROP SCHEMA IF EXISTS connector_test_grants CASCADE`);
  await client.query('CREATE SCHEMA connector_test_grants');
  await client.query('SET search_path = connector_test_grants');
  await client.query(`
    CREATE TABLE mcp_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT
    );
    CREATE TABLE mcp_tokens (
      id SERIAL PRIMARY KEY,
      grant_id TEXT NOT NULL,
      client_id TEXT,
      user_id INTEGER NOT NULL,
      revoked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE mcp_delegations (
      grant_id TEXT PRIMARY KEY
    );
    INSERT INTO mcp_clients (client_id, client_name) VALUES
      ('c-claude', 'Claude.ai'),
      ('c-chatgpt', 'ChatGPT');
  `);
  return client;
}

test('the aggregate counts consents, keeps the newest use, and skips delegated grants', async (t) => {
  const client = await withSchema(t);
  if (!client) return;
  try {
    await client.query(`
      -- One consent, rotated twice: three token rows, one grant.
      INSERT INTO mcp_tokens (grant_id, client_id, user_id, expires_at, last_used_at) VALUES
        ('g-claude', 'c-claude', 7, clock_timestamp() + INTERVAL '1 day', clock_timestamp() - INTERVAL '2 days'),
        ('g-claude', 'c-claude', 7, clock_timestamp() + INTERVAL '1 day', clock_timestamp() - INTERVAL '1 hour'),
        ('g-chatgpt', 'c-chatgpt', 7, clock_timestamp() + INTERVAL '1 day', clock_timestamp() - INTERVAL '3 days'),
        -- An expired consent is a grant that exists and is not active.
        ('g-expired', 'c-chatgpt', 7, clock_timestamp() - INTERVAL '1 minute', NULL),
        -- Another account's grant must never be counted.
        ('g-other', 'c-claude', 8, clock_timestamp() + INTERVAL '1 day', clock_timestamp()),
        -- The platform's own agent, for the length of one turn (#2779).
        ('g-delegated', 'c-claude', 7, clock_timestamp() + INTERVAL '1 day', clock_timestamp())
    `);
    await client.query(`INSERT INTO mcp_delegations (grant_id) VALUES ('g-delegated')`);

    const summary = await readConnectorTestGrants(client, 7);
    assert.equal(summary.active, 2, 'two consents are active, not five tokens');
    assert.equal(summary.inactive, 1, 'the expired consent is counted, the delegated one is not');
    assert.equal(summary.client_name, 'Claude.ai', 'the most recently used active consent names it');
    assert.ok(summary.last_used_at, 'and its last use is reported');
    const usedAt = Date.parse(summary.last_used_at);
    const minutesAgo = (Date.now() - usedAt) / 60000;
    assert.ok(minutesAgo > 30 && minutesAgo < 90,
      'the newest use (an hour ago), not the older two-day one');
  } finally {
    await client.end();
  }
});
