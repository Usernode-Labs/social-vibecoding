// Topochain v4 admin API — D10 database tooling, hardened (Task 13;
// SPEC 2852-2920, Global Constraints #9).
//
// Two layers of coverage, per the task brief:
//   1. Pure unit tests against `sql-console.js`'s `validateStatement` /
//      `wrapWithLimit` / `parseLimit` — no HTTP, no mock pool, just the
//      hardening rules themselves (allow-list, single-statement,
//      comment/CTE smuggling, row-cap wrapping).
//   2. HTTP-level tests mounting the real `topochainAdminRoutes` (auth
//      gates included) on a throwaway express app, backed by a SQL-
//      dispatching mock pool (same idiom as tests/board-order.test.js /
//      tests/topochain-admin-api2.test.js) — covers auth posture,
//      response shapes, the export's secret-column/table exclusions, and
//      the honest-failure marker line.
//
// Run with: node --test tests/topochain-db-tools.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Same require.cache indirection as the other topochain admin test
// files: the mock MUST be installed on the `db/pool` module's exports
// BEFORE anything that does `const { getPool } = require('.../db/pool')`
// is required, since destructuring copies the function reference at
// require-time, not a live binding.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const {
  validateStatement,
  wrapWithLimit,
  parseLimit,
  extractReferencedTables,
} = require('../src/services/topochain/sql-console');
const { TEMPLATES } = require('../src/services/topochain/db-query-templates');
const { QUERYABLE_TABLES } = require('../src/services/topochain/db-allowlist');

// ═══════════════════════════════════════════════════════════════════════
// 1. Pure unit tests — sql-console.js hardening rules
// ═══════════════════════════════════════════════════════════════════════

test('validateStatement: allows a plain SELECT against an allowed table', () => {
  const r = validateStatement('SELECT id, name FROM seasons');
  assert.equal(r.ok, true);
});

test('validateStatement: allows a WITH/CTE query that JOINs back to its own alias', () => {
  const r = validateStatement(`
    WITH latest AS (SELECT season_event_id, MAX(snapshot_at) AS at FROM leaderboard_snapshots GROUP BY season_event_id)
    SELECT ls.season_event_id, ls.user_id, ls.rank FROM leaderboard_snapshots ls JOIN latest ON latest.season_event_id = ls.season_event_id
  `);
  assert.equal(r.ok, true);
});

test('validateStatement: allows a single trailing semicolon (only whitespace after it)', () => {
  const r = validateStatement('SELECT id FROM seasons;   ');
  assert.equal(r.ok, true);
});

for (const [label, sql] of [
  ['INSERT', `INSERT INTO seasons (name) VALUES ('x')`],
  ['UPDATE', `UPDATE seasons SET name = 'x'`],
  ['DELETE', `DELETE FROM seasons`],
  ['DROP', `DROP TABLE seasons`],
  ['TRUNCATE', `TRUNCATE seasons`],
]) {
  test(`validateStatement: rejects a bare ${label} statement (not SELECT/WITH)`, () => {
    const r = validateStatement(sql);
    assert.equal(r.ok, false);
    assert.match(r.reason, /SELECT and WITH/);
  });
}

test('validateStatement: rejects multiple statements separated by a semicolon', () => {
  const r = validateStatement('SELECT 1; SELECT 2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /single SQL statement/);
});

test('validateStatement: rejects a second statement even when it is itself a write', () => {
  const r = validateStatement('SELECT * FROM seasons; DELETE FROM seasons;');
  assert.equal(r.ok, false);
  assert.match(r.reason, /single SQL statement/);
});

test('validateStatement: a semicolon inside a string literal is not mistaken for a statement separator', () => {
  const r = validateStatement(`SELECT ';' AS marker FROM seasons`);
  assert.equal(r.ok, true);
});

test('validateStatement: rejects a write smuggled inside a CTE (starts with WITH, mutates inside)', () => {
  const r = validateStatement(`WITH x AS (DELETE FROM seasons RETURNING *) SELECT * FROM x`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /DELETE/i);
});

test('validateStatement: a comment cannot smuggle a non-SELECT statement past the prefix check', () => {
  // The real first statement, once comments are stripped, is DELETE —
  // the leading line comment must not be read as "the query starts with
  // a comment mentioning SELECT, so it's fine".
  const r = validateStatement('-- SELECT 1\nDELETE FROM seasons');
  assert.equal(r.ok, false);
  assert.match(r.reason, /SELECT and WITH/);
});

test('validateStatement: a block comment cannot hide a DROP before the real statement', () => {
  const r = validateStatement('/* just a select, trust me */ DROP TABLE seasons');
  assert.equal(r.ok, false);
});

test('validateStatement: rejects denied substrings case-insensitively (pg_read_file and friends)', () => {
  const r1 = validateStatement(`SELECT pg_read_file('/etc/passwd')`);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /pg_read_file/i);

  const r2 = validateStatement(`select PG_Read_File('/etc/passwd')`);
  assert.equal(r2.ok, false);
});

