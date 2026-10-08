'use strict';

// The workflow machines with their decisions and work in another process
// than the web side, and through a crash of that process
// (tests/lib/workflow-processes.js). This test process is the web side: it
// appends through platform.ts with no pipeline slot of its own, so every
// decision and every work item runs in the child, with only outside services
// faked (tests/fixtures/workflow-outside-fakes.js). A restart scenario kills
// the child with SIGKILL in the middle of a flow, starts another, and checks
// the end is what an uninterrupted run of the same flow gives.
//
// The scenarios marked `todo` are the known places where a machine still
// depends on the web process's memory; each says which entry of
// tests/baselines/workflow-process-state.json it shows, and passes once the
// step that removes the entry lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const procs = require('./lib/workflow-processes');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const FAKES = path.join(__dirname, 'fixtures', 'workflow-outside-fakes.js');
const SHA = (c) => c.repeat(40).slice(0, 40);
const DATA_KEY = 'synthetic-processes-key';

test('workflow machines in a process of their own, and through its crash', { timeout: 300000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_procs_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const databaseUrl = String(url);
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  // Registered first, so a failure from here on still drops the database.
  let workflow = null;
  let listener = null;
  let platform = null;
  t.after(async () => {
    if (process.env.WF_DEBUG) {
      const { rows } = await pool.query(`SELECT kind, data->>'module' AS m, data->>'fn' AS fn, data->>'url' AS url, count(*)::int AS n
        FROM wf_test_effects WHERE kind IN ('fake.unexpected', 'net.refused') GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`).catch(() => ({ rows: [] }));
      console.log('outside calls the flows reached unfaked:', rows);
    }
    await workflow?.stop();
    await platform?.stopWorkflow();
    await listener?.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await procs.prepare(pool);

  // The flags, as config.js reads them; the child adds the database URL.
  const flags = { dataEncryptionKey: DATA_KEY, wfGovernanceEnabled: true, wfMergeFollowupsEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise' };
  const startWorkflow = async () => {
    workflow = procs.startWorkflowProcess({ databaseUrl, config: flags, fixture: FAKES });
    await workflow.ready;
    return workflow;
  };

  // The web side: appends and waits, decides nothing (no pipeline slot).
  const stub = (p, exports) => { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] }; };
  stub('../src/db/pool', { getPool: () => pool });
  platform = require('../src/workflow/platform.ts');
  // What browsers hear, as every web process does.
  const heard = [];
  listener = new Client({ connectionString: databaseUrl });
  await listener.connect();
  listener.on('notification', (m) => { const e = JSON.parse(m.payload); if (e.i === 'workflow') heard.push(e); });
  await listener.query('LISTEN usernode_ws');

  let seq = 0;
  const user = async () => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [`proc_${++seq}`])).rows[0];
  const author = await user();
  const app = async (o = {}) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, approvals_required, repo_url, self_hosted)
     VALUES ($1::text, $1::text, $2, 1, 'https://github.com/acme/' || $1::text, $3) RETURNING *`,
    [`procs-${++seq}`, author.id, !!o.selfHosted])).rows[0];
  const closeProposal = async (a, number) => (await pool.query(
    `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Close it', 'close_issue', $2, $3) RETURNING *`,
    [a.id, JSON.stringify({ issueNumber: number, issueTitle: `Old ${number}` }), author.id])).rows[0];
  const proposal = async (a) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, 'merging', $3, 'A change') RETURNING *`,
    [a.id, author.id, ++seq])).rows[0];
  const instance = async (machine, key) => (await pool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];
  // The processes that ran a work item: a crash mid-item shows two.
  const ranIn = async (machine, key, kind) => (await pool.query(
    `SELECT count(DISTINCT a.service_id)::int AS n FROM wf_work_attempts a JOIN wf_work w ON w.id = a.work_id
      WHERE w.machine = $1 AND w.key = $2 AND w.kind = $3`, [machine, key, kind])).rows[0].n;
  const settled = async (machine, key, kind) => (await pool.query(
    `SELECT status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 1`,
    [machine, key, kind])).rows[0]?.status === 'settled';

  await platform.startWorkflow({ ...flags, databaseUrl, wfSlots: 0 }, { loops: false });
  await startWorkflow();

  // ── Governance: a close proposal decided by a vote ──────────────────
  const govKey = (i) => `issue:${i.id}`;
  async function closeByVote(number, { crashAt } = {}) {
    const a = await app();
    const issue = await closeProposal(a, number);
    await platform.fileProposal(issue.id, a.id);
    if (crashAt) await procs.arm(pool, crashAt);
    const reply = await platform.voteOnProposal({ ...issue, status: 'open' }, await user(), { vote: 'up', reason: null });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    if (crashAt) {
      await procs.reached(pool, crashAt);
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await instance('governance-proposal', govKey(issue)))?.data?.followups?.target?.status === 'done',
      'the issue closed on GitHub');
    const comments = (await procs.effects(pool, 'github.comment')).filter((c) => c.data.number === number);
    return {
      state: (await instance('governance-proposal', govKey(issue))).state,
      row: (await pool.query('SELECT status FROM issues WHERE id = $1', [issue.id])).rows[0].status,
      closed: (await procs.effects(pool, 'github.close')).filter((c) => c.data.number === number).length,
      comments: comments.map((c) => c.data.body.replace(/issue:\d+/, 'issue:N')),
      lines: (await pool.query(`SELECT content FROM chat_messages WHERE thread_type = 'governance' AND thread_ref = $1 ORDER BY id`,
        [issue.id])).rows.map((r) => r.content.replace(/\d+\/\d+/, 'n/m').replace(/proc_\d+/g, 'someone').replace(/#\d+/g, '#N')),
      app: a,
      processes: await ranIn('governance-proposal', govKey(issue), 'github.closeIssue'),
    };
  }

  let uninterrupted;
  await t.test('governance: a vote from the web side closes the issue on GitHub, decided and done in the workflow process', async () => {
    uninterrupted = await closeByVote(41);
    assert.equal(uninterrupted.state, 'applied');
    assert.equal(uninterrupted.row, 'closed');
    assert.equal(uninterrupted.closed, 1);
    assert.equal(uninterrupted.comments.length, 1);
    assert.equal(uninterrupted.processes, 1);
    await procs.until(() => heard.some((e) => e.d?.type === 'issue_update' && e.d.action === 'github_synced' && e.r.appId === uninterrupted.app.id),
      'browsers to hear the list re-read');
    assert.ok(heard.some((e) => e.d?.type === 'issue_update' && e.d.action === 'closed' && e.r.appId === uninterrupted.app.id));
  });

  await t.test('governance, restarted: killed after GitHub created the comment, before its answer', async () => {
    const restarted = await closeByVote(42, { crashAt: 'github.comment.created' });
    const { app: _a, processes, ...got } = restarted;
    const { app: _b, processes: _p, ...want } = uninterrupted;
    assert.equal(processes, 2, 'the item the crash interrupted was finished by the next process');
    assert.deepEqual(got, want, 'the same end as without the crash: closed once, commented once');
  });

  // ── Merge follow-ups: a merge goes live ─────────────────────────────
  const mergeKey = (s) => `session:${s.id}`;
  async function mergeGoesLive({ crashAt } = {}) {
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    const merged = await platform.mergeConfirmed({ sessionId: s.id, appId: a.id, mergeSha: SHA('a'), force: false,
      tally: { yes: 1, required: 1, active: 1 } });
    assert.ok(['accepted', 'pending'].includes(merged.status), JSON.stringify(merged));
    await procs.until(async () => (await instance('merge-followups', mergeKey(s)))?.state === 'delivering', 'the merge recorded');
    if (crashAt) await procs.arm(pool, crashAt);
    // The platform's own release booted with a build containing it.
    await platform.productionDeployed(a.id, SHA('b'));
    if (crashAt) {
      await procs.reached(pool, crashAt);
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await instance('merge-followups', mergeKey(s)))?.state === 'live', 'the merge live');
    const row = (await pool.query('SELECT status, live_at IS NOT NULL AS live FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
    return {
      row,
      lines: (await pool.query(`SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`,
        [s.id])).rows.map((r) => r.content.replace(/PR #\d+/, 'PR #N').replace(/proc_\d+/g, 'someone')),
      app: a, session: s,
      processes: await ranIn('merge-followups', mergeKey(s), 'delivery.verify'),
    };
  }

  let live;
  await t.test('merge follow-ups: a merge reported by the web side goes live when the release containing it boots', async () => {
    live = await mergeGoesLive();
    assert.deepEqual(live.row, { status: 'merged', live: true });
    assert.ok(live.lines.some((l) => /is live/.test(l)), JSON.stringify(live.lines));
    await procs.until(() => heard.some((e) => e.d?.type === 'vote_update' && e.d.sessionId === live.session.id && e.d.live === true),
      'browsers to hear it is live');
    assert.ok(heard.some((e) => e.k === 'room' && e.d?.type === 'chat' && /is live/.test(e.d.content) && e.r.appId === live.app.id));
  });

  await t.test('merge follow-ups, restarted: killed while checking the running build contains the merge', async () => {
    const again = await mergeGoesLive({ crashAt: 'github.compare' });
    assert.equal(again.processes, 2, 'the check the crash interrupted was finished by the next process');
    assert.deepEqual(again.row, live.row);
    assert.deepEqual(again.lines, live.lines, 'the same thread as without the crash');
  });

  // ── Known dependencies on the web process's memory ──────────────────

  await t.test('a shots run holding a worker in the web process keeps a merge from retiring it', {
    todo: 'worker.js#_workerHolds lives in the process running the shots run (list: services | uses src/services/worker.js:retireWorker); step 1 makes it durable',
  }, async () => {
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    const hold = require('../src/services/worker').holdWorker(s.id);
    try {
      await platform.mergeConfirmed({ sessionId: s.id, appId: a.id, mergeSha: SHA('c'), force: false, tally: { yes: 1, required: 1, active: 1 } });
      await procs.until(() => settled('merge-followups', mergeKey(s), 'worker.retire'), 'the retire work to finish');
      const removed = (await procs.effects(pool, 'docker.removeVolume')).filter((e) => e.data.name.endsWith(`-${s.id}`));
      assert.deepEqual(removed, [], 'the worker is kept while the shots run holds it');
    } finally {
      await hold.release();
    }
  });

  await t.test('a change busy in the web process is not marked as carried by a merge', {
    todo: 'active-workers.js#activeSessionOperations lives in the process running the operation (list: services | uses src/services/active-workers.js:isSessionBusy); step 1 makes it durable',
  }, async () => {
    const a = await app({ selfHosted: true });
    const carrier = await proposal(a);
    const { rows: [busy] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, reviewed_head_sha)
       VALUES ($1, $2, 'promoted', $3, 'Busy', $4) RETURNING *`, [a.id, author.id, ++seq, SHA('e')]);
    // Its head is one of the carrier's commits, and a sync with main is running on it here.
    await pool.query(`INSERT INTO wf_test_effects (kind, data) VALUES ('github.prCommits', $1)`,
      [JSON.stringify({ number: carrier.pr_number, shas: [SHA('e')] })]);
    const done = require('../src/services/active-workers').beginSessionOperation(busy.id);
    try {
      await platform.mergeConfirmed({ sessionId: carrier.id, appId: a.id, mergeSha: SHA('f'), force: false, tally: { yes: 1, required: 1, active: 1 } });
      await procs.until(() => settled('merge-followups', mergeKey(carrier), 'included.find'), 'the search for carried changes');
      const read = async () => (await pool.query('SELECT status, included_in_session_id FROM chat_sessions WHERE id = $1', [busy.id])).rows[0];
      // Marking it would follow the search as a message; give that time to land.
      await procs.until(async () => (await read()).included_in_session_id, 'a mark that should not come', 2000).catch(() => {});
      const row = await read();
      assert.deepEqual(row, { status: 'promoted', included_in_session_id: null }, 'left as it is while busy');
    } finally {
      done();
    }
  });

  await t.test('the version pill reads "deploying" while the workflow process deploys a merge', {
    todo: 'app-deploy-status.js#_state lives in the process that deploys (list: services | uses src/services/staging.js:rebuildProduction); step 2 makes it durable',
  }, async () => {
    const a = await app();
    const s = await proposal(a);
    await procs.arm(pool, 'github.clone');
    await platform.mergeConfirmed({ sessionId: s.id, appId: a.id, mergeSha: SHA('d'), force: false, tally: { yes: 1, required: 1, active: 1 } });
    try {
      await procs.reached(pool, 'github.clone');
      const pill = require('../src/services/app-deploy-status').read(a.slug);
      assert.ok(pill, 'the web side sees the deploy under way');
    } finally {
      await procs.release(pool, 'github.clone');
    }
  });
});
