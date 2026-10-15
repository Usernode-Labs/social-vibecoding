'use strict';

// Work-order patch uploads (#4264) against a real PostgreSQL: the SQL in
// services/external-agent-patch-upload.js, the route that stores an upload
// (with the connector's own shared rate limiter), and submit_work naming the
// upload, end to end.
//
// The external-agent work-order blocks of src/db/schema.sql, the new one
// included, are lifted out and run as written (twice, since schema.sql runs
// on every boot), in a scratch schema beside the few tables they reference.
// Only the GitHub side is stubbed: applyPatch, which is pinned with real git
// in external-agent-patch-upload.test.js.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `patch_upload_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PATCH = [
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # Recipe box',
  '+Recipes can carry tags now.',
  '',
].join('\n');

/** The external-agent work-order blocks of schema.sql, the uploads included, as they ship. */
function workOrderBlocks() {
  const start = SCHEMA_SQL.indexOf('-- ── External-agent work orders');
  assert.ok(start > 0, 'the work-order block must be findable in schema.sql');
  const uploads = SCHEMA_SQL.indexOf('-- ── External-agent patch uploads (#4264)', start);
  assert.ok(uploads > start, 'and the uploads block after it');
  const end = SCHEMA_SQL.indexOf('\n-- ── ', uploads + 10);
  assert.ok(end > uploads, 'which ends at the next block');
  return SCHEMA_SQL.slice(start, end);
}

/** The shared limiter's table, as it ships. */
function rateLimitTable() {
  const m = /CREATE TABLE IF NOT EXISTS cli_auth_rate_limits \([\s\S]*?\n\);/.exec(SCHEMA_SQL);
  assert.ok(m, 'the limiter table must be findable in schema.sql');
  return m[0];
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE apps (id SERIAL PRIMARY KEY, slug TEXT NOT NULL, name TEXT, repo_url TEXT);
    CREATE TABLE chat_sessions (id SERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active');
  `);
  // Twice: schema.sql is applied on every boot.
  await pool.query(workOrderBlocks());
  await pool.query(workOrderBlocks());
  await pool.query(rateLimitTable());
  await pool.query(`
    INSERT INTO users (id, username) VALUES (3, 'ada'), (4, 'bo');
    INSERT INTO apps (id, slug, name, repo_url)
      VALUES (7, 'recipe-box', 'Recipe Box', 'https://github.com/usernode-bot/recipe-box');
    INSERT INTO chat_sessions (id, status) VALUES (900, 'promoted');
  `);
  return { pool };
}

async function dropSchema(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

async function newTask(pool, { userId = 3, key, target = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO external_agent_tasks
       (user_id, app_id, issue_number, fork_owner, fork_repo, branch_name, base_sha, brief,
        request_key, target_session_id, linked_issues)
     VALUES ($1, 7, 4, 'someuser', 'recipe-box', $2, $3, 'Add tags', $2, $4, '{4}')
     RETURNING id`,
    [userId, key, BASE_SHA, target]
  );
  return Number(rows[0].id);
}

