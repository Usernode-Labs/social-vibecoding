'use strict';

// The governance routes with WF_GOVERNANCE_ENABLED on (src/routes/issues.js
// handing off to src/workflow/platform.ts), against the full PostgreSQL
// schema and a running workflow runtime: the vote, withdraw and admin-apply
// routes answer with the shapes the client reads, the create route and the
// boot backfill enroll proposals, and a merged PR's `Closes #N` supersedes a
// close proposal through the machine. Handlers are driven off the router
// stack, like the sibling route suites; GitHub and WS pushes are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function handlerFor(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`no route ${method} ${path}`);
}

async function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ get: () => undefined, params: {}, body: {}, query: {}, ...req }, res)).catch(reject);
  });
}

test('governance routes through the workflow machine', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_gov_routes_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  // Stubs: the request pool is the test pool; WS pushes and GitHub record.
  const pushes = [];
  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', {
    ...realWs,
    pushIssueUpdate: (d) => pushes.push(['issue', d]),
    pushAppUpdate: (d) => pushes.push(['app', d]),
    broadcast: () => {},
    sendSystemMessage: (p, appId, content, type, meta, thread) => p.query(
      'INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref) VALUES ($1, $2, $3, $4, $5, $6)',
      [appId, content, type, JSON.stringify(meta || {}), thread?.type, thread?.ref]),
  });
  const realGithub = require('../src/services/github');
  stub('../src/services/github', {
    ...realGithub,
    isEnabled: () => true,
    fetchPublicIssues: async () => ({ issues: [{ number: 5, title: 'Stale bug' }] }),
    noteIssuesClosed: () => {}, invalidateIssuesCache: () => {},
    closeIssue: async () => ({}), createIssueComment: async () => ({}),
    getIssue: async () => ({ state: 'open' }),
  });
  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfGovernanceEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise',
  };
  const platform = require('../src/workflow/platform.ts');
  const { issueRoutes, resolveSupersededCloseProposals } = require('../src/routes/issues');
  const router = issueRoutes(config);
  const adminRouter = require('../src/routes/admin-workflow').adminWorkflowRoutes(config);
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  let seq = 0;
  const user = async (o = {}) => (await pool.query(
    `INSERT INTO users (username, password, is_admin, has_platform_access) VALUES ($1, 'x', $2, TRUE) RETURNING id, username`,
    [`route_${++seq}`, !!o.admin])).rows[0];
  const author = await user();
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, approvals_required, repo_url)
     VALUES ('Routed', 'routed', $1, 1, 'https://github.com/acme/routed') RETURNING *`, [author.id]);
  const issue = async (kind, payload) => (await pool.query(
    `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [app.id, `${kind}`, kind, JSON.stringify(payload), author.id])).rows[0];
  const status = async (i) => (await pool.query('SELECT status, payload FROM issues WHERE id = $1', [i.id])).rows[0];
  const instance = async (i) => (await pool.query(
    `SELECT state FROM wf_instances WHERE machine = 'governance-proposal' AND key = $1`, [`issue:${i.id}`])).rows[0];

  // A proposal opened before the flag: the boot backfill enrolls it.
  const before = await issue('rename', { newName: 'Renamed by route' });
  await platform.startWorkflow(config, { loops: true });
  const until = async (check, what) => {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, what);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  await until(async () => (await instance(before))?.state === 'open', 'backfilled');

  const vote = handlerFor(router, 'post', '/api/issues/:id/vote');
  const withdraw = handlerFor(router, 'post', '/api/issues/:id/close');
  const adminApply = handlerFor(router, 'post', '/api/issues/:id/admin-apply');
  const create = handlerFor(router, 'post', '/api/apps/:slug/issues');

  await t.test('a deciding vote answers with the applied result', async () => {
    const voter = await user();
    const r = await call(vote, { params: { id: String(before.id) }, body: { vote: 'up' }, user: voter });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.renamed.applied, true);
    assert.equal(r.body.renamed.newName, 'Renamed by route');
    assert.equal((await status(before)).status, 'closed');
    assert.ok(pushes.some(([k, d]) => k === 'app' && d.action === 'renamed'), 'the rename was pushed after commit');
    const again = await call(vote, { params: { id: String(before.id) }, body: { vote: 'up' }, user: await user() });
    assert.deepEqual([again.status, again.body.error], [409, 'Issue is not open']);
  });

  await t.test('a No without a line is refused; a retraction toggles', async () => {
    const i = await issue('close_issue', { issueNumber: 3, issueTitle: 'x' });
    await pool.query('UPDATE apps SET approvals_required = 5 WHERE id = $1', [app.id]);
    const voter = await user();
    const noLine = await call(vote, { params: { id: String(i.id) }, body: { vote: 'down' }, user: voter });
    assert.deepEqual([noLine.status, noLine.body.error], [400, 'reason_required']);
    const up = await call(vote, { params: { id: String(i.id) }, body: { vote: 'up' }, user: voter });
    assert.equal(up.body.issueClosed.applied, false);
    const toggle = await call(vote, { params: { id: String(i.id) }, body: { vote: 'up' }, user: voter });
    assert.deepEqual(toggle.body, { ok: true, toggled: true });
  });

  await t.test('withdraw and admin apply go through the machine', async () => {
    const w = await issue('close_issue', { issueNumber: 4, issueTitle: 'y' });
    const other = await call(withdraw, { params: { id: String(w.id) }, user: await user() });
    assert.equal(other.status, 403);
    const mine = await call(withdraw, { params: { id: String(w.id) }, user: author });
    assert.deepEqual([mine.status, mine.body], [200, { ok: true }]);
    assert.ok((await status(w)).payload.withdrawnAt);
    const a = await issue('close_issue', { issueNumber: 6, issueTitle: 'z' });
    const adminUser = { ...(await user({ admin: true })), canAdminWrite: true };
    const forced = await call(adminApply, { params: { id: String(a.id) }, user: adminUser });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.deepEqual([forced.body.applied.applied, forced.body.applied.checkingTarget], [false, true],
      'a close proposal applies once its target check answers');
    await until(async () => (await instance(a)).state === 'applied', 'applied after the check');
    assert.equal((await status(a)).payload.appliedBy, `admin:${adminUser.username}`);
  });

  await t.test('the create route enrolls; a merged PR supersedes through the machine', async () => {
    const member = await user();
    await pool.query(`INSERT INTO community_members (community_id, user_id, source) SELECT community_id, $2, 'joined' FROM apps WHERE id = $1`,
      [app.id, member.id]);
    const appAccess = require('../src/services/app-access');
    const origGet = appAccess.getAppForUser;
    appAccess.getAppForUser = async () => app;
    try {
      const r = await call(create, {
        params: { slug: 'routed' }, user: member,
        body: { kind: 'close_issue', payload: { issueNumber: 5 } },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const created = r.body.issue;
      await until(async () => (await instance(created))?.state === 'open', 'enrolled by the create route');
      const { resolved } = await resolveSupersededCloseProposals(pool, {
        appId: app.id, numbers: [5], cause: { kind: 'pr-merge', prNumber: 77 },
      });
      assert.deepEqual(resolved, [created.id]);
      await until(async () => (await instance(created)).state === 'superseded', 'superseded');
      assert.equal((await status(created)).payload.supersededBy, 'pr-merge:#77');
    } finally {
      appAccess.getAppForUser = origGet;
    }
  });

  await t.test('the admin console reads problems and timelines, and acts through events', async () => {
    const adminUser = { ...(await user({ admin: true })), isAdmin: true, canAdminWrite: true };
    const viewOnly = { ...(await user()), isAdmin: true, canAdminWrite: false };
    const overview = await call(handlerFor(adminRouter, 'get', '/api/admin/workflow'), { user: adminUser });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.running, true);
    assert.deepEqual(overview.body.actions['governance-proposal'].sort(), ['AdminApply', 'Evaluate', 'RetryFollowup']);
    assert.ok(overview.body.counts.some((c) => c.machine === 'governance-proposal' && c.state === 'applied'));

    const i = await issue('close_issue', { issueNumber: 21, issueTitle: 'w' });
    await pool.query('UPDATE apps SET approvals_required = 9 WHERE id = $1', [app.id]);
    await platform.fileProposal(i.id, app.id);
    await until(async () => (await instance(i))?.state === 'open', 'filed');
    const detail = await call(handlerFor(adminRouter, 'get', '/api/admin/workflow/instance'),
      { user: viewOnly, query: { machine: 'governance-proposal', key: `issue:${i.id}` } });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.instance.state, 'open');
    // The timeline holds the filing (and, by now, possibly the hourly target check's result).
    assert.ok(detail.body.events.some((e) => e.type === 'Filed' && e.result === 'accepted'));

    const evaluate = handlerFor(adminRouter, 'post', '/api/admin/workflow/event');
    const recheck = await call(evaluate, { user: adminUser, body: { machine: 'governance-proposal', key: `issue:${i.id}`, type: 'Evaluate' } });
    assert.equal(recheck.body.status, 'accepted');
    const bad = await call(evaluate, { user: adminUser, body: { machine: 'governance-proposal', key: `issue:${i.id}`, type: 'Withdraw' } });
    assert.equal(bad.status, 400);
    const applied = await call(evaluate, { user: adminUser, body: { machine: 'governance-proposal', key: `issue:${i.id}`, type: 'AdminApply' } });
    assert.equal(applied.body.status, 'accepted');
    await until(async () => (await instance(i)).state === 'applied', 'applied after the check');
    assert.equal((await status(i)).payload.appliedBy, `admin:${adminUser.username}`);

    // A faulted instance is listed first and released by retrying its event.
    const f = await issue('close_issue', { issueNumber: 22, issueTitle: 'v' });
    await platform.fileProposal(f.id, app.id);
    await until(async () => (await instance(f))?.state === 'open', 'filed');
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_instances SET flag = 'faulted', flag_detail = '{"eventId": 0, "message": "synthetic"}' WHERE key = 'issue:${f.id}'; COMMIT`);
    const problems = await call(handlerFor(adminRouter, 'get', '/api/admin/workflow'), { user: viewOnly });
    assert.ok(problems.body.problems.flagged.some((p) => p.key === `issue:${f.id}`));
    const release = handlerFor(adminRouter, 'post', '/api/admin/workflow/release');
    const released = await call(release, { user: adminUser, body: { machine: 'governance-proposal', key: `issue:${f.id}`, mode: 'skip' } });
    assert.equal(released.body.released, true);
    assert.equal((await pool.query(`SELECT flag FROM wf_instances WHERE key = $1`, [`issue:${f.id}`])).rows[0].flag, null);
  });

  await t.test('an admin apply retried with its key replays; a closed row the machine never held is 409', async () => {
    const adminUser = { ...(await user({ admin: true })), canAdminWrite: true };
    const keyed = (k) => (h) => (h === 'Idempotency-Key' ? k : undefined);
    const a = await issue('close_issue', { issueNumber: 31, issueTitle: 'k' });
    const first = await call(adminApply, { params: { id: String(a.id) }, user: adminUser, get: keyed('apply-once') });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.applied.checkingTarget, true);
    await until(async () => (await instance(a)).state === 'applied', 'applied after the check');
    const retry = await call(adminApply, { params: { id: String(a.id) }, user: adminUser, get: keyed('apply-once') });
    assert.deepEqual([retry.status, retry.body], [200, first.body], 'the original answer, not 409');
    const other = await call(adminApply, { params: { id: String(a.id) }, user: adminUser, get: keyed('apply-twice') });
    assert.deepEqual([other.status, other.body.error], [409, 'Issue is not open'], 'a new request is refused');
    const legacy = await issue('close_issue', { issueNumber: 32, issueTitle: 'l' });
    await pool.query(`UPDATE issues SET status = 'closed' WHERE id = $1`, [legacy.id]);
    const closed = await call(adminApply, { params: { id: String(legacy.id) }, user: adminUser });
    assert.deepEqual([closed.status, closed.body.error], [409, 'Issue is not open']);
  });

  await t.test('a replayed vote answers what it answered the first time', async () => {
    const keyed = (k) => (h) => (h === 'Idempotency-Key' ? k : undefined);
    await pool.query('UPDATE apps SET approvals_required = 5 WHERE id = $1', [app.id]);
    const i = await issue('close_issue', { issueNumber: 34, issueTitle: 'n' });
    const voter = await user();
    const up = await call(vote, { params: { id: String(i.id) }, body: { vote: 'up' }, user: voter, get: keyed('vote-up') });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.issueClosed.upCount, 1);
    const retract = await call(vote, { params: { id: String(i.id) }, body: { vote: 'up' }, user: voter, get: keyed('vote-retract') });
    assert.deepEqual(retract.body, { ok: true, toggled: true });
    const replay = await call(vote, { params: { id: String(i.id) }, body: { vote: 'up' }, user: voter, get: keyed('vote-up') });
    assert.deepEqual([replay.status, replay.body], [200, up.body], 'the original answer, not toggled');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM issue_votes WHERE issue_id = $1', [i.id])).rows[0].n, 0,
      'and the replay changed nothing');
  });

  await t.test('the workflow pool survives the server dropping its idle connections', async () => {
    await new Promise((res) => setTimeout(res, 100));
    const { rows } = await pool.query(
      `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
        WHERE application_name = 'homeroom-workflow' AND datname = current_database() AND state = 'idle'`);
    assert.ok(rows.length > 0, 'there were idle workflow connections to drop');
    await new Promise((res) => setTimeout(res, 300));
    const i = await issue('close_issue', { issueNumber: 33, issueTitle: 'm' });
    await pool.query('UPDATE apps SET approvals_required = 1 WHERE id = $1', [app.id]);
    const r = await call(vote, { params: { id: String(i.id) }, body: { vote: 'up' }, user: await user() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.issueClosed.checkingTarget, true);
    await until(async () => (await instance(i)).state === 'applied', 'applied after the check');
  });
});
