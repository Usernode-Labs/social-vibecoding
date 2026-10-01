'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The version predicate and the author/lifecycle gate run against PostgreSQL,
// including two simultaneous browser/connector saves of the same version.
test('description API on PostgreSQL', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const { Pool } = require('pg');
  const schema = `description_edit_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 2000, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 2000, max: 6, options: `-c search_path=${schema}` });
  const poolModule = require('../src/db/pool'); const previousPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  const ws = require('../src/services/ws'); const previousPush = ws.pushSessionUpdate;
  ws.pushSessionUpdate = () => {};
  let server;
  try {
    await pool.query(`CREATE TABLE apps (id INT PRIMARY KEY, slug TEXT, repo_url TEXT,
      collab_visibility TEXT DEFAULT 'public', view_visibility TEXT DEFAULT 'public', moderation_suspended_at TIMESTAMPTZ);
      CREATE TABLE user_app_blocks (user_id INT, app_id INT);
      CREATE TABLE chat_sessions (id INT PRIMARY KEY, app_id INT, user_id INT,
      status TEXT DEFAULT 'paused', source TEXT DEFAULT 'cli_handoff', is_headless BOOLEAN DEFAULT FALSE,
      pr_number INT, pr_body TEXT, pr_summary_md TEXT, pr_summary_previous_md TEXT,
      pr_summary_source TEXT, pr_summary_stale BOOLEAN DEFAULT TRUE,
      pr_summary_input_version BIGINT DEFAULT 0, pr_summary_applied_version BIGINT DEFAULT 0,
      pr_summary_source_body_hash TEXT, pr_summary_source_head_sha VARCHAR(40),
      imported_pr_head_sha VARCHAR(40), handoff_uploaded_sha VARCHAR(40), reviewed_head_sha VARCHAR(40),
      handoff_head_sha VARCHAR(40), checks_commit_sha VARCHAR(40), check_state TEXT DEFAULT 'passing',
      linked_issues INT[] DEFAULT '{3587}', branch_name TEXT DEFAULT 'dev/existing', yes_count INT DEFAULT 3);
      INSERT INTO apps (id,slug,repo_url) VALUES (1,'demo','https://github.com/Acme/Demo');
      INSERT INTO chat_sessions (id,app_id,user_id,pr_summary_md,handoff_head_sha)
      VALUES (42,1,7,'Old description','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');`);
    const express = require('express'); const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 7), username: 'author' }; next(); });
    app.use(require('../src/routes/sessions').sessionRoutes({}));
    server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/sessions/42/description`;
    const request = async (method, body, user = 7) => {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };

    await t.test('read carries the saved Markdown, version and size limit', async () => {
      const result = await request('GET');
      assert.equal(result.status, 200); assert.equal(result.body.description, 'Old description');
      assert.equal(result.body.version, 0); assert.equal(result.body.maxLength, 16000);
    });
    await t.test('two simultaneous saves cannot overwrite one another', async () => {
      const before = (await pool.query('SELECT * FROM chat_sessions WHERE id=42')).rows[0];
      const result = await Promise.all(['First draft', 'Second draft'].map((description) => request('PATCH', { description, expectedVersion: 0 })));
      assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
      const saved = (await pool.query('SELECT * FROM chat_sessions WHERE id=42')).rows[0];
      assert.equal(saved.pr_summary_input_version, '1');
      assert.equal(saved.pr_summary_source, 'author'); assert.equal(saved.pr_summary_stale, false);
      assert.equal(saved.pr_summary_source_head_sha, before.handoff_head_sha);
      for (const key of ['status','branch_name','check_state','checks_commit_sha','handoff_head_sha','linked_issues','yes_count']) assert.deepEqual(saved[key], before[key], key);
      const retry = await request('PATCH', { description: saved.pr_summary_md, expectedVersion: 0 });
      assert.equal(retry.status, 200); assert.equal(retry.body.version, 1); assert.equal(retry.body.changed, false);
    });
    await t.test('a code revision invalidation requires another read', async () => {
      await pool.query('UPDATE chat_sessions SET pr_summary_input_version=pr_summary_input_version+1, pr_summary_stale=TRUE WHERE id=42');
      assert.equal((await request('PATCH', { description: 'Older draft', expectedVersion: 1 })).status, 409);
    });
    await t.test('foreign users, headless work and closed work are denied on both methods', async () => {
      for (const method of ['GET', 'PATCH']) assert.equal((await request(method, method === 'PATCH' ? { description: 'Foreign', expectedVersion: 2 } : undefined, 8)).status, 404);
      for (const update of ["status='merged'", "status='archived'", "status='paused', is_headless=TRUE"]) {
        await pool.query(`UPDATE chat_sessions SET ${update} WHERE id=42`);
        assert.equal((await request('GET')).status, 404);
        assert.equal((await request('PATCH', { description: 'Closed', expectedVersion: 2 })).status, 404);
      }
      await pool.query("UPDATE chat_sessions SET status='paused', is_headless=FALSE WHERE id=42");
    });
    await t.test('malformed updates are rejected without touching the row', async () => {
      for (const body of [{ description: '' }, { description: 'x'.repeat(16001), expectedVersion: 2 },
        { description: 'Fine', expectedVersion: 2, status: 'promoted' }]) assert.equal((await request('PATCH', body)).status, 400);
      assert.equal((await request('GET')).body.version, 2);
    });
    await t.test('the full Markdown survives saving and reading without truncation', async () => {
      const description = '### Problems found\n\n' + 'Clear explanation. '.repeat(600);
      assert.equal((await request('PATCH', { description, expectedVersion: 2 })).status, 200);
      assert.equal((await request('GET')).body.description, description.trim());
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    poolModule.getPool = previousPool; ws.pushSessionUpdate = previousPush;
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
