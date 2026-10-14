// #3344. A head move keeps an author summary that was recorded for that very
// head, and invalidates everything else exactly as before. Run against real
// PostgreSQL because the rule is a SQL expression: a string match on the
// fragment would not notice a NULL comparison that quietly never keeps.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const summaryFreshness = require('../src/services/summary-freshness');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

test('a head move keeps only a fresh author summary recorded for that head', { timeout: 60000 }, async (t) => {
  const pool = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  t.after(() => pool.end());
  await pool.query(`CREATE TEMP TABLE summary_rows (
    id INT PRIMARY KEY,
    pr_summary_md TEXT,
    pr_summary_previous_md TEXT,
    pr_summary_source TEXT,
    pr_summary_source_head_sha VARCHAR(40),
    pr_summary_input_version BIGINT NOT NULL DEFAULT 0,
    pr_summary_stale BOOLEAN NOT NULL DEFAULT FALSE)`);
  const rows = [
    [1, 'author', HEAD, false], // the revision the author just described
    [2, 'author', OTHER, false], // described an earlier head
    [3, 'generated', HEAD, false], // not the author's
    [4, 'author', HEAD, true], // already stale
    [5, 'author', null, false], // no recorded head
  ];
  for (const [id, source, head, stale] of rows) {
    await pool.query(
      `INSERT INTO summary_rows VALUES ($1, 'Words.', NULL, $2, $3, 5, $4)`, [id, source, head, stale]);
  }
  await pool.query(
    `UPDATE summary_rows SET ${summaryFreshness.invalidateHeadMoveSql('$1')}`, [HEAD]);
  const { rows: after } = await pool.query(
    'SELECT id, pr_summary_stale, pr_summary_input_version, pr_summary_previous_md FROM summary_rows ORDER BY id');
  const byId = Object.fromEntries(after.map((r) => [r.id, r]));
  assert.equal(byId[1].pr_summary_stale, false, 'the author summary for this head stays fresh');
  assert.equal(Number(byId[1].pr_summary_input_version), 5);
  assert.equal(byId[1].pr_summary_previous_md, null);
  for (const id of [2, 3, 4, 5]) {
    assert.equal(byId[id].pr_summary_stale, true, `row ${id} is invalidated`);
    assert.equal(Number(byId[id].pr_summary_input_version), 6, `row ${id} moves its input version`);
    assert.equal(byId[id].pr_summary_previous_md, 'Words.', `row ${id} keeps the old words`);
  }
});

// Run four (13 Oct 2026): a fix round of the bot's (services/homeroom-commits.js)
// changes how a change works, never what it does, so its head move leaves
// every summary column as it was: fresh stays fresh, stale stays stale. Any
// other move, with the same SQL, invalidates as above.
test('a fix round\'s head move leaves the description as it stands', { timeout: 60000 }, async (t) => {
  const pool = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  t.after(() => pool.end());
  await pool.query(`CREATE TEMP TABLE fix_rows (
    id INT PRIMARY KEY,
    pr_summary_md TEXT,
    pr_summary_previous_md TEXT,
    pr_summary_source TEXT,
    pr_summary_source_head_sha VARCHAR(40),
    pr_summary_input_version BIGINT NOT NULL DEFAULT 0,
    pr_summary_stale BOOLEAN NOT NULL DEFAULT FALSE)`);
  const rows = [
    [1, 'generated', OTHER, false], // fresh, generated for an earlier head
    [2, 'author', OTHER, false], // fresh, the author's, for an earlier head
    [3, 'generated', OTHER, true], // already stale from an earlier change of what it does
  ];
  for (const [id, source, head, stale] of rows) {
    await pool.query(
      `INSERT INTO fix_rows VALUES ($1, 'Words.', 'Older words.', $2, $3, 5, $4)`, [id, source, head, stale]);
  }
  const move = (fix) => pool.query(
    `UPDATE fix_rows SET ${summaryFreshness.invalidateHeadMoveSql('$1', { fixParam: '$2' })}`, [HEAD, fix]);
  const read = async () => Object.fromEntries((await pool.query(
    'SELECT id, pr_summary_stale, pr_summary_input_version, pr_summary_previous_md FROM fix_rows ORDER BY id')).rows
    .map((r) => [r.id, { stale: r.pr_summary_stale, version: Number(r.pr_summary_input_version), previous: r.pr_summary_previous_md }]));

  await move(true);
  assert.deepEqual(await read(), {
    1: { stale: false, version: 5, previous: 'Older words.' },
    2: { stale: false, version: 5, previous: 'Older words.' },
    3: { stale: true, version: 5, previous: 'Older words.' },
  }, 'a fix round touches nothing');

  await move(false);
  const after = await read();
  for (const id of [1, 2, 3]) {
    assert.deepEqual(after[id], { stale: true, version: 6, previous: 'Words.' }, `row ${id}: any other move invalidates`);
  }
});
