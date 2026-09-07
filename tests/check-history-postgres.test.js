// #1144: recordRun, executed by a REAL postgres planner.
//
// Why this file exists at all — tests/check-history.test.js asserts the SQL
// *string* against a fake pool, and every assertion in it passed while the
// statement postgres was actually being handed could not run:
//
//   INSERT INTO app_check_history ... SELECT v.app_id, ... FROM (VALUES ($1, ...))
//
// A bind parameter inside a sub-SELECT's VALUES list has nothing to infer a
// type from, so postgres resolves it to `text`. `app_id` is an `integer`
// column, so the INSERT was rejected with "column app_id is of type integer
// but expression is of type text" — and recordRun catches its own errors as
// non-fatal, so the only symptom was a warning line per run and an
// app_check_history table that stayed empty forever. An empty history reads,
// under the #1019 earned-gating rule, as "no check has ever passed", i.e.
// nothing blocking: the merge gate was quietly open.
//
// No amount of string-matching finds that. Only the planner does. So this
// file creates the real table in a throwaway schema and executes the real
// statement.
//
// ── When it runs ────────────────────────────────────────────────────────
//
// When a postgres server is reachable — a dev checkout with `make up`, or
// any environment exporting TEST_DATABASE_URL. The merge-gate unit-suite
// container (usernode-worker, #1143) has no database, so there it SKIPS
// rather than fails; a test that cannot reach its dependency is not evidence
// of a defect. The hermetic cast-shape guard below runs everywhere and is
// what actually holds the line in CI.
//
// Run with: node --test tests/check-history-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const checkHistory = require('../src/services/check-history');

const ROOT = path.join(__dirname, '..');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// The column types have to be the REAL ones: the bug is a mismatch between
// what the VALUES list resolves to and what the column declares, so a test
// table with looser types would not reproduce it.
//
// The table, DERIVED from src/db/schema.sql rather than copied from it.
//
// This used to be a hand-written replica, and it drifted the moment the real
// table grew a column: recordRun started writing `consecutive_passes`, the
// replica did not have it, postgres refused the statement, recordRun
// swallowed the error and returned 0 — which is the exact failure mode this
// whole file exists to catch, reproduced by the file itself. A local run
// could not see it either, because it skips without a server.
//
// So the DDL is read: the CREATE TABLE block, then every ALTER and UPDATE
// the schema applies to this table, in file order. The foreign key is the
// one thing dropped, because the test schema has no `apps` table to point
// at.
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
const DDL = (() => {
  const start = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS app_check_history');
  if (start < 0) throw new Error('app_check_history is not in schema.sql any more');
  const end = SCHEMA_SQL.indexOf(');', start) + 2;
  const create = SCHEMA_SQL.slice(start, end)
    .replace('IF NOT EXISTS ', '')
    .replace(/\s*REFERENCES apps\(id\) ON DELETE CASCADE/, '');
  const alters = SCHEMA_SQL.match(/^ALTER TABLE app_check_history[^;]*;/gm) || [];
  const updates = SCHEMA_SQL.match(/^UPDATE app_check_history[^;]*;/gm) || [];
  return [create, ...alters, ...updates].join('\n');
})();

// Connect, or report why not. Never throws — an unreachable server is a skip.
async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    // A refused loopback connection surfaces as an AggregateError whose
    // `message` is EMPTY — a falsy `error` here read as "connected", the
    // skip was bypassed, and the test crashed on `client.end()` in every
    // environment without a local postgres (including the unit-suite
    // merge-gate container). Always return something truthy.
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

// A private schema per test process, so a run against a developer's live
// platform database cannot touch the real table. Dropped in `finally`.
async function withSchema(client, fn) {
  const name = `check_history_test_${process.pid}`;
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

test('recordRun actually writes — the VALUES list resolves to the column types', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  // recordRun only ever calls pool.query, so the client stands in for a pool.
  try {
    await withSchema(client, async () => {
      const rows = [
        { checkKey: 'k-pass', name: 'a passing check', path: '/#app/x/dev', passed: true },
        { checkKey: 'k-fail', name: 'a failing check', path: '/#app/x/dev', passed: false },
      ];

      // recordRun swallows write errors and returns 0 — which is exactly how
      // the bug hid — so the return value is the first assertion, not an
      // afterthought.
      assert.equal(await checkHistory.recordRun(client, 7, rows), 2,
        'recordRun reports the rows it wrote; 0 means postgres refused the statement');

      const { rows: got } = await client.query(
        'SELECT check_key, check_name, check_path, pass_count, fail_count,'
        + ' first_passed_at, last_passed_at, last_failed_at'
        + '  FROM app_check_history WHERE app_id = 7 ORDER BY check_key'
      );
      assert.equal(got.length, 2, 'both rows landed');

      const [failed, passed] = got;
      assert.equal(passed.check_key, 'k-pass');
      assert.equal(passed.check_name, 'a passing check');
      assert.equal(passed.check_path, '/#app/x/dev');
      assert.equal(passed.pass_count, 1);
      assert.equal(passed.fail_count, 0);
      assert.ok(passed.first_passed_at, 'a passing check graduates on its first pass');
      assert.ok(passed.last_passed_at);
      assert.equal(passed.last_failed_at, null);

      assert.equal(failed.check_key, 'k-fail');
      assert.equal(failed.pass_count, 0);
      assert.equal(failed.fail_count, 1);
      assert.equal(failed.first_passed_at, null,
        'a check that has never passed has not earned the right to block a merge');
      assert.ok(failed.last_failed_at);

      // …and the no-demotion rule, on the real ON CONFLICT path: the graduated
      // check now fails, the never-passed one now passes.
      assert.equal(await checkHistory.recordRun(client, 7, [
        { checkKey: 'k-pass', name: 'a passing check', path: '/#app/x/dev', passed: false },
        { checkKey: 'k-fail', name: 'a failing check', path: '/#app/x/dev', passed: true },
      ]), 2);

      const { rows: after } = await client.query(
        'SELECT check_key, pass_count, fail_count, first_passed_at'
        + '  FROM app_check_history WHERE app_id = 7 ORDER BY check_key'
      );
      const byKey = Object.fromEntries(after.map((r) => [r.check_key, r]));
      assert.ok(byKey['k-pass'].first_passed_at,
        'a failure never un-graduates a check — that is the whole guard rail');
      assert.equal(byKey['k-pass'].pass_count, 1, 'counts accumulate, they do not reset');
      assert.equal(byKey['k-pass'].fail_count, 1);
      assert.ok(byKey['k-fail'].first_passed_at, 'and a first pass graduates, late or not');
      assert.equal(byKey['k-fail'].pass_count, 1);
    });
  } finally {
    await client.end().catch(() => {});
  }
});

