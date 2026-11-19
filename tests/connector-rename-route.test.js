'use strict';

// Settings > Connectors: PATCH /api/me/connectors/:id (#6137).
//
// A person names one of their connections so two of the same tool can be told
// apart. This pins what the route may and may not do:
//
//   1. it renames the caller's OWN connection only: somebody else's id, a
//      delegated grant and an unknown id all answer the 404 Disconnect answers,
//      and write nothing;
//   2. the name is plain text on one line, trimmed, at most 60 characters, and
//      an empty one (or null) clears it;
//   3. it is a browser-session route: signed in, same origin, and off on a
//      staging copy like every connector write;
//   4. it never reads token material and never touches a credential: the only
//      table it writes is mcp_grant_labels.
//
// Run with: node --test tests/connector-rename-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cliAuth = require('../src/services/cli-auth');
cliAuth.consumeSharedTokenBucket = async () => ({ allowed: true, retryAfter: 0 });

// A pool that knows who holds which connection, and keeps the names it is
// asked to write. `grants` is grant id -> owner; `delegated` are the
// platform's own agents' grants, which are nobody's to rename.
const MINE = 'AAAAAAAAAAAAAAAAAAAAAA';
const THEIRS = 'BBBBBBBBBBBBBBBBBBBBBB';
const DELEGATED = 'CCCCCCCCCCCCCCCCCCCCCC';
const UNKNOWN = 'DDDDDDDDDDDDDDDDDDDDDD';
const grants = new Map([[MINE, 7], [THEIRS, 8], [DELEGATED, 7]]);
const delegated = new Set([DELEGATED]);
let labels = new Map();
let statements = [];
let failWrites = false;

const dbClient = {
  async query(sql, params = []) {
    statements.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (/FROM mcp_tokens/.test(sql)) {
      const [grantId, userId] = params;
      const own = grants.get(grantId) === userId && !delegated.has(grantId);
      return { rows: own ? [{ grant_id: grantId }] : [] };
    }
    if (failWrites) throw new Error('database is away');
    if (/^DELETE FROM mcp_grant_labels/.test(sql)) {
      labels.delete(params[0]);
      return { rows: [] };
    }
    if (/INSERT INTO mcp_grant_labels/.test(sql)) {
      labels.set(params[0], { userId: params[1], label: params[2] });
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  },
  release() {},
};
const pool = {
  connect: async () => dbClient,
  query: async () => { throw new Error('the rename runs on its transaction connection'); },
};
require('../src/db/pool').getPool = () => pool;

const { mcpBrowserRoutes, normalizeConnectorLabel, CONNECTOR_LABEL_MAX } = require('../src/routes/mcp-remote');
const express = require('express');

const ORIGIN = 'https://social-vibecoding.usernodelabs.org';
const CONFIG = { cliAuthEnabled: true, cliAuthOrigin: ORIGIN };

async function patch(id, body, { signedIn = true, headers = { origin: ORIGIN }, raw = null } = {}) {
  const instance = express();
  instance.use((req, _res, next) => {
    if (signedIn) req.user = { id: 7 };
    next();
  });
  instance.use(mcpBrowserRoutes(CONFIG));
  const server = instance.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  statements = [];
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/me/connectors/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw == null ? JSON.stringify(body) : raw,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      cache: response.headers.get('cache-control'),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const wrote = () => statements.some((sql) => /mcp_grant_labels/.test(sql));

test.beforeEach(() => {
  labels = new Map();
  failWrites = false;
});

test('a person names their own connection, trimmed to one plain line', async () => {
  const { status, body, cache } = await patch(MINE, { label: '  Work\n laptop\t ' });
  assert.equal(status, 200);
  assert.deepEqual(body, { id: MINE, label: 'Work laptop' });
  assert.deepEqual(labels.get(MINE), { userId: 7, label: 'Work laptop' });
  assert.match(String(cache), /no-store/, 'like every connector answer');
});

test('renaming again replaces the name', async () => {
  await patch(MINE, { label: 'Work laptop' });
  const { status, body } = await patch(MINE, { label: 'Phone' });
  assert.equal(status, 200);
  assert.equal(body.label, 'Phone');
  assert.equal(labels.get(MINE).label, 'Phone');
  assert.equal(labels.size, 1);
});

test('an empty name, spaces only, or null clears it', async () => {
  for (const label of ['', '   \n ', null]) {
    labels.set(MINE, { userId: 7, label: 'Work laptop' });
    const { status, body } = await patch(MINE, { label });
    assert.equal(status, 200, JSON.stringify(label));
    assert.deepEqual(body, { id: MINE, label: null });
    assert.equal(labels.has(MINE), false, 'the row is gone, so the tool\'s own name shows again');
  }
});

test('somebody else\'s connection, a delegated grant and an unknown id answer 404 and write nothing', async () => {
  for (const id of [THEIRS, DELEGATED, UNKNOWN]) {
    const { status, body } = await patch(id, { label: 'Mine now' });
    assert.equal(status, 404, id);
    assert.deepEqual(body, { error: 'not_found' }, 'exactly what Disconnect answers');
    assert.equal(wrote(), false, `${id}: no name is written`);
    assert.equal(labels.size, 0);
  }
});

test('a name over the cap is refused, and the cap counts characters a person sees', async () => {
  const { status, body } = await patch(MINE, { label: 'x'.repeat(CONNECTOR_LABEL_MAX + 1) });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'label_too_long' });
  assert.equal(statements.length, 0, 'refused before any read');

  const exact = await patch(MINE, { label: 'é'.repeat(CONNECTOR_LABEL_MAX) });
  assert.equal(exact.status, 200);
  const emoji = await patch(MINE, { label: '\u{1F4BB}'.repeat(CONNECTOR_LABEL_MAX) });
  assert.equal(emoji.status, 200, 'sixty characters, though 120 UTF-16 units');
  assert.equal(CONNECTOR_LABEL_MAX, 60);
});

