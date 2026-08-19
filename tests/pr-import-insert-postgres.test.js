// #1176: the pr-import INSERT INTO chat_sessions, executed by a REAL
// postgres planner.
//
// Why this file exists — POST /api/apps/:slug/pr-import (added by #1171)
// 500'd on EVERY import in production. The statement reused parameter $7
// (the initial status) in conflicting type contexts: once as the value for
// the `status` column, which is VARCHAR(32), and twice inside
// `CASE WHEN $7 = 'promoted'/'active' THEN NOW() END`, where postgres
// deduces `text`. Postgres 17 rejects that at prepare time with
// "inconsistent types deduced for parameter $7 — text versus character
// varying"; the route's catch-all turned it into the 500 and no session row
// was ever created. The fix casts ALL THREE uses to ::text (casting only the
// CASE uses is not sufficient — the deduction conflict remains unless every
// use agrees; the text→varchar assignment cast on the VALUES position is
// fine).
//
// The pr-import unit tests drive the route against a recordingPool() fake,
// so the SQL string was never parsed by a real postgres and every assertion
// passed while production was down. Only the planner sees this class of bug
// — so, like tests/check-history-postgres.test.js, this file creates the
// real column types in a throwaway schema and executes the real statement.
//
// The statement is EXTRACTED FROM THE LIVE SOURCE of src/routes/votes.js at
// test time (not copied here), so a future edit to the handler's INSERT is
// what this test exercises — a parameter-type conflict reintroduced there
// fails CI instead of only failing in production.
//
// ── When it runs ────────────────────────────────────────────────────────
//
// The planner test runs when a postgres server is reachable — a dev checkout
// with `make up`, or any environment exporting TEST_DATABASE_URL. Where no
// database exists (the merge-gate unit-suite container) it SKIPS, and the
// hermetic cast-shape guard below is what holds the line.
//
// Run with: node --test tests/pr-import-insert-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// Pull the exact statement out of the handler. Anchored on
// `RETURNING id, status`, which only the pr-import INSERT carries (the
// revert-session INSERT further down returns bare `id`).
function extractImportInsert() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  const m = source.match(/`(INSERT INTO chat_sessions[\s\S]*?RETURNING id, status)`/);
  assert.ok(m, 'the pr-import INSERT INTO chat_sessions statement exists in routes/votes.js');
  return m[1];
}

// The column types are copied from src/db/schema.sql deliberately: the bug
// is `status VARCHAR(32)` disagreeing with the `text` the CASE comparisons
// deduce, so a test table with looser types would not reproduce it. FKs are
// dropped — referential integrity plays no part in parameter-type deduction.
const DDL = `
  CREATE TABLE chat_sessions (
    id                   SERIAL PRIMARY KEY,
    app_id               INTEGER,
    user_id              INTEGER,
    branch_name          VARCHAR(255),
    pr_number            INTEGER,
    pr_url               VARCHAR(512),
    pr_title             VARCHAR(256),
    status               VARCHAR(32) NOT NULL DEFAULT 'active',
    source               TEXT,
    imported_pr_head_sha VARCHAR(40),
    imported_pr_author   VARCHAR(255),
    imported_pr_head_repo TEXT,
    promoted_at          TIMESTAMPTZ,
    shared_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    testing_md           TEXT,
    testing_path         VARCHAR(512),
    testing_paths        JSONB,
    linked_issues        INTEGER[] NOT NULL DEFAULT '{}'
  )`;

// The same 14-element parameter shape the handler binds ($10 is the head
// repository #1196 records, which is what decides whether the proposal's head
// is in the author's fork or in the app's own repository; $14 is the request
// the work order was prepared from, #1217).
function importParams(status, prNumber, linkedIssues = [1217]) {
  return [
    1, 2, 'pr-import-test-branch', prNumber, 'https://github.com/acme/demo/pull/' + prNumber,
    'PR #' + prNumber, status,
    'a'.repeat(40), 'external-author', 'external-author/demo',
    '1. Open the board', '/board?demo=1',
    JSON.stringify([{ path: '/board?demo=1', viewport: 'desktop' }]),
    linkedIssues,
    // #1333. The imported PR's body, mirrored so get_proposal can report the
    // description a voter reads without a GitHub round trip.
    'What this pull request changes, in the author\'s own words.',
  ];
}

// Connect, or report why not. Never throws — an unreachable server is a skip.
async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

