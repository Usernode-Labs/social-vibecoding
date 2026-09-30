'use strict';

// The since-your-last-visit line's SQL against the full PostgreSQL schema
// (services/since-summary.js): the window query over merged changes, and
// the per-window cache row, including the rule that a failed rewrite
// keeps the line it could not replace with the head it was written for.
// The decisions around it are pinned in tests/since-summary.test.js.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const llm = require('../src/services/llm');
const since = require('../src/services/since-summary');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HOUR = 60 * 60 * 1000;

test('the since summary against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'since_summary_' + crypto.randomBytes(6).toString('hex');
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
    `INSERT INTO apps (name, slug) VALUES ('Homeroom', 'homeroom-test') RETURNING id, slug`);
  const { rows: [other] } = await pool.query(
    `INSERT INTO apps (name, slug) VALUES ('Other', 'other-test') RETURNING id, slug`);
  const now = Date.now();
  const merge = (appId, n, hoursAgo, status = 'merged') => pool.query(
    `INSERT INTO chat_sessions (app_id, status, pr_number, pr_title, pr_summary_md, merged_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [appId, status, 3000 + n, `Change ${n}`, `What change ${n} does.`, new Date(now - hoursAgo * HOUR)]);
  for (let n = 1; n <= 6; n++) await merge(app.id, n, n);
  await merge(app.id, 7, 72);            // before the window
  await merge(app.id, 8, 1, 'active');   // not merged
  await merge(other.id, 9, 1);           // another app

  await t.test('the window holds this app\'s merges since its start, newest first, with the total', async () => {
    const win = await since.fetchWindow(pool, app.id, now - 24 * HOUR);
    assert.equal(win.total, 6);
    assert.equal(win.truncated, false);
    assert.deepEqual(win.changes.map((c) => c.pr), [3001, 3002, 3003, 3004, 3005, 3006]);
    assert.equal(win.changes[0].summary, 'What change 1 does.');
    assert.ok(Math.abs(win.headAt - (now - HOUR)) < 1000);
  });

  const orig = { gen: llm.generateSinceSummary, enabled: llm.isEnabled };
  t.after(() => { llm.generateSinceSummary = orig.gen; llm.isEnabled = orig.enabled; });
  llm.isEnabled = () => true;
  let reply = 'Mostly polish across the app.';
  llm.generateSinceSummary = async () => {
    if (reply instanceof Error) throw reply;
    return { summary: reply, usage: undefined, model: 'claude-sonnet-5-5' };
  };
  const visit = now - 20 * HOUR;

  await t.test('a line is written once per window and read back', async () => {
    const out = await since.getSummary(pool, app, { since: visit, now });
    assert.equal(out.state, 'ai');
    assert.equal(out.text, 'Mostly polish across the app.');
    const { rows } = await pool.query('SELECT * FROM app_since_summaries WHERE app_id = $1', [app.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary, 'Mostly polish across the app.');
    assert.equal(rows[0].change_count, 6);
    assert.equal(rows[0].version, llm.SINCE_SUMMARY_VERSION);
    assert.equal(rows[0].error, null);
  });

  await t.test('a failed rewrite keeps the line and the head it was written for', async () => {
    await merge(app.id, 10, 0.5);
    await pool.query(`UPDATE app_since_summaries SET generated_at = NOW() - INTERVAL '2 hours' WHERE app_id = $1`, [app.id]);
    reply = new Error('boom');
    const out = await since.getSummary(pool, app, { since: visit, now });
    assert.equal(out.text, 'Mostly polish across the app.', 'the old line is served');
    await Promise.all([...since._inFlight.values()]);
    const { rows: [row] } = await pool.query('SELECT * FROM app_since_summaries WHERE app_id = $1', [app.id]);
    assert.equal(row.summary, 'Mostly polish across the app.');
    assert.equal(row.change_count, 6, 'not the new count');
    assert.equal(row.error, 'boom');
  });

  await t.test('a successful rewrite takes the new head and clears the error', async () => {
    await pool.query(`UPDATE app_since_summaries SET generated_at = NOW() - INTERVAL '2 hours' WHERE app_id = $1`, [app.id]);
    reply = 'A newer line.';
    await since.getSummary(pool, app, { since: visit, now: now + 2 * HOUR });
    await Promise.all([...since._inFlight.values()]);
    const { rows: [row] } = await pool.query('SELECT * FROM app_since_summaries WHERE app_id = $1', [app.id]);
    assert.equal(row.summary, 'A newer line.');
    assert.equal(row.change_count, 7);
    assert.equal(row.error, null);
  });

  await t.test('rows for windows nobody can ask for any more are dropped on write', async () => {
    await pool.query(
      `INSERT INTO app_since_summaries (app_id, window_start, head_at, change_count, summary)
       VALUES ($1, NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', 5, 'old')`, [app.id]);
    await pool.query(`UPDATE app_since_summaries SET generated_at = NOW() - INTERVAL '2 hours' WHERE app_id = $1`, [app.id]);
    await merge(app.id, 11, 0.2);
    reply = 'Newest line.';
    await since.getSummary(pool, app, { since: visit, now: now + 4 * HOUR });
    await Promise.all([...since._inFlight.values()]);
    const { rows } = await pool.query(
      `SELECT summary FROM app_since_summaries WHERE app_id = $1 ORDER BY window_start`, [app.id]);
    const kept = rows.map((r) => r.summary);
    assert.ok(!kept.includes('old'), 'the forty-day-old window is gone');
    assert.ok(kept.includes('Newest line.'), 'the window just written is there');
  });
});
