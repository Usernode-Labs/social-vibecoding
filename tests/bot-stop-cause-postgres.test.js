'use strict';

// Review B4 (19 Nov 2026): why a build stopped is a stored code
// (homeroom_bot_runs.build_stop) beside its English (build_error), and its
// readers read the code. The English is read in two places only, by the same
// rules: the SQL function that fills the code once for older rows and for a
// writer that still sends only English (homeroom_bot_build_stop, with its
// trigger), and bot-stop-cause.js stopOfText for a reason that was never
// stored. This holds the two equal over every English the platform writes,
// and the trigger and the backfill to what they promise.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/bot-stop-cause-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const stop = require('../src/services/bot-stop-cause');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// What the platform writes into build_error (homeroom-bot.js, -live.js, -dm.js), and older rows' words.
const TEXTS = [
  'stopped: by @ada', 'stopped: by its requester', 'credit_wait',
  'the build ran past its time limit; last activity: running the tests',
  'the spec ran past its time limit',
  'no plan could be written (the spec ran past its time limit)',
  'no plan could be written (unknown)',
  'the spec turn\'s final message was only part of a spec (no "# " title, no <article data-spec> and neither half\'s "##" heading), so it was not kept',
  'could not open a session: boom', 'could not create its branch: refused', 'the worker would not start: oom',
  'the build could not start (its project could not be set up)',
  'the change was built but could not be proposed: its project was still being set up',
  'couldn\'t push the build\'s commit (non_fast_forward, permanent)',
  'couldn\'t push the build\'s commit (rate_limited, gave up after 6 hours)',
  'couldn\'t push the build\'s commit',
  'waiting to push: couldn\'t push the build\'s commit (rate_limited, temporary)',
  'the build produced no change to propose',
  'skipped: the request was closed before its build started', 'skipped: its requester asked to change the plan',
  'superseded: a later verdict on the same issue', 'blocked: it needs a payment provider first',
  'the platform restarted while it was building, and the build was lost',
  'lost: the platform restarted while it was building, and the build was lost',
  'by a restart; the issue was sent back to be triaged again',
  'the platform restarted in the middle of each of its last 3 tries',
  'the build turn failed (provider_error)',
  'the build turn failed (stalled) (finished after a restart)',
  'the build turn failed (stalled); it last said: the server would not start',
];

test('a stored code is read as it is; a row without one reads its English', () => {
  assert.deepEqual(stop.stopOf({ build_stop: { cause: 'stopped', by: 'ada' }, build_error: 'reworded entirely' }), { cause: 'stopped', by: 'ada' });
  assert.deepEqual(stop.stopOf({ build_stop: '{"cause":"no_start"}' }), { cause: 'no_start' }, 'as JSON text too');
  assert.deepEqual(stop.stopOf({ build_stop: null, build_error: 'skipped: answered' }), { cause: 'skipped' });
  assert.equal(stop.stopOf({}), null);
  // What a build that did not finish says, from the code: a run waiting for
  // its upload is a push retried; a skip, a supersede or a block is no cause.
  assert.deepEqual(stop.buildCauseOf({ build_stop: { cause: 'waiting_push' } }), { cause: 'push' });
  for (const cause of stop.DISPOSITIONS.filter((c) => c !== 'waiting_push')) {
    assert.deepEqual(stop.buildCauseOf({ build_stop: { cause } }), { cause: 'other' }, cause);
  }
  assert.deepEqual(stop.buildCauseOf({ build_stop: { cause: 'no_change' }, no_change_said: 'x' }, { noChangeSaid: 'It already works that way.' }),
    { cause: 'no_change', noChange: 'already' });
  assert.deepEqual(stop.buildCauseOf({ build_stop: { cause: 'time' } }, { credit: true }), { cause: 'credit' });
  // Over the English, the stored code says what the English always said.
  for (const text of TEXTS) {
    assert.deepEqual(stop.buildCauseOf({ build_error: text }), stop.buildCause(text), text);
  }
  // A plan that could not be written is so whatever stopped it.
  assert.equal(stop.stopOfText('no plan could be written (the spec ran past its time limit)').plan, true);
  assert.equal(stop.stopOfText('the spec ran past its time limit').plan, undefined);
  assert.equal(require('../src/services/homeroom-bot-progress').planFailed({ build_ok: false, build_stop: { cause: 'time', plan: true } }), true);
  assert.equal(require('../src/services/homeroom-bot-progress').planFailed({ build_ok: false, build_stop: { cause: 'time' } }), false);
});

