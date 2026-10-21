'use strict';

// The plain-words explanation's SQL against the full PostgreSQL schema
// (services/checks-explanation.js): one row per change and language, a new
// run overwriting it, a failed attempt kept beside its run, and an earlier
// run's write never overwriting a later one's. The decisions around it are
// pinned in tests/checks-explanation.test.js.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const llm = require('../src/services/llm');
const explainer = require('../src/services/checks-explanation');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the checks explanation against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'checks_explanation_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug) VALUES ('Homeroom', 'homeroom-test') RETURNING id`);
  const results = JSON.stringify([{ name: 'Home loads', path: '/', status: 'fail', failureReason: 'Expected #home' }]);
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, status, check_state, checks_checked_at, test_results)
     VALUES ($1, 'promoted', 'failing', $2, $3::jsonb)
     RETURNING id, app_id, check_state, checks_checked_at, test_results`,
    [app.id, '2026-10-21T11:00:00Z', results]);

  const orig = { gen: llm.generateChecksExplanation, enabled: llm.isEnabled };
  t.after(() => { llm.generateChecksExplanation = orig.gen; llm.isEnabled = orig.enabled; });
  llm.isEnabled = () => true;
  let reply = 'The home page is missing.';
  let calls = 0;
  llm.generateChecksExplanation = async () => {
    calls += 1;
    if (reply instanceof Error) throw reply;
    return { explanation: reply, usage: undefined, model: 'z-ai/glm-5.3-flash' };
  };
  const row = async (language = 'en') => (await pool.query(
    'SELECT run_at, explanation, model, failed_at FROM check_explanations WHERE session_id = $1 AND language = $2',
    [session.id, language])).rows[0];

  await t.test('written for the run, then read back without a call', async () => {
    assert.equal(await explainer.explain(pool, session), 'The home page is missing.');
    const kept = await row();
    assert.equal(kept.run_at.toISOString(), '2026-10-21T11:00:00.000Z');
    assert.equal(kept.model, 'z-ai/glm-5.3-flash');
    assert.equal(kept.failed_at, null);
    assert.equal(await explainer.explain(pool, session), 'The home page is missing.');
    assert.equal(calls, 1);
  });

  await t.test('each language is its own row', async () => {
    reply = 'Falta la página de inicio.';
    assert.equal(await explainer.explain(pool, session, { language: 'es' }), 'Falta la página de inicio.');
    assert.equal((await row('es')).explanation, 'Falta la página de inicio.');
    assert.equal((await row('en')).explanation, 'The home page is missing.');
  });

  await t.test('a new run overwrites the row; a failed attempt is kept beside its run', async () => {
    reply = new Error('provider down');
    const later = { ...session, checks_checked_at: new Date('2026-10-21T12:00:00Z') };
    assert.equal(await explainer.explain(pool, later), null);
    const kept = await row();
    assert.equal(kept.run_at.toISOString(), '2026-10-21T12:00:00.000Z');
    assert.equal(kept.explanation, null);
    assert.ok(kept.failed_at instanceof Date);
  });

  await t.test('an earlier run never overwrites a later one\'s row', async () => {
    reply = 'Stale.';
    const before = calls;
    assert.equal(await explainer.explain(pool, session), null, 'the earlier run is not asked about');
    assert.equal(calls, before);
    await pool.query(
      `INSERT INTO check_explanations (session_id, language, run_at, explanation)
       VALUES ($1, 'en', $2, 'From the earlier run')
       ON CONFLICT (session_id, language) DO UPDATE SET run_at = EXCLUDED.run_at, explanation = EXCLUDED.explanation
       WHERE check_explanations.run_at <= EXCLUDED.run_at`,
      [session.id, '2026-10-21T11:00:00Z']);
    assert.equal((await row()).run_at.toISOString(), '2026-10-21T12:00:00.000Z');
  });

  await t.test('two readers on two processes make one call; a claim whose call died lapses', async () => {
    const other = new Pool({ connectionString: String(url), max: 2 });
    const run = { ...session, checks_checked_at: new Date('2026-10-21T13:00:00Z') };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const before = calls;
    reply = 'Once.';
    const slow = llm.generateChecksExplanation;
    llm.generateChecksExplanation = async (args) => { await gate; return slow(args); };
    const a = explainer.explain(pool, run);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = explainer.explain(other, run, { waitMs: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    assert.deepEqual(await Promise.all([a, b]), ['Once.', 'Once.']);
    await other.end();
    assert.equal(calls - before, 1, 'one call');
    llm.generateChecksExplanation = slow;
    // A call whose process died holds the row until its lease lapses.
    const next = { ...session, checks_checked_at: new Date('2026-10-21T14:00:00Z') };
    await pool.query(`UPDATE check_explanations SET run_at = $2, explanation = NULL, generating_until = NOW() + interval '1 minute'
      WHERE session_id = $1 AND language = 'en'`, [session.id, next.checks_checked_at]);
    assert.equal(await explainer.explain(pool, next, { waitMs: 0 }), null, 'held: no second call');
    assert.equal(calls - before, 1);
    await pool.query(`UPDATE check_explanations SET generating_until = NOW() - interval '1 second' WHERE session_id = $1`, [session.id]);
    assert.equal(await explainer.explain(pool, next), 'Once.', 'lapsed: called again');
    assert.equal((await row()).run_at.toISOString(), '2026-10-21T14:00:00.000Z');
  });

  await t.test('deleting the change deletes its rows', async () => {
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [session.id]);
    const { rows } = await pool.query('SELECT 1 FROM check_explanations WHERE session_id = $1', [session.id]);
    assert.equal(rows.length, 0);
  });
});