test('validateStatement: rejects a query referencing a non-topochain table', () => {
  const r = validateStatement('SELECT * FROM users');
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside the allowed list/);
  assert.match(r.reason, /users/);
});

test('validateStatement: allows a JOIN across two allowed topochain tables', () => {
  const r = validateStatement(
    'SELECT s.id, se.id FROM seasons s JOIN season_events se ON se.season_id = s.id'
  );
  assert.equal(r.ok, true);
});

test('validateStatement: rejects mobile_otp_codes / mobile_auth_tokens even though they are real topochain tables', () => {
  const r1 = validateStatement('SELECT * FROM mobile_otp_codes');
  assert.equal(r1.ok, false);
  const r2 = validateStatement('SELECT * FROM mobile_auth_tokens');
  assert.equal(r2.ok, false);
});

test('validateStatement: rejects an EXPLICIT reference to onchain_accounts.secret_key or .registration_code', () => {
  const r1 = validateStatement('SELECT secret_key FROM onchain_accounts');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /secret_key/);

  const r2 = validateStatement('SELECT id, registration_code FROM onchain_accounts');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /registration_code/);
});

test('validateStatement: rejects a bare wildcard against onchain_accounts (the by-name check alone would miss this)', () => {
  const r1 = validateStatement('SELECT * FROM onchain_accounts');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /wildcard/);

  const r2 = validateStatement('SELECT oa.* FROM onchain_accounts oa');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /wildcard/);
});

test('validateStatement: allows COUNT(*) — an aggregate star returns no column data, so it is not treated as a wildcard', () => {
  const r = validateStatement('SELECT tier, COUNT(*) FROM onchain_accounts GROUP BY tier');
  assert.equal(r.ok, true);
});

test('validateStatement: a bare wildcard against an allowed table with no secrets is still rejected (explicit-columns policy is blanket, not table-specific)', () => {
  const r = validateStatement('SELECT * FROM seasons');
  assert.equal(r.ok, false);
  assert.match(r.reason, /wildcard/);
});

test('extractReferencedTables: finds FROM/JOIN identifiers and CTE aliases separately', () => {
  const { tables, cteNames } = extractReferencedTables(
    'WITH latest AS (SELECT 1) SELECT * FROM seasons JOIN latest ON true'
  );
  assert.ok(tables.has('seasons'));
  assert.ok(tables.has('latest'));
  assert.ok(cteNames.has('latest'));
});

test('wrapWithLimit: wraps a plain query in an outer bounded SELECT', () => {
  const wrapped = wrapWithLimit('SELECT * FROM seasons', 100);
  assert.equal(wrapped, 'SELECT * FROM (SELECT * FROM seasons) AS _topochain_console_q LIMIT 101');
});

test('wrapWithLimit: strips a single trailing semicolon before wrapping', () => {
  const wrapped = wrapWithLimit('SELECT * FROM seasons;', 5);
  assert.equal(wrapped, 'SELECT * FROM (SELECT * FROM seasons) AS _topochain_console_q LIMIT 6');
});

test('wrapWithLimit: wraps a CTE query intact (no special-casing needed)', () => {
  const inner = 'WITH x AS (SELECT 1) SELECT * FROM x';
  const wrapped = wrapWithLimit(inner, 10);
  assert.equal(wrapped, `SELECT * FROM (${inner}) AS _topochain_console_q LIMIT 11`);
});

test('wrapWithLimit: a query that already contains the word LIMIT keeps its own inner LIMIT as an inner ceiling', () => {
  const inner = 'SELECT * FROM seasons LIMIT 3';
  const wrapped = wrapWithLimit(inner, 100);
  assert.equal(wrapped, `SELECT * FROM (${inner}) AS _topochain_console_q LIMIT 101`);
  // The inner LIMIT text is preserved verbatim inside the wrap, not
  // parsed/rewritten/removed.
  assert.match(wrapped, /FROM seasons LIMIT 3\)/);
});