// A private schema per test process, so a run against a developer's live
// platform database cannot touch the real table. Dropped in `finally`.
async function withSchema(client, fn) {
  const name = `pr_import_insert_test_${process.pid}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query(DDL);
    return await fn();
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

test('the pr-import INSERT prepares and writes both status paths on real postgres', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  const sql = extractImportInsert();
  try {
    await withSchema(client, async () => {
      // Default browser-import path: status 'active'. Before the #1176 fix
      // this statement never got past Parse, so the first assertion is that
      // it executes at all.
      const { rows: activeRows } = await client.query(sql, importParams('active', 101));
      assert.equal(activeRows[0].status, 'active');

      const { rows: [active] } = await client.query(
        'SELECT status, source, shared_at, promoted_at, imported_pr_head_repo '
        + 'FROM chat_sessions WHERE id = $1',
        [activeRows[0].id]
      );
      assert.equal(active.source, 'imported');
      assert.ok(active.shared_at, 'an active import joins the shared In-progress board');
      assert.equal(active.promoted_at, null, 'an active import is not up for vote yet');
      assert.equal(active.imported_pr_head_repo, 'external-author/demo',
        'the repository the PR head lives in is recorded at import time (#1196)');

      // promote: true path: status 'promoted' — the CASE arms flip.
      const { rows: promotedRows } = await client.query(sql, importParams('promoted', 102));
      assert.equal(promotedRows[0].status, 'promoted');

      const { rows: [promoted] } = await client.query(
        'SELECT status, source, shared_at, promoted_at, linked_issues FROM chat_sessions WHERE id = $1',
        [promotedRows[0].id]
      );
      assert.equal(promoted.source, 'imported');
      assert.ok(promoted.promoted_at, 'a promoted import lands straight in the vote panel');
      assert.equal(promoted.shared_at, null, 'a promoted import skips the In-progress board');
      assert.deepEqual(promoted.linked_issues, [1217],
        'the request the work order was prepared from (#1217)');

      // #1217: the column is INTEGER[] NOT NULL, so the no-request case —
      // every browser import — has to bind the empty array. Binding null
      // here would fail the constraint on the statement's commonest use,
      // and nothing above this line would have noticed.
      const { rows: bareRows } = await client.query(sql, importParams('active', 103, []));
      const { rows: [bare] } = await client.query(
        'SELECT linked_issues FROM chat_sessions WHERE id = $1', [bareRows[0].id]
      );
      assert.deepEqual(bare.linked_issues, [], 'an import with no request links none');
    });
  } finally {
    await client.end().catch(() => {});
  }
});

// The guard that runs everywhere, including the database-less merge gate:
// every use of the status parameter must carry an explicit ::text cast.
// Likewise database-free, and for the same reason: the postgres test above
// SKIPS wherever no server is reachable, so a column added to the statement
// without a parameter to bind to it reaches the merge gate green and fails on
// the first real import ("bind message supplies N parameters, but prepared
// statement requires N+1"). Counting the placeholders costs nothing and
// catches it everywhere.
test('the pr-import INSERT binds exactly as many parameters as the handler supplies', () => {
  const sql = extractImportInsert();
  const highest = Math.max(...(sql.match(/\$(\d+)/g) || ['$0']).map((p) => Number(p.slice(1))));
  assert.equal(highest, importParams('active', 1).length,
    'every $N in the statement has a value in importParams, and vice versa');
  // And every position in between is actually used — a gap means a shifted
  // parameter list, which binds silently and writes the wrong columns.
  for (let n = 1; n <= highest; n++) {
    assert.match(sql, new RegExp(`\\$${n}\\b`), `the statement uses $${n}`);
  }
});

// One bare use beside a cast one re-creates the "inconsistent types deduced
// for parameter $7" prepare failure, whichever position the bare one is in.
test('every use of the status parameter in the pr-import INSERT is cast to ::text', () => {
  const sql = extractImportInsert();
  const uses = sql.match(/\$7(?:::\w+)?/g) || [];
  assert.equal(uses.length, 3,
    'the statement uses $7 for the status column and both CASE comparisons');
  for (const use of uses) {
    assert.equal(use, '$7::text',
      'a bare $7 deduces a type from its own context (varchar in VALUES, text '
      + 'in a CASE comparison); all uses must agree or postgres rejects the '
      + 'statement at prepare time: ' + sql.replace(/\s+/g, ' ').trim());
  }
});
