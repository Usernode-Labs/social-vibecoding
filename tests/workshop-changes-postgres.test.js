'use strict';

// A Workshop pass owed (app_workshop_themes.reconcile_due_at,
// services/workshop-themes.js) against the full PostgreSQL schema: a board
// change owes one once the board has been quiet since its first change (by
// app id or by slug, a row made for an app never viewed), and the
// workshop-changes clock lists what is due and takes each off the row only
// as it was listed. It was a timer in each process that heard the
// change, lost to a restart. tests/workshop-themes.test.js runs the passes.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workshop-changes-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a Workshop pass owed is kept on the app\'s row', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'workshop_changes_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const llm = require('../src/services/llm');
  t.mock.method(llm, 'isEnabled', () => true);
  const themes = require('../src/services/workshop-themes');

  const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ws', 'x') RETURNING id`);
  const { rows: [a] } = await pool.query(`INSERT INTO apps (name, slug, created_by) VALUES ('Demo', 'demo', $1) RETURNING id`, [u.id]);
  const row = async () => (await pool.query('SELECT reconcile_due_at, reconcile_due_at::text AS due FROM app_workshop_themes WHERE app_id = $1', [a.id])).rows[0];

  assert.equal(await themes.noteBoardChange(pool, { appSlug: 'demo' }), true);
  const first = await row();
  assert.ok(first, 'a row made for an app never viewed, named by its slug');
  const dueIn = first.reconcile_due_at.getTime() - Date.now();
  assert.ok(dueIn > themes.CHANGE_DEBOUNCE_MS - 5000 && dueIn <= themes.CHANGE_DEBOUNCE_MS, `the quiet period: ${dueIn}`);
  await themes.noteBoardChange(pool, { appId: a.id });
  assert.equal((await row()).due, first.due, 'due from the first change');
  assert.deepEqual((await themes.changeTargets({ pool })).items, [], 'not before it is quiet');

  // Quiet now: listed.
  await pool.query(`UPDATE app_workshop_themes SET reconcile_due_at = NOW() - interval '1 second' WHERE app_id = $1`, [a.id]);
  const { items } = await themes.changeTargets({ pool });
  assert.deepEqual(items.map((i) => [i.target, i.input.appId]), [[`app:${a.id}`, a.id]]);

  // A change since it was listed stays owed; the one listed is taken.
  await pool.query(`UPDATE app_workshop_themes SET reconcile_due_at = NOW() WHERE app_id = $1`, [a.id]);
  assert.deepEqual(await themes.changeApp({ pool, ...items[0].input }), { skipped: 'not_owed' });
  assert.ok((await row()).reconcile_due_at, 'still owed');
  const [again] = (await themes.changeTargets({ pool })).items;
  const out = await themes.changeApp({ pool, ...again.input });
  assert.equal(out.skipped, 'empty', 'run (an empty board has nothing to place)');
  assert.equal((await row()).reconcile_due_at, null, 'taken off the row');
});