for (const [label, value, expected] of [
  ['absent -> default 100', undefined, { value: 100 }],
  ['empty string -> default 100', '', { value: 100 }],
  ['valid int', 250, { value: 250 }],
  ['valid numeric string', '17', { value: 17 }],
  ['min boundary 1', 1, { value: 1 }],
  ['max boundary 1000', 1000, { value: 1000 }],
]) {
  test(`parseLimit: ${label}`, () => {
    assert.deepEqual(parseLimit(value), expected);
  });
}

for (const [label, value] of [
  ['zero', 0],
  ['negative', -5],
  ['over 1000', 1001],
  ['non-integer', 1.5],
  ['non-numeric string', 'abc'],
  ['boolean true', true],
]) {
  test(`parseLimit: rejects ${label}`, () => {
    assert.deepEqual(parseLimit(value), { error: true });
  });
}

test('templates: all six pass validateStatement (the exact execute-endpoint gate) and reference only topochain tables', () => {
  assert.equal(TEMPLATES.length, 6);
  for (const t of TEMPLATES) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    const result = validateStatement(t.query);
    assert.equal(result.ok, true, `template "${t.name}" failed validation: ${result.reason}`);
    assert.doesNotMatch(t.query.toLowerCase(), /\bmetrics\b/, 'SPEC 2920: templates must not reference the excluded metrics table');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. HTTP-level tests — real router, mock pool
// ═══════════════════════════════════════════════════════════════════════

let scenario;

function handleQuery(sql) {
  const t = sql.trim();
  if (/^BEGIN/i.test(t)) return { rows: [] };
  if (/^SET LOCAL/i.test(t)) return { rows: [] };
  if (/^COMMIT/i.test(t)) return { rows: [] };
  if (/^ROLLBACK/i.test(t)) return { rows: [] };

  // GET /sql-query/schema's two introspection queries.
  if (/pg_class/.test(t) && /reltuples/.test(t)) return { rows: scenario.schemaTableRows || [] };
  if (/information_schema\.columns/.test(t)) return { rows: scenario.schemaColumnRows || [] };

  // GET /database/export's per-table data query.
  const exportMatch = t.match(/^SELECT .+ FROM (\w+) ORDER BY 1$/i);
  if (exportMatch) {
    const table = exportMatch[1];
    if (scenario.failTables && scenario.failTables.has(table)) {
      throw new Error(`synthetic failure for ${table}: contains an internal detail that must never reach the client`);
    }
    return { rows: (scenario.rowsByTable && scenario.rowsByTable[table]) || [] };
  }

  // POST /sql-query/execute's wrapped console query.
  if (/_topochain_console_q/.test(t)) {
    if (scenario.executeThrows) throw scenario.executeThrows;
    const rows = scenario.executeRows || [];
    const fields = rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [];
    return { rows, fields };
  }

  throw new Error(`Unhandled SQL in mock: ${sql}`);
}

function makeMockPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push(sql); return handleQuery(sql, params); },
    async connect() {
      return {
        async query(sql, params) { calls.push(sql); return handleQuery(sql, params); },
        release() {},
      };
    },
  };
}

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') return next();
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; return next(); }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; return next(); }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildApp(role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  scenario = {};
  currentMockPool = makeMockPool();
});

// ── POST /sql-query/execute ─────────────────────────────────────────────

test('execute: a blocked pattern is rejected before ever touching the pool (400, explains itself)', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'DELETE FROM seasons' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /SELECT and WITH/);
    assert.equal(body.query, 'DELETE FROM seasons');
    assert.equal(currentMockPool.calls.length, 0, 'validation must short-circuit before any DB round-trip');
  } finally { server.close(); }
});

test('execute: a table outside the allow-list is rejected with an explanation', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT * FROM users' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /outside the allowed list/);
  } finally { server.close(); }
});

test('execute: a valid SELECT runs inside BEGIN TRANSACTION READ ONLY + SET LOCAL statement_timeout, wrapped with the row cap', async () => {
  scenario.executeRows = [{ id: 1, name: 'Season 1' }];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id, name FROM seasons' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, [{ id: 1, name: 'Season 1' }]);
    assert.deepEqual(body.columns, ['id', 'name']);
    assert.equal(body.row_count, 1);
    assert.equal(body.limited, false);
    assert.equal(typeof body.execution_time_ms, 'number');
    assert.equal(body.query, 'SELECT id, name FROM seasons');

    assert.ok(currentMockPool.calls.some((c) => /^BEGIN TRANSACTION READ ONLY/i.test(c.trim())));
    assert.ok(currentMockPool.calls.some((c) => /^SET LOCAL statement_timeout/i.test(c.trim())));
    assert.ok(currentMockPool.calls.some((c) => c.includes('_topochain_console_q') && c.includes('LIMIT 101')));
  } finally { server.close(); }
});