test('the stop cause against the full PostgreSQL schema: one reading of the English, a trigger and a backfill', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `stop_cause_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 3 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  await t.test('the SQL reading and stopOfText agree over every English the platform writes', async () => {
    for (const text of [...TEXTS, '', null]) {
      const { rows: [r] } = await pool.query('SELECT homeroom_bot_build_stop($1) AS s', [text]);
      assert.deepEqual(r.s, stop.stopOfText(text), String(text));
    }
  });

  const { rows: [owner] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('stop_ada', 'x') RETURNING id`);
  const { rows: [a] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Stops', 'stops', 'running', $1) RETURNING id`, [owner.id]);
  const run = async (fields) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error, build_stop)
     VALUES ($1, 1, 'live', 'ready', $2, $3, $4::jsonb) RETURNING id, build_stop`,
    [a.id, fields.ok ?? false, fields.error ?? null, fields.stop ? JSON.stringify(fields.stop) : null])).rows[0];
  const stopOfRow = async (id) => (await pool.query('SELECT build_stop FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0].build_stop;

  await t.test('a writer that sends only English gets the code; one that says it keeps it', async () => {
    const english = await run({ error: 'the build ran past its time limit' });
    assert.deepEqual(english.build_stop, { cause: 'time' }, 'an older Pod\'s write still decodes');
    const said = await run({ error: 'some wording nobody decodes', stop: { cause: 'no_start' } });
    assert.deepEqual(said.build_stop, { cause: 'no_start' }, 'the writer\'s code stands, whatever its English');
    // Its English changes, its code not said: read again.
    await pool.query(`UPDATE homeroom_bot_runs SET build_error = 'skipped: answered' WHERE id = $1`, [english.id]);
    assert.deepEqual(await stopOfRow(english.id), { cause: 'skipped' });
    // Both said: the code stands.
    await pool.query(`UPDATE homeroom_bot_runs SET build_error = 'reworded', build_stop = '{"cause":"push_gave_up"}' WHERE id = $1`, [english.id]);
    assert.deepEqual(await stopOfRow(english.id), { cause: 'push_gave_up' });
    // Cleared: no code.
    await pool.query('UPDATE homeroom_bot_runs SET build_error = NULL WHERE id = $1', [said.id]);
    assert.equal(await stopOfRow(said.id), null);
    // A write that touches neither leaves it.
    await pool.query(`UPDATE homeroom_bot_runs SET build_finish = '{}'::jsonb WHERE id = $1`, [english.id]);
    assert.deepEqual(await stopOfRow(english.id), { cause: 'push_gave_up' });
  });

  await t.test('the backfill reads what was written before, once', async () => {
    const before = await run({ error: 'stopped: by @ada' });
    // As a row written before the column: English, no code.
    await pool.query('ALTER TABLE homeroom_bot_runs DISABLE TRIGGER homeroom_bot_runs_build_stop');
    await pool.query('UPDATE homeroom_bot_runs SET build_stop = NULL WHERE id = $1', [before.id]);
    await pool.query('ALTER TABLE homeroom_bot_runs ENABLE TRIGGER homeroom_bot_runs_build_stop');
    assert.equal(await stopOfRow(before.id), null);
    const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/homeroom-bot-run-stop-cause.sql'), 'utf8');
    const backfill = sql.slice(sql.lastIndexOf('UPDATE homeroom_bot_runs SET build_stop'));
    const first = await pool.query(backfill);
    assert.ok(first.rowCount >= 1);
    assert.deepEqual(await stopOfRow(before.id), { cause: 'stopped', by: 'ada' });
    assert.equal((await pool.query(backfill)).rowCount, 0, 'again: nothing left to read');
    // And the whole migration runs again over itself.
    await pool.query(sql);
  });

  await t.test('the bot\'s queries read the code: a run waiting for its upload, and a project\'s skipped builds', async () => {
    const waiting = await run({ ok: null, error: 'waiting to push: couldn\'t push the build\'s commit (rate_limited, temporary)' });
    const { rows } = await pool.query(`SELECT id FROM homeroom_bot_runs WHERE build_stop->>'cause' = 'waiting_push'`);
    assert.deepEqual(rows.map((r) => r.id), [waiting.id]);
  });
});
