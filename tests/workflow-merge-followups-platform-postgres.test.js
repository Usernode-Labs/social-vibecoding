'use strict';

// The merge-followups machine wired into the platform (src/workflow/
// platform.ts), with WF_MERGE_FOLLOWUPS_ENABLED on and a running runtime:
// a confirmed merge goes live through the real work handlers (their I/O
// stubbed), recovery's report reads the tally again, a successful deploy
// anywhere reaches the merges still waiting, the admin's Retry delivery
// works, and with the flag off the runtime still finishes accepted work but
// takes no new merges. GitHub, the rebuild, the watcher and WS pushes are
// stubbed; everything else is the full PostgreSQL schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('merge follow-ups through the platform runtime', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_merge_platform_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // Stubs: the request pool is the test pool; outside I/O records.
  const calls = [];
  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', {
    ...realWs, broadcast: () => {}, broadcastGlobalScoped: () => {}, pushVoteUpdate: () => {},
    pushIssueUpdate: () => {}, pushNotificationToUser: () => {},
  });
  const realGithub = require('../src/services/github');
  const deploys = { fail: null };
  stub('../src/services/github', {
    ...realGithub,
    isEnabled: () => true,
    listPullRequestCommitShas: async () => ({ shas: [], complete: true }),
    compareCommitAncestry: async (owner, repo, base, head) => {
      calls.push(['compare', base, head]);
      return { status: head === SHA('c') ? 'ahead' : 'diverged' };
    },
    noteIssuesClosed: () => {}, invalidateIssuesCache: () => {},
  });
  const realStaging = require('../src/services/staging');
  stub('../src/services/staging', {
    ...realStaging,
    async rebuildProduction(config, app, opts) {
      calls.push(['rebuild', app.id, opts]);
      if (deploys.fail) throw new realStaging.MissingSecretsError(['API_KEY']);
      return { containerId: null, sha: opts.reuseRunningRevision || SHA('f') };
    },
    async teardownStaging(row) { calls.push(['teardown', row.id, row.status]); return { removed: true }; },
  });
  stub('../src/services/worker', { ...require('../src/services/worker'), retireWorker: async (id) => { calls.push(['retire', id]); return {}; } });
  stub('../src/services/main-watch', { ...require('../src/services/main-watch'), afterMerge: async (c, p, o) => { calls.push(['main-check', o.mergeSha]); return null; } });
  stub('../src/services/issue-close-watcher', {
    ...require('../src/services/issue-close-watcher'),
    watchIssuesClosedAfterMerge: async (o) => { calls.push(['watch', o.prNumber]); return { closed: [], skipped: [], stillOpen: [] }; },
  });
  stub('../src/services/conflict-resolver', { checkAndResolveConflicts: async () => {} });
  stub('../src/services/homeroom-bot', { ...require('../src/services/homeroom-bot'), noteRequestMerged: async () => null });
  stub('../src/services/homeroom-bot-dm', {
    ...require('../src/services/homeroom-bot-dm'),
    noteProposalMerged: async (p, s, o) => { calls.push(['dm', s.id, o.live, o.sha]); return null; },
  });

  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfMergeFollowupsEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise',
  };
  const platform = require('../src/workflow/platform.ts');
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await platform.startWorkflow(config, { loops: true });

  let seq = 0;
  const { rows: [author] } = await pool.query(`INSERT INTO users (username, password) VALUES ('author', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ('Shop', 'shop', $1, 'https://github.com/acme/shop') RETURNING *`,
    [author.id]);
  const proposal = async (status = 'merging') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, $3, $4, 'Change') RETURNING *`,
    [app.id, author.id, status, ++seq])).rows[0];
  const state = async (s) => (await pool.query(
    `SELECT state FROM wf_instances WHERE machine = 'merge-followups' AND key = $1`, [`session:${s.id}`])).rows[0]?.state;
  const until = async (check, what) => {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      if (Date.now() >= deadline) {
        const { rows } = await pool.query(
          `SELECT key, kind, work_key, status, attempt_count, due_at, last_error FROM wf_work
            WHERE machine = 'merge-followups' AND status <> 'settled'
           UNION ALL SELECT key, type, request_key, status, attempts, retry_at, error FROM wf_events
            WHERE machine = 'merge-followups' AND status = 'pending'`);
        assert.fail(`${what}; unsettled: ${JSON.stringify(rows)}`);
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  // Every follow-up settled. Stopping the runtime while one runs leaves it
  // `running` until its lease ends (a minute), so a subtest that stops it
  // waits for this first.
  const quiet = () => until(async () => !(await pool.query(
    `SELECT 1 FROM wf_work WHERE machine = 'merge-followups' AND status <> 'settled'
     UNION ALL SELECT 1 FROM wf_events WHERE machine = 'merge-followups' AND status = 'pending'`)).rows.length,
  'every follow-up settled');

  await t.test('the flag is recorded for the ownership triggers', async () => {
    const { rows } = await pool.query(`SELECT key FROM wf_settings WHERE key LIKE 'enabled:%' ORDER BY key`);
    assert.deepEqual(rows.map((r) => r.key), ['enabled:merge-followups']);
    assert.equal(platform.mergeFollowupsEnabled(), true);
    assert.equal(platform.governanceEnabled(), false, 'the governance machine has its own flag');
  });

  await t.test('a confirmed merge goes live through the real handlers', async () => {
    const s = await proposal();
    const out = await platform.mergeConfirmed({
      sessionId: s.id, appId: app.id, mergeSha: SHA('a'), force: false, tally: { yes: 2, required: 2, active: 4 },
    });
    assert.ok(['accepted', 'pending'].includes(out.status), out.status);
    await until(async () => (await state(s)) === 'live', 'live');
    const r = (await pool.query('SELECT status, live_at, merge_commit_sha FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
    assert.equal(r.status, 'merged');
    assert.ok(r.live_at);
    assert.ok(calls.some((c) => c[0] === 'rebuild' && c[2].reuseRunningRevision === SHA('a')), 'the merge commit, not main\'s tip');
    await until(async () => calls.some((c) => c[0] === 'dm' && c[1] === s.id), 'the DM');
    assert.deepEqual(calls.find((c) => c[0] === 'dm' && c[1] === s.id).slice(2), [true, SHA('a')]);
    assert.ok(calls.some((c) => c[0] === 'teardown' && c[1] === s.id && c[2] === 'merged'));
    assert.ok(calls.some((c) => c[0] === 'main-check' && c[1] === SHA('a')));
    const { rows: [m] } = await pool.query('SELECT main_sha FROM apps WHERE id = $1', [app.id]);
    assert.equal(m.main_sha, SHA('a'));
  });

  await t.test('recovery reports a lost merge with the tally read again', async () => {
    const s = await proposal('promoted');
    const { rows: [voter] } = await pool.query(`INSERT INTO users (username, password) VALUES ('voter', 'x') RETURNING id`);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s.id, voter.id]);
    await platform.mergeObserved({ sessionId: s.id, appId: app.id, mergeSha: SHA('a'), mergedAt: '2026-10-07T10:00:00Z' });
    await until(async () => (await state(s)) === 'live', 'live');
    const { rows: [i] } = await pool.query(`SELECT data FROM wf_instances WHERE key = $1`, [`session:${s.id}`]);
    assert.equal(i.data.tally.yes, 1);
    assert.equal(i.data.mergedAt, '2026-10-07T10:00:00.000Z');
  });

  await t.test('a failed deploy goes live when any later deploy contains it', async () => {
    deploys.fail = true;
    const s = await proposal();
    await platform.mergeConfirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('b'), force: false, tally: { yes: 1, required: 1, active: 1 } });
    await until(async () => (await state(s)) === 'deploy_failed', 'deploy failed');
    deploys.fail = false;
    // The drift poller's deploy of a build that does not contain it, then one that does.
    await platform.productionDeployed(app.id, SHA('d'));
    await until(async () => calls.some((c) => c[0] === 'compare' && c[2] === SHA('d')), 'checked');
    assert.equal(await state(s), 'deploy_failed');
    await platform.productionDeployed(app.id, SHA('c'));
    await until(async () => (await state(s)) === 'live', 'live after a deploy containing it');
  });

  await t.test('an admin retries a failed delivery', async () => {
    deploys.fail = true;
    const s = await proposal();
    await platform.mergeConfirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('e'), force: false, tally: { yes: 1, required: 1, active: 1 } });
    await until(async () => (await state(s)) === 'deploy_failed', 'deploy failed');
    deploys.fail = false;
    const out = await platform.adminEvent('merge-followups', `session:${s.id}`, 'RetryDelivery', {}, { id: author.id, username: 'author' });
    assert.ok(['accepted', 'pending'].includes(out.status), out.status);
    await until(async () => (await state(s)) === 'live', 'live after the retry');
    await assert.rejects(platform.adminEvent('merge-followups', `session:${s.id}`, 'Merged', {}, { id: author.id, username: 'author' }),
      /not an admin action/);
  });

  await t.test('with the flag off, accepted work still finishes and nothing new is taken', async () => {
    const s = await proposal();
    await quiet();
    await platform.stopWorkflow();
    // Accepted before the restart: the event waits for a runtime.
    await platform.startWorkflow(config, { loops: false });
    await platform.mergeConfirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('a'), force: false, tally: { yes: 1, required: 1, active: 1 } });
    await platform.stopWorkflow();
    const off = { ...config, wfMergeFollowupsEnabled: false };
    await platform.startWorkflow(off, { loops: true });
    assert.equal(platform.workflowRunning(), true, 'it runs to finish what it accepted');
    assert.equal(platform.mergeFollowupsEnabled(), false, 'but takes no new merges');
    const { rows } = await pool.query(`SELECT key FROM wf_settings WHERE key = 'enabled:merge-followups'`);
    assert.equal(rows.length, 0, 'the legacy merge path may move rows into merged again');
    await until(async () => (await state(s)) === 'live', 'the accepted merge finished');
    // And every follow-up of it, the DM and journey record that follow live included.
    await quiet();
    await platform.stopWorkflow();
    await platform.startWorkflow(off, { loops: true });
    assert.equal(platform.workflowRunning(), false, 'nothing left: no runtime');
  });

  await t.test('with the flag off, a merge still waiting for a deploy keeps the runtime (review finding 3)', async () => {
    await platform.startWorkflow(config, { loops: true });
    deploys.fail = true;
    const s = await proposal();
    await platform.mergeConfirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('9'), force: false, tally: { yes: 1, required: 1, active: 1 } });
    await until(async () => (await state(s)) === 'deploy_failed', 'deploy failed');
    deploys.fail = false;
    await quiet();  // it now only waits for a deploy
    await platform.stopWorkflow();
    const off = { ...config, wfMergeFollowupsEnabled: false };
    await platform.startWorkflow(off, { loops: true });
    assert.equal(platform.workflowRunning(), true, 'a merge waiting for a deploy keeps it running');
    assert.equal(platform.mergeFollowupsEnabled(), false);
    // The drift poller's later deploy (a build GitHub says contains it) is heard.
    await platform.productionDeployed(app.id, SHA('c'));
    await until(async () => (await state(s)) === 'live', 'live after the flag went off');
    await quiet();
    await platform.stopWorkflow();
  });

  await t.test('a booting process records the build it runs; the migration\'s main_sha is not that (review finding, second pass)', async () => {
    const { rows: [self] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url, main_sha)
       VALUES ('Homeroom', 'homeroom-self', $1, TRUE, 'https://github.com/acme/homeroom', $2) RETURNING id`,
      [author.id, SHA('7')]);
    const was = process.env.GIT_SHA;
    process.env.GIT_SHA = SHA('6');
    try {
      await platform.startWorkflow(config, { loops: false });
      const { rows: [r] } = await pool.query('SELECT main_sha, booted_sha FROM apps WHERE id = $1', [self.id]);
      assert.deepEqual({ ...r }, { main_sha: SHA('7'), booted_sha: SHA('6') }, 'what booted, not what the migration seeded');
    } finally {
      if (was === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = was;
      await platform.stopWorkflow();
    }
  });
});