test('execute: row cap enforcement — cap+1 rows come back limited and sliced to the cap', async () => {
  scenario.executeRows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id FROM seasons', limit: 2 }),
    });
    const body = await res.json();
    assert.equal(body.limited, true);
    assert.equal(body.row_count, 2);
    assert.equal(body.data.length, 2);
    assert.ok(currentMockPool.calls.some((c) => c.includes('LIMIT 3')));
  } finally { server.close(); }
});

test('execute: a raw driver error is never echoed to the client', async () => {
  scenario.executeThrows = new Error('relation "top_secret_internal_table" leaked column names and a stack trace');
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id FROM seasons' }),
    });
    assert.equal(res.status, 400);
    const raw = await res.text();
    assert.doesNotMatch(raw, /top_secret_internal_table/);
    assert.doesNotMatch(raw, /stack trace/);
    const body = JSON.parse(raw);
    assert.equal(body.success, false);
    assert.equal(body.error, 'Query failed.');
    assert.equal(body.query, 'SELECT id FROM seasons');
    assert.ok(currentMockPool.calls.some((c) => /^ROLLBACK/i.test(c.trim())), 'a failed query must roll back');
  } finally { server.close(); }
});

test('execute: base validation (missing query, oversized query, out-of-range limit) is 422', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const missing = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(missing.status, 422);

    const tooLong = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT ' + '1'.repeat(10001) }),
    });
    assert.equal(tooLong.status, 422);

    const badLimit = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1', limit: 1001 }),
    });
    assert.equal(badLimit.status, 422);
  } finally { server.close(); }
});

test('execute: a view-only (readonly) admin CAN execute — it is read-only by construction', async () => {
  scenario.executeRows = [{ ok: 1 }];
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1 AS ok FROM seasons' }),
    });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