// The guard that runs everywhere, including the database-less merge gate.
// Same idea as tests/set-checks-pending.test.js: pin the property that makes
// the planner happy, since the planner itself is not always available.
test('every parameter in the VALUES list carries an explicit cast', async () => {
  const calls = [];
  const pool = { query: async (text, params) => { calls.push({ text, params }); return { rows: [] }; } };

  await checkHistory.recordRun(pool, 7, [
    { checkKey: 'k1', name: 'n1', path: '/p1', passed: true },
    { checkKey: 'k2', name: 'n2', path: '/p2', passed: false },
  ]);

  const sql = calls[0].text;
  const valuesList = sql.slice(sql.indexOf('FROM (VALUES'), sql.indexOf('AS v('));
  assert.ok(valuesList.includes('$1::int'), 'app_id is an integer column, not text');

  // Match each parameter TOGETHER with its optional cast, rather than
  // looking ahead from a bare `$\d+`. `\d+` is greedy but backtracks: on
  // `$10::int` it tries `10`, sees `::`, backs off to `1`, sees `0`, and
  // reports a false "uncast $1". The suite only grew past nine parameters
  // when a row started carrying pass and fail counts, so the bug sat here
  // reading green for as long as every row fit in single digits.
  const uncast = (valuesList.match(/\$\d+(?:::[a-z]+)?/g) || []).filter((m) => !m.includes('::'));
  assert.deepEqual(uncast, [],
    'a bare parameter in a sub-SELECT VALUES list resolves to text, and the '
    + 'INSERT target is not text: ' + valuesList.replace(/\s+/g, ' ').trim());
});

test('the streak column is what the planner says it is', async (t) => {
  // Only a real planner can tell you whether the CASE over EXCLUDED does
  // what the string looks like it does. The column carries the flaky tag's
  // exit now, so a silent reset or a silent double-count would be invisible
  // until a check either never shed its label or shed it early.
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      const streak = async () => {
        const { rows } = await client.query(
          'SELECT consecutive_passes FROM app_check_history WHERE app_id = 9 AND check_key = $1', ['k']
        );
        return rows.length ? Number(rows[0].consecutive_passes) : null;
      };
      const run = (r) => checkHistory.recordRun(client, 9, [{ checkKey: 'k', name: 'n', path: '/', ...r }]);

      await run({ passed: true });
      assert.equal(await streak(), 1, 'one observation, one');
      await run({ passed: true });
      assert.equal(await streak(), 2, 'and it extends');
      await run({ passed: false });
      assert.equal(await streak(), 0, 'a failure starts it again from nothing');
      await run({ passed: true });
      assert.equal(await streak(), 1);

      // A check on its first appearance arrives as one row carrying all of
      // its runs, so the counts have to add rather than count as one.
      await run({ passes: 3, fails: 0 });
      assert.equal(await streak(), 4, 'three passes are three, not one');
      // And one failure among them ends the streak however many passes came
      // with it — which is the debut rule, expressed in SQL.
      await run({ passes: 2, fails: 1 });
      assert.equal(await streak(), 0);

      const { rows: got } = await client.query(
        'SELECT pass_count, fail_count, first_passed_at, last_failed_at'
        + '  FROM app_check_history WHERE app_id = 9 AND check_key = $1', ['k']
      );
      assert.equal(Number(got[0].pass_count), 8, 'every observation counted');
      assert.equal(Number(got[0].fail_count), 2);
      assert.ok(got[0].first_passed_at, 'and no failure ever clears the first pass');
      assert.ok(got[0].last_failed_at);
    });
  } finally {
    await client.end().catch(() => {});
  }
});
