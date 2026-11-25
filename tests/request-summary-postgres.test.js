'use strict';

// Homeroom bot's summary of a request (src/services/request-summary.js) on a
// real database: the queries that gather what it is written from, the row
// it keeps in request_summaries, and one writer at a time. The model is a
// stub; tests/request-summary.test.js holds the rules against a fake pool.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const summary = require('../src/services/request-summary');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a request\'s summary is written from its visible changes, stored once, and written again when they move', async (t) => {
  const root = new Client({ connectionString: DSN });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const database = `request_summary_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(DSN); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('error', () => {});
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const owner = (await pool.query(`INSERT INTO users (username, password) VALUES ('summary-owner', 'x') RETURNING id`)).rows[0];
    const app = (await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by)
       VALUES ('Summary test', 'summary-test', 'running', 'public', $1) RETURNING id`,
      [owner.id]
    )).rows[0];
    const change = (title, status, issues, summaryMd = null) => pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_title, status, promoted_at, linked_issues, pr_summary_md)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7) RETURNING id`,
      [app.id, owner.id, `b-${crypto.randomBytes(4).toString('hex')}`, title, status, issues, summaryMd]
    );
    const issue = { title: 'Dark mode switch', body: 'Settings is three taps away.' };
    let calls = 0;
    const seen = [];
    const deps = { enabled: true, wait: true, generate: async ({ input }) => { calls += 1; seen.push(input); return { summary: `Summary ${calls}.`, model: 'stub-model' }; } };
    const ask = () => summary.forRequest(pool, { appId: app.id, number: 12, issue, asker: 'maya' }, deps);

    // Nothing but the request: no summary, no row, no call.
    assert.equal(await ask(), null);
    assert.equal(calls, 0);

    // A change still in its author's workspace, and one for another request, are not read.
    await change('Still private', 'active', [12], 'Not for the group yet.');
    await change('Another request', 'promoted', [13], 'Something else.');
    assert.deepEqual(await summary.visibleChanges(pool, app.id, 12), []);
    assert.equal(await ask(), null);

    // One change up for a vote: written once, stored, and reused.
    await change('A moon button beside the bell', 'promoted', [12], 'Adds a moon button to the header.');
    assert.deepEqual(await ask(), { text: 'Summary 1.', basis: 'change' });
    assert.deepEqual(await ask(), { text: 'Summary 1.', basis: 'change' });
    assert.equal(calls, 1);
    assert.match(seen[0], /by summary-owner: A moon button beside the bell\nAdds a moon button to the header\./);
    assert.doesNotMatch(seen[0], /Still private|Another request/);
    const row = (await pool.query('SELECT summary, basis, model, generating_until, failed_at FROM request_summaries WHERE app_id = $1 AND issue_number = 12', [app.id])).rows[0];
    assert.deepEqual({ ...row }, { summary: 'Summary 1.', basis: 'change', model: 'stub-model', generating_until: null, failed_at: null });

    // A second change: its basis and its words move.
    await change('In the account menu', 'promoted', [12], 'Puts the switch in the account menu.');
    assert.deepEqual(await ask(), { text: 'Summary 2.', basis: 'changes' });
    assert.match(seen[1], /CHANGE A \(up for a vote\)[\s\S]*CHANGE B \(up for a vote\)/);

    // A write that fails keeps the stored words and is not tried again at once.
    issue.body = 'Edited.';
    const failing = { enabled: true, wait: true, generate: async () => { throw new Error('model down'); } };
    assert.deepEqual(await summary.forRequest(pool, { appId: app.id, number: 12, issue, asker: 'maya' }, failing), { text: 'Summary 2.', basis: 'changes' });
    assert.deepEqual(await ask(), { text: 'Summary 2.', basis: 'changes' });
    assert.equal(calls, 2, 'held off after the failure');
    await pool.query(`UPDATE request_summaries SET failed_at = NOW() - interval '1 hour' WHERE app_id = $1`, [app.id]);
    assert.deepEqual(await ask(), { text: 'Summary 3.', basis: 'changes' });

    // The row goes with its project.
    await pool.query('DELETE FROM chat_sessions WHERE app_id = $1', [app.id]);
    await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM request_summaries')).rows[0].n, 0);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});

test('a change attached by its link, by the request it started from, or by its thread is read', async (t) => {
  const root = new Client({ connectionString: DSN });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const database = `request_summary_attach_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(DSN); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('error', () => {});
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const owner = (await pool.query(`INSERT INTO users (username, password) VALUES ('summary-owner', 'x') RETURNING id`)).rows[0];
    const app = (await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by)
       VALUES ('Attach test', 'attach-test', 'running', 'public', $1) RETURNING id`,
      [owner.id]
    )).rows[0];
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by) VALUES ($1, 12, 'Dark mode switch', 'Settings is three taps away.', $2)`,
      [app.id, owner.id]
    );
    const { thread_id: ownThread } = (await pool.query('SELECT thread_id FROM requests WHERE app_id = $1 AND number = 12', [app.id])).rows[0];
    assert.ok(ownThread, 'the request has a thread');
    const otherThread = (await pool.query(
      `INSERT INTO threads (app_id, number, kind) VALUES ($1, 99, 'work') RETURNING id`, [app.id]
    )).rows[0].id;
    const insert = (title, status, extra = {}) => pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_title, status, promoted_at, linked_issues, created_from_issue_number, thread_id)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8) RETURNING id`,
      [app.id, owner.id, `b-${crypto.randomBytes(4).toString('hex')}`, title, status,
        extra.issues || [], extra.from || null, extra.thread || null]
    );

    // Named by the request, started from it, or sitting on its thread.
    const byLink = (await insert('Linked', 'promoted', { issues: [12] })).rows[0].id;
    const byFrom = (await insert('Started from it', 'promoted', { from: 12 })).rows[0].id;
    const byThread = (await insert('On its thread', 'promoted', { thread: ownThread })).rows[0].id;
    // Not attached at all, and one still in somebody's workspace.
    await insert('Another request', 'promoted', { issues: [13] });
    const otherThreadChange = (await insert('Another thread', 'promoted', { thread: otherThread })).rows[0].id;
    await insert('Still private', 'active', { thread: ownThread });

    const ids = (await summary.visibleChanges(pool, app.id, 12)).map((c) => c.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [Number(byLink), Number(byFrom), Number(byThread)].sort((a, b) => a - b));
    assert.ok(!ids.includes(Number(otherThreadChange)));
  } finally {
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});