test('execute: a non-admin gets the platform 403, never reaching the console', async () => {
  const { server, base } = await listen(buildApp('user'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1 FROM seasons' }),
    });
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

// ── GET /sql-query/schema ───────────────────────────────────────────────

test('schema: shape per SPEC, real row estimate (not a lifetime counter), all 20 queryable tables present', async () => {
  scenario.schemaTableRows = [{ name: 'seasons', comment: null, estimated_rows: 42.4 }];
  scenario.schemaColumnRows = [
    { table_name: 'seasons', column_name: 'id', data_type: 'bigint', nullable: false, default_value: null, comment: null, key_type: 'primary' },
    { table_name: 'seasons', column_name: 'name', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
    // A row simulating what the raw information_schema.columns query
    // WOULD return for onchain_accounts' two secret columns — the
    // service itself must filter these out; the mock is not what does
    // the filtering (see db-schema-info.js's `isExcludedColumn`).
    { table_name: 'onchain_accounts', column_name: 'secret_key', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
    { table_name: 'onchain_accounts', column_name: 'registration_code', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: 'unique' },
    { table_name: 'onchain_accounts', column_name: 'tier', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
  ];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/schema`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, QUERYABLE_TABLES.length);
    assert.ok(!body.data.some((t) => t.name === 'mobile_otp_codes'));
    assert.ok(!body.data.some((t) => t.name === 'mobile_auth_tokens'));

    const seasons = body.data.find((t) => t.name === 'seasons');
    assert.equal(seasons.estimated_rows, 42); // rounded, and NOT a lifetime write counter
    assert.equal(seasons.columns.length, 2);
    assert.deepEqual(seasons.columns[0], {
      name: 'id', type: 'bigint', nullable: false, default_value: null, comment: null, key_type: 'primary',
    });

    const untouched = body.data.find((t) => t.name === 'chains');
    assert.equal(untouched.estimated_rows, 0);
    assert.deepEqual(untouched.columns, []);

    const onchainAccounts = body.data.find((t) => t.name === 'onchain_accounts');
    assert.ok(!onchainAccounts.columns.some((c) => c.name === 'secret_key'));
    assert.ok(!onchainAccounts.columns.some((c) => c.name === 'registration_code'));
    assert.ok(onchainAccounts.columns.some((c) => c.name === 'tier'));
  } finally { server.close(); }
});

// ── GET /sql-query/templates ─────────────────────────────────────────────

test('templates: HTTP endpoint returns the six static templates', async () => {
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/templates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, 6);
    for (const t of body.data) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.query, 'string');
    }
  } finally { server.close(); }
});

// ── GET /database/export ─────────────────────────────────────────────────

test('export: a view-only admin is refused (write gate — matches the platform export\'s full-admin-only posture)', async () => {
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Full admin access required.' });
  } finally { server.close(); }
});

test('export: a full admin downloads a SQL file that excludes secret columns and the two denied tables entirely', async () => {
  scenario.rowsByTable = {
    onchain_accounts: [{
      id: 5, amount: 100, identity_uid: 'uid-1', address: 'ut1abc', public_key: 'utpk1abc',
      tier: 'gold', description: null, season_event_id: null, season_id: 1, user_id: 1,
      is_used: false, used_at: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
      // Simulates a row that (hypothetically) still carried the secret
      // fields — proves the leak can't happen even if the query layer
      // ever regresses, since the export only ever reads the columns
      // it asked for.
      secret_key: 'SHOULD_NEVER_LEAK_SECRET', registration_code: 'SHOULD_NEVER_LEAK_CODE',
    }],
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="topochain-export-.*\.sql"/);

    const text = await res.text();
    assert.doesNotMatch(text, /SHOULD_NEVER_LEAK_SECRET/);
    assert.doesNotMatch(text, /SHOULD_NEVER_LEAK_CODE/);
    assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS mobile_otp_codes/);
    assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS mobile_auth_tokens/);

    // Isolate onchain_accounts' own CREATE TABLE + INSERT section (the
    // header comment ABOVE this legitimately names the two excluded
    // columns to document the redaction — that's not a leak, so the
    // exclusion check below is scoped to onchain_accounts' own block,
    // not the whole file).
    const onchainStart = text.indexOf('CREATE TABLE IF NOT EXISTS onchain_accounts');
    const onchainEnd = text.indexOf('-- ── account_delegation_periods');
    assert.ok(onchainStart !== -1 && onchainEnd > onchainStart);
    const onchainSection = text.slice(onchainStart, onchainEnd);
    assert.doesNotMatch(onchainSection, /secret_key/);
    assert.doesNotMatch(onchainSection, /registration_code/);

    // The SQL sent to the pool for onchain_accounts must not even ask
    // for the excluded columns.
    const onchainQuery = currentMockPool.calls.find((c) => /FROM onchain_accounts/.test(c));
    assert.ok(onchainQuery);
    assert.doesNotMatch(onchainQuery, /secret_key/);
    assert.doesNotMatch(onchainQuery, /registration_code/);

    assert.match(text, /CREATE TABLE IF NOT EXISTS seasons \(/);
    assert.match(text, /INSERT INTO onchain_accounts/);
  } finally { server.close(); }
});

test('export: a real row renders as a restorable INSERT plus a sequence setval', async () => {
  scenario.rowsByTable = {
    seasons: [{
      id: 7, name: 'Season Test', description: null,
      starts_at: new Date('2026-01-01T00:00:00Z'), ends_at: new Date('2026-06-01T00:00:00Z'),
      is_active: true, internal: false, display_order: 0, pool_info: null,
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    }],
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    const text = await res.text();
    assert.match(text, /INSERT INTO seasons \(id, name, description, starts_at, ends_at, is_active, internal, display_order, pool_info, created_at, updated_at\) VALUES \(7, 'Season Test', NULL, '2026-01-01T00:00:00\.000Z', '2026-06-01T00:00:00\.000Z', TRUE, FALSE, 0, NULL, '2026-01-01T00:00:00\.000Z', '2026-01-01T00:00:00\.000Z'\);/);
    assert.match(text, /SELECT setval\('seasons_id_seq', 7, true\);/);
  } finally { server.close(); }
});

test('export: honest failure — a mid-stream error still returns 200 (headers already committed) but ends with a visible marker line, and never continues to later tables', async () => {
  scenario.failTables = new Set(['chains']);
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    assert.equal(res.status, 200); // the 200 was already committed before the failure
    const text = await res.text();

    // Tables ordered BEFORE 'chains' got their DDL written.
    assert.match(text, /CREATE TABLE IF NOT EXISTS seasons \(/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS chains \(/); // chains' own DDL is written before its data query runs

    // The marker line is present and visible (not a silently truncated file).
    assert.match(text, /^-- EXPORT FAILED: .*chains/m);

    // Nothing after 'chains' in QUERYABLE_TABLES order was reached.
    const chainsIdx = QUERYABLE_TABLES.indexOf('chains');
    for (const later of QUERYABLE_TABLES.slice(chainsIdx + 1)) {
      assert.doesNotMatch(text, new RegExp(`CREATE TABLE IF NOT EXISTS ${later} \\(`));
    }
  } finally { server.close(); }
});