test('anything that is not text or null is refused, not coerced', async () => {
  for (const body of [{ label: 12 }, { label: ['a'] }, { label: { text: 'a' } }, {}, { name: 'Work' }]) {
    const { status, body: answer } = await patch(MINE, body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.deepEqual(answer, { error: 'invalid_request' });
    assert.equal(statements.length, 0);
  }
  const broken = await patch(MINE, null, { raw: '{"label":' });
  assert.equal(broken.status, 400);
  const malformedId = await patch('not-a-grant-id', { label: 'Work' });
  assert.equal(malformedId.status, 400);
  assert.equal(statements.length, 0);
});

test('markup is stored as the text it is, never interpreted', () => {
  assert.deepEqual(normalizeConnectorLabel('<b>Work</b> & "home"'), { label: '<b>Work</b> & "home"' });
  assert.deepEqual(normalizeConnectorLabel('a\u0000b c'), { label: 'a b c' }, 'control characters become a space');
});

test('it needs a signed-in browser on the same origin', async () => {
  const anonymous = await patch(MINE, { label: 'Work' }, { signedIn: false });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body, { error: 'not_authenticated' });

  const crossOrigin = await patch(MINE, { label: 'Work' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  const noOrigin = await patch(MINE, { label: 'Work' }, { headers: {} });
  assert.equal(noOrigin.status, 403);
  const crossSite = await patch(MINE, { label: 'Work' }, { headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(labels.size, 0);
});

test('a database failure is a 503 and the transaction is rolled back', async () => {
  failWrites = true;
  const { status, body } = await patch(MINE, { label: 'Work' });
  assert.equal(status, 503);
  assert.deepEqual(body, { error: 'temporarily_unavailable' });
  assert.ok(statements.includes('ROLLBACK'));
});

test('the route touches no credential: no token material, no revoke, no mint, no audit', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8');
  const start = source.indexOf("router.patch('/api/me/connectors/:id'");
  assert.ok(start > 0, 'the route exists');
  const handler = source.slice(start, source.indexOf('return router;', start));
  assert.match(handler, /browserCsrf\(config, req, res\)/);
  assert.match(handler, /NOT EXISTS \(SELECT 1 FROM mcp_delegations d WHERE d\.grant_id = t\.grant_id\)/);
  assert.match(handler, /t\.user_id = \$2/, 'ownership is the query, not a check after it');
  assert.doesNotMatch(handler, /token_hash|token_hint|revokeGrant|insertAudit|issue|mint|UPDATE mcp_tokens|DELETE FROM mcp_tokens/);
});

test('a staging copy keeps the rename off, like every connector write', () => {
  const mcpOauth = require('../src/services/mcp-oauth');
  assert.equal(mcpOauth.isConnectorSurfacePath(`/api/me/connectors/${MINE}`), true);
  assert.equal(mcpOauth.isStagingReadableConnectorPath('PATCH', `/api/me/connectors/${MINE}`), false);
  const policy = require('../src/services/cli-api-policy');
  assert.equal(policy.isConnectorApiRequest('PATCH', `/api/me/connectors/${MINE}`), false,
    'a connector cannot rename itself: the route is not on its allowlist');
});

test('the names table is additive, private on staging copies, and goes with the account', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/connector-grant-labels.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mcp_grant_labels/);
  assert.match(sql, /grant_id\s+TEXT PRIMARY KEY/);
  assert.match(sql, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /char_length\(label\) BETWEEN 1 AND 60/);
  assert.match(sql, /COMMENT ON TABLE mcp_grant_labels IS 'staging:private'/);
  assert.doesNotMatch(sql, /ALTER TABLE|mcp_tokens \(|DROP /, 'no existing table is changed');
});