test('work-order patch uploads against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool } = setup;
  const uploads = require('../src/services/external-agent-patch-upload');
  const svc = require('../src/services/external-agent-tasks');
  const patchSvc = require('../src/services/external-agent-patch');
  const logger = require('../src/services/logger');
  const { externalAgentPatchUploadRoutes } = require('../src/routes/external-agent-patch-upload');

  // Every argument any logger method sees, before redaction.
  const logged = [];
  const realLog = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    realLog[level] = logger[level];
    logger[level] = (...args) => { logged.push(JSON.stringify(args)); return realLog[level](...args); };
  }

  // The real router, the real pool, the real shared limiter.
  const app = express();
  app.use(externalAgentPatchUploadRoutes({}, { pool }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (taskId, token, body) => fetch(`${base}/api/external-tasks/${taskId}/patch`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const issue = (taskId, userId = 3) => uploads.issueUploadCredential(pool, {
    taskId, userId, origin: 'https://homeroom.example',
  });
  const tokens = [];

  try {
    await t.test('the credential is stored as a hash, bound to its task, and lapses within a day', async () => {
      const taskId = await newTask(pool, { key: 'brief:one' });
      const issued = await issue(taskId);
      tokens.push(issued.token);
      assert.equal(issued.url, `https://homeroom.example/api/external-tasks/${taskId}/patch`);
      const { rows } = await pool.query(
        `SELECT token_hash, EXTRACT(EPOCH FROM expires_at - created_at)::int AS ttl
           FROM external_agent_upload_tokens WHERE task_id = $1`,
        [taskId]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_hash, uploads.hashToken(issued.token));
      assert.equal(rows[0].ttl, 24 * 3600);
      const raw = await pool.query(`SELECT * FROM external_agent_upload_tokens`);
      assert.ok(!JSON.stringify(raw.rows).includes(issued.token), 'the token itself is stored nowhere');

      // Not for somebody else's task, an update's, or a closed one.
      assert.equal(await issue(taskId, 4), null);
      const update = await newTask(pool, { key: 'proposal:900', target: 900 });
      assert.equal(await issue(update), null);
      const closed = await newTask(pool, { key: 'brief:closed' });
      await pool.query(`UPDATE external_agent_tasks SET status = 'abandoned' WHERE id = $1`, [closed]);
      assert.equal(await issue(closed), null);

      // Rendering again mints another, and at most five stay live.
      for (let n = 0; n < 6; n += 1) tokens.push((await issue(taskId)).token);
      const live = await pool.query(`SELECT count(*)::int AS n FROM external_agent_upload_tokens WHERE task_id = $1`, [taskId]);
      assert.equal(live.rows[0].n, uploads.MAX_LIVE_TOKENS_PER_TASK);
      const oldest = await put(taskId, tokens[0], PATCH);
      assert.equal(oldest.status, 401, 'the oldest was retired');
    });

    await t.test('an upload stores the exact bytes; another task\'s token, an expired one and a closed task are refused', async () => {
      const taskId = await newTask(pool, { key: 'brief:two' });
      const other = await newTask(pool, { key: 'brief:three' });
      const mine = await issue(taskId);
      const theirs = await issue(other);

      const body = Buffer.concat([Buffer.from(PATCH), Buffer.from([0xe9, 0x0a])]);
      const res = await put(taskId, mine.token, body);
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.taskId, taskId);
      const stored = await pool.query(`SELECT * FROM external_agent_patch_uploads WHERE id = $1`, [json.uploadId]);
      assert.ok(stored.rows[0].patch.equals(body), 'byte for byte');
      assert.equal(stored.rows[0].sha256, crypto.createHash('sha256').update(body).digest('hex'));
      assert.equal(Number(stored.rows[0].task_id), taskId);

      // Each token works for its own task and no other.
      assert.equal((await put(other, mine.token, PATCH)).status, 401);
      assert.equal((await put(taskId, theirs.token, PATCH)).status, 401);

      // A second upload replaces the first under a new id.
      const again = await (await put(taskId, mine.token, PATCH)).json();
      assert.notEqual(again.uploadId, json.uploadId);
      const count = await pool.query(`SELECT count(*)::int AS n FROM external_agent_patch_uploads WHERE task_id = $1`, [taskId]);
      assert.equal(count.rows[0].n, 1);

      // Oversize: refused, and the stored upload is untouched.
      const big = Buffer.alloc(uploads.MAX_UPLOADED_PATCH_BYTES + 1, 0x61);
      assert.equal((await put(taskId, mine.token, big)).status, 413);
      const kept = await pool.query(`SELECT id FROM external_agent_patch_uploads WHERE task_id = $1`, [taskId]);
      assert.equal(Number(kept.rows[0].id), again.uploadId);

      await pool.query(`UPDATE external_agent_upload_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE task_id = $1`, [other]);
      const expired = await put(other, theirs.token, PATCH);
      assert.equal(expired.status, 401);
      assert.equal((await expired.json()).error, 'upload_token_expired');

      await pool.query(`UPDATE external_agent_tasks SET status = 'submitted' WHERE id = $1`, [other]);
      assert.equal((await put(other, theirs.token, PATCH)).status, 409);
      tokens.push(mine.token, theirs.token);
    });

    await t.test('the shared limiter bounds uploads per task', async () => {
      const taskId = await newTask(pool, { key: 'brief:limit' });
      const { token } = await issue(taskId);
      tokens.push(token);
      const statuses = [];
      for (let n = 0; n < 11; n += 1) statuses.push((await put(taskId, token, PATCH)).status);
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
      assert.equal(statuses[10], 429);
    });

    await t.test('submit_work with the upload id applies it like an inline patch, then the upload is gone', async () => {
      const taskId = await newTask(pool, { key: 'brief:submit' });
      const { token } = await issue(taskId);
      tokens.push(token);
      const body = Buffer.from(PATCH);
      const { uploadId } = await (await put(taskId, token, body)).json();

      const realApply = patchSvc.applyPatch;
      const applied = [];
      patchSvc.applyPatch = async (args) => {
        applied.push(args);
        return { ok: true, branch: `usernode/patch-u3-t${taskId}-x`, headSha: 'f'.repeat(40), cleanup: async () => {} };
      };
      const deps = {
        pool,
        config: {},
        gh: {
          isEnabled: () => true,
          parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }),
          createPR: async () => ({ number: 88, html_url: 'https://github.com/usernode-bot/recipe-box/pull/88', head: { sha: 'f'.repeat(40) } }),
          compareCommitAncestry: async () => ({ status: 'ahead' }),
        },
        githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'someuser' }) },
        limits: { checkPromotedCap: async () => null },
      };
      const importProposal = async () => ({ ok: true, body: { sessionId: 900 } });
      try {
        // Another user cannot name it, and neither can another task.
        const otherTask = await newTask(pool, { key: 'brief:submit-other' });
        const wrongTask = await svc.submitWork(deps, { user: { id: 3 }, taskId: otherTask, patchUploadId: uploadId, importProposal });
        assert.equal(wrongTask.code, 'patch_upload_wrong_task');
        const bo = await newTask(pool, { userId: 4, key: 'brief:bo' });
        const notTheirs = await svc.submitWork(deps, { user: { id: 4 }, taskId: bo, patchUploadId: uploadId, importProposal });
        assert.equal(notTheirs.code, 'patch_upload_not_found');
        assert.equal(applied.length, 0);

        const result = await svc.submitWork(deps, { user: { id: 3 }, taskId, patchUploadId: uploadId, importProposal });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.prNumber, 88);
        assert.equal(applied.length, 1);
        assert.ok(applied[0].patch.equals(body));
        assert.equal(applied[0].baseSha, BASE_SHA);

        const task = await pool.query(`SELECT status, submitted_via FROM external_agent_tasks WHERE id = $1`, [taskId]);
        assert.deepEqual(task.rows[0], { status: 'submitted', submitted_via: 'patch' });
        const left = await pool.query(
          `SELECT (SELECT count(*) FROM external_agent_patch_uploads WHERE task_id = $1)::int AS uploads,
                  (SELECT count(*) FROM external_agent_upload_tokens WHERE task_id = $1)::int AS tokens`,
          [taskId]
        );
        assert.deepEqual(left.rows[0], { uploads: 0, tokens: 0 });
        assert.equal((await put(taskId, token, PATCH)).status, 401, 'the command is dead once submitted');

        // Asked again, it is the ordinary "already submitted" answer.
        const twice = await svc.submitWork(deps, { user: { id: 3 }, taskId, patchUploadId: uploadId, importProposal });
        assert.equal(twice.code, 'already_submitted');
      } finally {
        patchSvc.applyPatch = realApply;
      }
    });

    await t.test('the sweep drops uploads of closed tasks and long-expired credentials', async () => {
      const taskId = await newTask(pool, { key: 'brief:sweep' });
      const { token } = await issue(taskId);
      tokens.push(token);
      assert.equal((await put(taskId, token, PATCH)).status, 201);
      await pool.query(`UPDATE external_agent_tasks SET status = 'abandoned' WHERE id = $1`, [taskId]);
      await pool.query(`UPDATE external_agent_upload_tokens SET expires_at = NOW() - INTERVAL '2 days' WHERE task_id = $1`, [taskId]);
      await uploads.sweep(pool);
      const left = await pool.query(
        `SELECT (SELECT count(*) FROM external_agent_patch_uploads WHERE task_id = $1)::int AS uploads,
                (SELECT count(*) FROM external_agent_upload_tokens WHERE task_id = $1)::int AS tokens`,
        [taskId]
      );
      assert.deepEqual(left.rows[0], { uploads: 0, tokens: 0 });
    });

    await t.test('no token reached a log call', () => {
      assert.ok(tokens.length > 5);
      for (const line of logged) {
        for (const token of tokens) assert.ok(!line.includes(token), `a token reached a log call: ${line}`);
      }
    });
  } finally {
    Object.assign(logger, realLog);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    await dropSchema(pool);
  }
});
