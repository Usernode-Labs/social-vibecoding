'use strict';

// A staging preview listens before its workflow boot backfill, not after it
// (server.js backfillAfterListen, src/workflow/platform.ts startWorkflow's
// `backfillLater`). The backfill adopts what the preview's copied database
// holds and no machine does yet (some 80 proposals and a few governance
// rows, 1.2 to 1.5 s of every preview's start), and nothing a request does
// needs it first: these tests drive the requests that touch what it adopts
// before it has run, and the admin read that waits for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client, Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function handlerFor(router, method, route) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === route && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`no route ${method} ${route}`);
}

function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ get: () => undefined, params: {}, body: {}, query: {}, ...req }, res)).catch(reject);
  });
}

const settledWithin = (promise, ms) => Promise.race([
  promise.then(() => true, () => true),
  new Promise((resolve) => setTimeout(() => resolve(false), ms)),
]);

test('before the boot backfill, requests answer as after it, and the admin read waits for it', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'pv_boot_backfill_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const stub = (p, exports) => {
    const id = require.resolve(p);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', {
    ...realWs,
    pushIssueUpdate: () => {}, pushAppUpdate: () => {}, broadcast: () => {},
    sendSystemMessage: (p, appId, content, type, meta, thread) => p.query(
      'INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref) VALUES ($1, $2, $3, $4, $5, $6)',
      [appId, content, type, JSON.stringify(meta || {}), thread?.type, thread?.ref]),
  });
  const realGithub = require('../src/services/github');
  stub('../src/services/github', {
    ...realGithub,
    isEnabled: () => true,
    noteIssuesClosed: () => {}, invalidateIssuesCache: () => {},
  });
  const config = { databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 };
  const platform = require('../src/workflow/platform.ts');
  const vote = handlerFor(require('../src/routes/issues').issueRoutes(config), 'post', '/api/issues/:id/vote');
  const adminRouter = require('../src/routes/admin-workflow').adminWorkflowRoutes(config);
  const instances = handlerFor(adminRouter, 'get', '/api/admin/workflow/instances');
  const locker = new Client({ connectionString: String(url) });
  await locker.connect();
  t.after(async () => {
    await locker.query('ROLLBACK').catch(() => {});
    await locker.end();
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  let seq = 0;
  const user = async () => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [`backfill_${++seq}`])).rows[0];
  const author = await user();
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, approvals_required, repo_url)
     VALUES ('Copied', 'copied', $1, 2, 'https://github.com/acme/copied') RETURNING *`, [author.id]);
  // What a preview's copied database holds and no machine does: an open
  // governance row and a session holding a slot.
  const { rows: [issue] } = await pool.query(
    `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'rename', 'rename', $2, $3) RETURNING *`,
    [app.id, JSON.stringify({ newName: 'Renamed early' }), author.id]);
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'copied-branch', 'active') RETURNING id`,
    [app.id, author.id]);
  const held = async (machine, key) => (await pool.query(
    'SELECT state FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];

  await platform.startWorkflow(config, { loops: true, backfillLater: true });
  assert.equal(await held('governance-proposal', `issue:${issue.id}`), undefined, 'the governance row is not enrolled yet');
  assert.equal(await held('proposal', `session:${session.id}`), undefined, 'the session is not adopted yet');
  assert.equal(await platform.workflowBackfilled(0), true, 'no backfill runs here yet, so nothing waits');

  // A vote on the row nobody enrolled is decided at once, as it would be after.
  const voted = await call(vote, { params: { id: String(issue.id) }, body: { vote: 'up' }, user: await user() });
  assert.equal(voted.status, 200, JSON.stringify(voted.body));
  assert.equal(voted.body.renamed.upCount, 1);
  assert.equal((await held('governance-proposal', `issue:${issue.id}`)).state, 'open', 'the route enrolled it');

  // The backfill, held up on the sessions table, as a preview's first second
  // is: the admin's list waits for it rather than listing a part.
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE chat_sessions IN ACCESS EXCLUSIVE MODE');
  const loops = platform.startWorkflowLoops();
  let backfillEnded = false;
  loops.then(() => { backfillEnded = true; }, () => {});
  assert.equal(await platform.workflowBackfilled(150), false, 'the backfill is still under way');
  const listed = call(instances, { query: { machine: 'proposal' } });
  assert.equal(await settledWithin(listed, 300), false, 'the list waits while the backfill runs');
  await locker.query('ROLLBACK');
  const { status } = await listed;
  assert.equal(status, 200);
  assert.equal(backfillEnded, true, 'and answers once the backfill has ended');
  await loops;
  // What the backfill appended, the machines then apply, as they did when it
  // ran before the listener.
  const deadline = Date.now() + 5000;
  while (!(await held('proposal', `session:${session.id}`))) {
    assert.ok(Date.now() < deadline, 'the session is adopted');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await platform.workflowBackfilled(0), true, 'and nothing waits once it has ended');
  // The governance row the route enrolled stays as the route left it.
  assert.equal((await held('governance-proposal', `issue:${issue.id}`)).state, 'open');
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM issue_votes WHERE issue_id = $1', [issue.id]);
  assert.equal(n, 1, 'the early vote counted once');
});

test('workflowBackfilled answers at once where no backfill runs', async () => {
  const platform = require('../src/workflow/platform.ts');
  // No runtime in this process (or a stopped one): nothing to wait for.
  assert.equal(await platform.workflowBackfilled(10_000), true);
});
