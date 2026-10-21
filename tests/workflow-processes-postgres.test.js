'use strict';

// The workflow machines with their decisions and work in another process
// than the web side, and through a crash of that process
// (tests/lib/workflow-processes.js). This test process is the web side: it
// appends through platform.ts with no pipeline slot of its own, as a web Pod
// does, so every decision and every work item runs in the child: server.js
// itself, booted as a conductor, with only outside services faked
// (tests/fixtures/workflow-outside-fakes.js). A restart scenario kills the
// child with SIGKILL in the middle of a flow, starts another, and checks the
// end is what an uninterrupted run of the same flow gives; the last ones run
// two conductors at once.

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
  // pool.end() resolves before its sockets have closed, and the DROP below
  // forces (the children's connections may outlive them): a connection cut
  // while it closes reports to the pool, not as an uncaught error.
  pool.on('error', () => {});
  // Registered first, so a failure from here on still drops the database.
  let workflow = null;
  let second = null;
  let listener = null;
  let platform = null;
  t.after(async () => {
    await workflow?.stop();
    await second?.stop();
    await platform?.stopWorkflow();
    await listener?.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await procs.prepare(pool);

  // The configuration, as config.js reads it: the web side's, and the
  // conductor's environment, as the chart sets it (the child adds the
  // database URL and its port).
  const flags = { dataEncryptionKey: DATA_KEY, wfPoolMax: 4, wfSlots: 2,
    // Before & after shots taken (their steps are faked).
    shots: { execute: true, collect: true, maxAgentMs: 480000, maxRunMs: 1440000 },
    // Phone push on, to a fake Firebase (the fixture fakes its library).
    mobilePushEnabled: true, mobilePushEnvironment: 'production', firebaseProjectId: 'social-test',
    firebaseServiceAccountJsonB64: Buffer.from(JSON.stringify({
      project_id: 'social-test', client_email: 'push@social-test.iam.example', private_key: 'fake' })).toString('base64') };
  const conductorEnv = {
    DATA_ENCRYPTION_KEY: DATA_KEY, WF_POOL_MAX: '4', WF_SLOTS: '2',
    SHOTS_ENABLED: 'true', SHOTS_MAX_AGENT_MS: '480000', SHOTS_MAX_RUN_MS: '1440000',
    MOBILE_PUSH_ENABLED: 'true', PUSH_ENV: 'production', FIREBASE_PROJECT_ID: flags.firebaseProjectId,
    FIREBASE_SERVICE_ACCOUNT_JSON_B64: flags.firebaseServiceAccountJsonB64,
  };
  const startConductor = async (env = {}) => {
    const p = await procs.startWorkflowProcess({ databaseUrl, fixture: FAKES, env: { ...conductorEnv, ...env } });
    await p.ready;
    return p;
  };
  const startWorkflow = async (env = {}) => {
    workflow = await startConductor(env);
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
  // And what the conductor's own code pushes over the bus (ws-bus.js), as a
  // web process's relay hears it: an io core's push, not a transition's.
  const relayed = [];
  listener.on('notification', (m) => {
    const e = JSON.parse(m.payload);
    if (e.i === 'workflow') heard.push(e); else relayed.push(e);
  });
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
  // Where a's own deploy or preview build stops at its clone. Every deploy
  // and build an earlier step left failing there retries through the
  // shared `github.clone`, so waiting on that reaches whichever came first.
  const cloneOf = (a) => `github.clone:acme/${a.slug}`;
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

  // GitHub merged it: merge-followups is created by Merged, here appended
  // as the proposal machine's message would bring it (the merge itself, below).
  const appendMerged = (m) => require('../src/workflow/kernel/index.ts').appendEvent(pool, 'merge-followups', `session:${m.sessionId}`,
    { type: 'Merged', payload: { sessionId: m.sessionId, mergeSha: m.mergeSha, mergedAt: m.mergedAt || new Date().toISOString(),
      force: false, observedBy: 'recovery', tally: null } },
    { requestKey: `merged:${m.sessionId}:test`, source: { kind: 'system', name: 'recovery' }, appId: m.appId });
  const reportMerge = async (m) => { await appendMerged(m); return { status: 'accepted' }; };

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

  await t.test('governance: a withdrawal and an admin apply from the web side, decided in the workflow process', async () => {
    const a = await app();
    const withdrawn = await closeProposal(a, 43);
    await platform.fileProposal(withdrawn.id, a.id);
    const reply = await platform.withdrawProposal({ ...withdrawn, status: 'open' }, author);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    await procs.until(async () => (await instance('governance-proposal', govKey(withdrawn)))?.state === 'withdrawn', 'withdrawn');
    assert.equal((await pool.query('SELECT status FROM issues WHERE id = $1', [withdrawn.id])).rows[0].status, 'closed');
    const { rows: [adminUser] } = await pool.query(
      `INSERT INTO users (username, password, is_admin, has_platform_access) VALUES ('proc_admin', 'x', TRUE, TRUE) RETURNING id, username`);
    const forced = await closeProposal(a, 44);
    await platform.fileProposal(forced.id, a.id);
    const applied = await platform.adminApplyProposal({ ...forced, status: 'open' }, adminUser);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    // A close proposal applies once its target check answers, then closes the issue on GitHub.
    await procs.until(async () => (await instance('governance-proposal', govKey(forced)))?.data?.followups?.target?.status === 'done',
      'the forced close done on GitHub');
    assert.equal((await instance('governance-proposal', govKey(forced))).state, 'applied');
    assert.equal((await procs.effects(pool, 'github.close')).filter((c) => c.data.number === 44).length, 1);
  });

  // ── Merge follow-ups: a merge goes live ─────────────────────────────
  const mergeKey = (s) => `session:${s.id}`;
  // The platform's own release boots with build `sha` and serves people:
  // the merges waiting for it hear it (platform.ts releaseServing).
  const releaseBoots = async (sha) => {
    const was = process.env.GIT_SHA;
    process.env.GIT_SHA = sha;
    try { await platform.releaseServing(pool); } finally {
      if (was === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = was;
    }
  };
  async function mergeGoesLive({ crashAt } = {}) {
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    const merged = await reportMerge({ sessionId: s.id, appId: a.id, mergeSha: SHA('a') });
    assert.ok(['accepted', 'pending'].includes(merged.status), JSON.stringify(merged));
    await procs.until(async () => (await instance('merge-followups', mergeKey(s)))?.state === 'delivering', 'the merge recorded');
    if (crashAt) await procs.arm(pool, crashAt);
    // The platform's own release booted with a build containing it.
    await releaseBoots(SHA('b'));
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

  // ── Merge follow-ups: a change carried by another merge ─────────────
  async function carriedGoesLive({ crashAt } = {}) {
    const a = await app({ selfHosted: true });
    const carrier = await proposal(a);
    const { rows: [carried] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, reviewed_head_sha)
       VALUES ($1, $2, 'promoted', $3, 'Carried', $4) RETURNING *`, [a.id, author.id, ++seq, SHA('3')]);
    await pool.query(`INSERT INTO wf_test_effects (kind, data) VALUES ('github.prCommits', $1)`,
      [JSON.stringify({ number: carrier.pr_number, shas: [SHA('3')] })]);
    if (crashAt) await procs.arm(pool, crashAt);
    await reportMerge({ sessionId: carrier.id, appId: a.id, mergeSha: SHA('4') });
    if (crashAt) {
      await procs.reached(pool, crashAt);
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await instance('merge-followups', mergeKey(carried)))?.data?.followups?.['close-pr']?.status === 'done',
      'the carried change\'s pull request closed');
    // Its carrier's release boots with the merge commit: both go live.
    await releaseBoots(SHA('4'));
    await procs.until(async () => (await instance('merge-followups', mergeKey(carried)))?.state === 'live', 'the carried change live');
    return {
      row: (await pool.query('SELECT status, included_in_session_id = $2 AS carried, live_at IS NOT NULL AS live FROM chat_sessions WHERE id = $1',
        [carried.id, carrier.id])).rows[0],
      closes: (await procs.effects(pool, 'github.closePR')).filter((c) => c.data.number === carried.pr_number).length,
      comments: (await procs.effects(pool, 'github.comment')).filter((c) => c.data.number === carried.pr_number).length,
      processes: await ranIn('merge-followups', mergeKey(carried), 'github.closePullRequest'),
    };
  }

  let carriedLive;
  await t.test('merge follow-ups: a change carried by another merge is closed and goes live with it, in the workflow process', async () => {
    carriedLive = await carriedGoesLive();
    assert.deepEqual(carriedLive.row, { status: 'merged', carried: true, live: true });
    assert.deepEqual([carriedLive.closes, carriedLive.comments, carriedLive.processes], [1, 1, 1]);
  });

  await t.test('merge follow-ups, restarted: killed after GitHub created the carried change\'s closing comment', async () => {
    const again = await carriedGoesLive({ crashAt: 'github.comment.created' });
    assert.equal(again.processes, 2, 'the close the crash interrupted was finished by the next process');
    assert.deepEqual(again.row, carriedLive.row);
    assert.deepEqual([again.closes, again.comments], [1, 1], 'closed once, commented once');
  });

  // ── Known dependencies on the web process's memory ──────────────────

  await t.test('a shots run still working in a worker keeps a merge from retiring it, whichever process runs it', async () => {
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    // A run under way is the shots machine's state (src/workflow/session-work.ts
    // shotsRunningSql), whichever process runs it, and across its restarts.
    const asWriter = async (fn) => {
      const c = await pool.connect();
      try { await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(c); await c.query('COMMIT'); } finally { c.release(); }
    };
    const shots = (state) => (c) => c.query(
      `INSERT INTO wf_instances (machine, key, state, data, version, machine_version)
       VALUES ('shots', $1, $2, $3::jsonb, 1, 1)
       ON CONFLICT (machine, key) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data`,
      [`session:${s.id}`, state, JSON.stringify({ sessionId: s.id, run: { id: 'r'.repeat(32) }, cleaning: [] })]);
    await asWriter(shots('taking_shots'));
    // A merge also retires the change's preview for good, and that closes a
    // shots run (the preview's Closed): in the same transaction as the
    // retire is asked for, so which the retire sees came first. Here the
    // preview retired already (closing that run), and the run under way at
    // the merge is a later one, which only its own row can keep the worker for.
    await platform.retirePreview(s.id, a.id, 'closed', true);
    await procs.until(async () => (await instance('preview', `session:${s.id}`))?.state === 'retired'
      && (await instance('shots', `session:${s.id}`))?.state === 'closed', 'the preview retired, and the run it closed');
    await asWriter(shots('taking_shots'));
    await reportMerge({ sessionId: s.id, appId: a.id, mergeSha: SHA('c') });
    const retires = async () => (await pool.query(
      `SELECT work_key, status FROM wf_work WHERE machine = 'merge-followups' AND key = $1 AND kind = 'worker.retire' ORDER BY created_at`,
      [mergeKey(s)])).rows;
    await procs.until(async () => (await retires()).length === 2, 'the retire to name the run and ask again later');
    const removed = async () => (await procs.effects(pool, 'docker.removeVolume')).filter((e) => e.data.name.endsWith(`-${s.id}`));
    assert.deepEqual(await removed(), [], 'the worker is kept while the run is under way');
    // The run ends; the retire asked again (made due now) removes the worker.
    await asWriter(shots('published'));
    // The process sleeps until the next item it knows is due: told, as the
    // kernel tells it of work it queues.
    await pool.query(`UPDATE wf_work SET due_at = NOW() WHERE machine = 'merge-followups' AND key = $1 AND kind = 'worker.retire' AND status = 'queued'`,
      [mergeKey(s)]);
    await pool.query(`SELECT pg_notify('wf_work', 'worker.retire')`);
    await procs.until(async () => (await removed()).length === 1, 'the worker to go once the run ended');
  });

  await t.test('shots, restarted: killed while building the copies, the next process carries the run on without building its images again', async () => {
    const a = await app();
    const head = SHA('5');
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, reviewed_head_sha, staging_commit_sha, staging_url)
       VALUES ($1, $2, 'promoted', $3, $3, 'https://preview.test') RETURNING *`, [a.id, author.id, head]);
    const intent = { version: 1, impact: 'ui', rationale: null, stories: [{ id: 'c1', claim: 'The card shows a badge', persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      intent: { startPath: '/', steps: ['Open it'], baseState: 'present', animation: 'none' } }] };
    await procs.arm(pool, 'shots.copies.built');
    // The web side appends the declaration; the workflow process decides it.
    await platform.shotsDeclared({ sessionId: s.id, appId: a.id, intent });
    await procs.reached(pool, 'shots.copies.built');
    await workflow.kill();
    await procs.expireLeases(pool);
    await startWorkflow();
    await procs.release(pool, 'shots.copies.built');
    await procs.until(async () => (await instance('shots', `session:${s.id}`))?.state === 'published', 'the run to publish');
    const copies = await procs.effects(pool, 'shots.copies');
    assert.deepEqual(copies.map((c) => c.data.reused), [false, true], 'the images the first process built are reused');
    assert.equal(copies[1].data.fresh, false, 'and what it left is removed before the copies are made again');
    assert.equal(new Set(copies.map((c) => c.pid)).size, 2);
    assert.equal((await procs.effects(pool, 'shots.agent')).length, 1, 'the agent took the shots once');
    const { rows: runs } = await pool.query('SELECT id, state FROM shot_runs WHERE session_id = $1', [s.id]);
    assert.deepEqual(runs.map((r) => r.state), ['verified']);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM shot_artifacts WHERE run_id = $1', [runs[0].id]);
    assert.equal(n, 2);
    const { rows: [row] } = await pool.query('SELECT shots_state, shots_run_id FROM chat_sessions WHERE id = $1', [s.id]);
    assert.deepEqual(row, { shots_state: 'verified', shots_run_id: runs[0].id });
    await procs.until(async () => (await procs.effects(pool, 'shots.cleanup')).filter((c) => c.data.runId === runs[0].id).length === 1,
      'its copies to go');
  });

  await t.test('a change whose head moved since the carrier listed its commits is not marked as carried', async () => {
    const a = await app({ selfHosted: true });
    const carrier = await proposal(a);
    const { rows: [moved] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, reviewed_head_sha)
       VALUES ($1, $2, 'promoted', $3, 'Moved', $4) RETURNING *`, [a.id, author.id, ++seq, SHA('e')]);
    // Its old head is one of the carrier's commits; a sync with main (which
    // keeps no record while it runs) then moves it.
    await pool.query(`INSERT INTO wf_test_effects (kind, data) VALUES ('github.prCommits', $1)`,
      [JSON.stringify({ number: carrier.pr_number, shas: [SHA('e')] })]);
    await procs.arm(pool, 'github.prCommits');
    await reportMerge({ sessionId: carrier.id, appId: a.id, mergeSha: SHA('f') });
    await procs.reached(pool, 'github.prCommits');
    // As the sync's own move writes it (the row is the proposal machine's
    // from its insert: schema.sql wf_enrol_proposal).
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [moved.id, SHA('7')]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await procs.release(pool, 'github.prCommits');
    await procs.until(() => settled('merge-followups', mergeKey(carrier), 'included.find'), 'the search for carried changes');
    const refusal = async () => (await pool.query(
      `SELECT result, reason FROM wf_events WHERE machine = 'merge-followups' AND key = $1 AND type = 'Included'`, [mergeKey(moved)])).rows[0];
    // Decided, not only appended: the row exists before the pipeline applies it.
    await procs.until(async () => (await refusal())?.result, 'the carried message to be decided');
    assert.deepEqual({ ...await refusal() }, { result: 'rejected', reason: 'head_moved' });
    const { rows: [row] } = await pool.query('SELECT status, included_in_session_id FROM chat_sessions WHERE id = $1', [moved.id]);
    assert.deepEqual({ ...row }, { status: 'promoted', included_in_session_id: null }, 'left to merge on its own');
  });

  await t.test('a change busy in the web process with an operation that keeps no record of its own is not carried', async () => {
    const a = await app({ selfHosted: true });
    const carrier = await proposal(a);
    const { rows: [busy] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, reviewed_head_sha)
       VALUES ($1, $2, 'promoted', $3, 'Busy', $4) RETURNING *`, [a.id, author.id, ++seq, SHA('8')]);
    await pool.query(`INSERT INTO wf_test_effects (kind, data) VALUES ('github.prCommits', $1)`,
      [JSON.stringify({ number: carrier.pr_number, shas: [SHA('8')] })]);
    // A sync with main starting its worker here: no active_turn yet, head
    // unchanged. The preview machine records it, held by this process.
    const done = require('../src/services/active-workers').beginSessionOperation(busy.id);
    try {
      await done.recorded;
      assert.deepEqual((await instance('preview', `session:${busy.id}`)).data.operations.map((o) => o.kind), ['operation']);
      await reportMerge({ sessionId: carrier.id, appId: a.id, mergeSha: SHA('9') });
      await procs.until(() => settled('merge-followups', mergeKey(carrier), 'included.find'), 'the search for carried changes');
      // Wait for the decision itself, not a fixed time: the find settling
      // only starts the chain (its WorkDone decided on the carrier, then the
      // Included it sends appended and decided on this change), and a mark
      // would be written by that same decision. A two-second window read the
      // refusal before a loaded machine had decided it (#5059).
      const refusal = async () => (await pool.query(
        `SELECT result, reason FROM wf_events WHERE machine = 'merge-followups' AND key = $1 AND type = 'Included'`, [mergeKey(busy)])).rows[0];
      await procs.until(async () => (await refusal())?.result, 'the carried message to be decided');
      assert.deepEqual({ ...await refusal() }, { result: 'rejected', reason: 'worked_on' }, 'refused by the change\'s own guard, from the record');
      const { rows: [row] } = await pool.query('SELECT status, included_in_session_id FROM chat_sessions WHERE id = $1', [busy.id]);
      assert.deepEqual({ ...row }, { status: 'promoted', included_in_session_id: null }, 'left as it is while busy');
    } finally {
      done();
    }
    // Once it ends, the record goes.
    await procs.until(async () => (await instance('preview', `session:${busy.id}`)).data.operations.length === 0, 'the operation to end');
  });

  // ── Previews: who reads a build under way, and a build through a crash ─
  // A build here stops at its clone (`github.clone`), which then fails:
  // what these show is where the state lives, and that the machine resumes.
  const promoted = async (a, head) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, branch_name, reviewed_head_sha)
     VALUES ($1, $2, 'promoted', $3, 'A preview', 'feature', $4) RETURNING *`, [a.id, author.id, ++seq, head])).rows[0];
  const previewOf = (s) => instance('preview', `session:${s.id}`);

  await t.test('the web side reads a build under way from the row while the workflow process builds it', async () => {
    const a = await app();
    const s = await promoted(a, SHA('a'));
    await procs.arm(pool, cloneOf(a));
    const sent = await platform.submitRevision({ sessionId: s.id, appId: a.id, head: SHA('a'), source: 'test', trigger: 'commit-push' });
    assert.equal(sent.status, 'accepted');
    try {
      await procs.reached(pool, cloneOf(a));
      const { rows: [row] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id]);
      assert.deepEqual([row.check_state, row.check_phase, row.checks_commit_sha], ['pending', 'building', SHA('a')]);
      assert.equal(require('../src/services/staging').previewDisplayState(row).preview_state, 'building',
        'building, read on the web side from the row the workflow process wrote');
      await procs.until(() => heard.some((e) => e.k === 'session' && e.r?.sessionId === s.id && e.d?.event === 'checks_ready'
        && e.d.checkPhase === 'building'), 'browsers to hear it');
    } finally {
      await procs.release(pool, cloneOf(a));
    }
    await procs.until(async () => (await previewOf(s)).state === 'failed', 'the failed build to be recorded');
    const { rows: [row] } = await pool.query('SELECT check_state, checks_commit_sha FROM chat_sessions WHERE id = $1', [s.id]);
    assert.deepEqual({ ...row }, { check_state: 'error', checks_commit_sha: SHA('a') });
  });

  await t.test('a preview build killed in the middle is resumed by the next process, and ends as an uninterrupted one', async () => {
    const a = await app();
    const s = await promoted(a, SHA('b'));
    await procs.arm(pool, cloneOf(a));
    await platform.submitRevision({ sessionId: s.id, appId: a.id, head: SHA('b'), source: 'test', trigger: 'commit-push' });
    await procs.reached(pool, cloneOf(a));
    await workflow.kill();
    const { rows: [mid] } = await pool.query('SELECT check_phase FROM chat_sessions WHERE id = $1', [s.id]);
    assert.equal(mid.check_phase, 'building', 'still building with no process at all: the next one builds it');
    await procs.arm(pool, cloneOf(a));
    await procs.expireLeases(pool);
    await startWorkflow();
    try {
      await procs.reached(pool, cloneOf(a));
      assert.equal(await ranIn('preview', `session:${s.id}`, 'preview.prepare'), 2, 'the build the crash interrupted, run by the next process');
    } finally {
      await procs.release(pool, cloneOf(a));
    }
    await procs.until(async () => (await previewOf(s)).state === 'failed', 'the failed build to be recorded');
    const i = await previewOf(s);
    assert.deepEqual([i.data.streak, i.data.last], [1, 1], 'one attempt, failed once: as without the crash');
  });

  // ── The proposal lifecycle ──────────────────────────────────────────
  // A promote and a close appended by the web side, decided and done in the
  // workflow process; and each killed in the middle.
  const underway = async (a, owner) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title, reviewed_head_sha)
     VALUES ($1, $2, 'active', 'feature', $3, 'A change', $4) RETURNING *`, [a.id, owner.id, ++seq, SHA('a')])).rows[0];
  const proposalOf = (s) => instance('proposal', `session:${s.id}`);
  const statusOf = async (s) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [s.id])).rows[0].status;
  async function promoteThrough({ crash } = {}) {
    const a = await app();
    const owner = await user();
    const s = await underway(a, owner);
    if (crash) await procs.arm(pool, 'github.ready.done');
    const reply = await platform.promoteProposal({ sessionId: s.id, appId: a.id, userId: owner.id, username: owner.username,
      from: 'active', cap: 5, pr: null, waitMs: crash ? 200 : 20000 });
    if (crash) {
      assert.equal(reply.status, 202, 'still going up for a vote when GitHub has not answered');
      await procs.reached(pool, 'github.ready.done');
      assert.equal(await statusOf(s), 'active', 'never promoted while its pull request is still a draft');
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    } else {
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    }
    await procs.until(async () => (await proposalOf(s))?.state === 'in_review', 'the proposal to be in review');
    return {
      status: await statusOf(s),
      readied: (await procs.effects(pool, 'github.ready')).filter((e) => e.data.number === s.pr_number).length,
      line: (await pool.query(`SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [s.id]))
        .rows.map((r) => r.content.replace(/proc_\d+/, 'someone').replace(/#\d+/, '#N')),
      checked: (await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = 'preview' AND key = $1 AND type = 'RevisionSubmitted'`,
        [`session:${s.id}`])).rows[0].n,
      processes: await ranIn('proposal', `session:${s.id}`, 'review.open'),
    };
  }

  await t.test('proposal: a promote from the web side goes up for a vote, GitHub moved and the review opened in the workflow process', async () => {
    const r = await promoteThrough();
    assert.deepEqual({ ...r, processes: undefined }, {
      status: 'promoted', readied: 1, line: ['someone promoted PR #N: A change for voting'], checked: 1, processes: undefined,
    });
    assert.equal(r.processes, 1);
  });

  await t.test('proposal, restarted: killed while going up for a vote, after GitHub readied the PR; the next process ends it as an uninterrupted one', async () => {
    const r = await promoteThrough({ crash: true });
    assert.equal(r.processes, 2, 'the review the crash interrupted, opened by the next process');
    assert.deepEqual({ ...r, processes: undefined }, {
      status: 'promoted', readied: 1, line: ['someone promoted PR #N: A change for voting'], checked: 1, processes: undefined,
    }, 'readied once, opened once: as without the crash');
  });

  async function closeThrough({ crash } = {}) {
    const a = await app();
    const s = await underway(a, author);
    if (crash) await procs.arm(pool, 'github.closePR');
    const out = await platform.closeProposal({ sessionId: s.id, appId: a.id, reason: 'manual', from: 'active', userId: author.id,
      username: author.username, source: { kind: 'route', name: 'archive' } });
    assert.equal(out.status, 'accepted');
    assert.equal(await statusOf(s), 'archived', 'closed in the move\'s own transaction');
    if (crash) {
      await procs.reached(pool, 'github.closePR');
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => await settled('proposal', `session:${s.id}`, 'pr.close')
      && await settled('proposal', `session:${s.id}`, 'worker.destroy')
      && (await instance('preview', `session:${s.id}`))?.state === 'retired', 'everything the close owes');
    return {
      status: await statusOf(s),
      closed: (await procs.effects(pool, 'github.closePR')).filter((e) => e.data.number === s.pr_number).length,
      destroyed: (await procs.effects(pool, 'worker.destroy')).some((e) => e.data.name === `usernode-worker-${s.id}`),
      preview: (await instance('preview', `session:${s.id}`)).state,
      processes: await ranIn('proposal', `session:${s.id}`, 'pr.close'),
    };
  }

  await t.test('proposal: a close from the web side, its PR, worker and preview done in the workflow process', async () => {
    const r = await closeThrough();
    assert.deepEqual(r, { status: 'archived', closed: 1, destroyed: true, preview: 'retired', processes: 1 });
  });

  await t.test('proposal, restarted: killed right after a close committed; the next process closes the PR, destroys the worker, retires the preview (bug 14)', async () => {
    const r = await closeThrough({ crash: true });
    assert.deepEqual(r, { status: 'archived', closed: 1, destroyed: true, preview: 'retired', processes: 2 });
  });

  // ── The merge (step 6) ──────────────────────────────────────────────
  // A vote's ask, appended by the web side to the app's merge queue; the
  // queue's pick, the gate, the claim under the lock and GitHub's merge all
  // in the workflow process; and the same killed after GitHub merged, before
  // its answer (merge trace bug 1).
  // Its preview serves the head its checks passed on, so a release that
  // hands the preview machine the vote-backed rows it does not hold
  // (platform.ts restPreviews) adopts it as it stands, building nothing.
  const inReview = async (a) => {
    const s = (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title, reviewed_head_sha, promoted_at,
                                  check_state, checks_commit_sha, integration_merges_clean,
                                  staging_url, staging_runtime_kind, staging_runtime_name, staging_commit_sha)
       VALUES ($1, $2, 'promoted', 'feature', $3, 'A change', $4, NOW() - interval '1 day', 'passing', $4, TRUE,
               'https://preview.test', 'kubernetes', $5, $4) RETURNING *`,
      [a.id, author.id, ++seq, SHA('a'), `sv-preview-${a.id}-s${seq}`])).rows[0];
    const voter = await user();
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch) VALUES ($1, $2, 'yes', $3, 0)`,
      [s.id, voter.id, SHA('a')]);
    return s;
  };
  async function mergeThrough({ crash } = {}) {
    const a = await app({ selfHosted: true });
    const s = await inReview(a);
    if (crash) await procs.arm(pool, 'github.merge.done');
    await platform.wantMerge({ appId: a.id, sessionId: s.id, reason: 'vote' });
    if (crash) {
      await procs.reached(pool, 'github.merge.done');
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await instance('merge-followups', `session:${s.id}`))?.state === 'delivering', 'the merge recorded');
    await procs.until(async () => (await proposalOf(s))?.state === 'merged', 'the proposal merged');
    return {
      status: await statusOf(s),
      merges: (await procs.effects(pool, 'github.merge')).filter((e) => e.data.number === s.pr_number).map((e) => e.data.head),
      gates: (await procs.effects(pool, 'merge.gate')).filter((e) => e.data.sessionId === s.id).length,
      processes: await ranIn('proposal', `session:${s.id}`, 'merge.attempt'),
      queue: (await instance('merge-queue', `app:${a.id}`)).state,
    };
  }

  await t.test('merge: a vote asks from the web side; the queue, the gate, the claim and GitHub\'s merge run in the workflow process', async () => {
    const r = await mergeThrough();
    assert.deepEqual(r, { status: 'merged', merges: [SHA('a')], gates: 1, processes: 1, queue: 'idle' });
  });

  await t.test('merge, restarted: killed after GitHub merged, before its answer; the next process reads the PR first and never asks twice (bug 1)', async () => {
    const r = await mergeThrough({ crash: true });
    assert.equal(r.processes, 2, 'the attempt the crash interrupted, finished by the next process');
    assert.deepEqual({ ...r, processes: undefined }, { status: 'merged', merges: [SHA('a')], gates: 1, processes: undefined, queue: 'idle' },
      'merged once, at its head: as without the crash');
  });

  // A sync with main, asked from the web side (a person's "Sync with main"),
  // run in the workflow process; and killed in its turn: the next process
  // carries it on (its once-record never strands it, bug 9).
  async function syncThrough({ crash } = {}) {
    const a = await app();
    const s = await inReview(a);
    if (crash) await procs.arm(pool, 'sync.turn');
    const out = await platform.requestSync({ sessionId: s.id, appId: a.id, reason: 'person', userId: author.id });
    assert.equal(out.status, 'accepted', JSON.stringify(out));
    if (crash) {
      await procs.reached(pool, 'sync.turn');
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await proposalOf(s))?.data?.lastSync?.outcome === 'clean', 'the sync ended');
    const i = await proposalOf(s);
    return { sync: i.data.sync, outcome: i.data.lastSync.outcome, processes: await ranIn('proposal', `session:${s.id}`, 'branch.sync') };
  }

  await t.test('sync with main: asked from the web side, run in the workflow process', async () => {
    assert.deepEqual(await syncThrough(), { sync: null, outcome: 'clean', processes: 1 });
  });

  await t.test('sync with main, restarted: killed in its turn; the next process carries it to its end (bug 10)', async () => {
    assert.deepEqual(await syncThrough({ crash: true }), { sync: null, outcome: 'clean', processes: 2 });
  });

  // A person's Stop pressed on the web side while the workflow process is
  // spinning the sync's turn up (before any turn record exists): it reaches
  // the proposal machine, which ends the sync as stopped by them (never a
  // conflict) and stops its turn by its record (trace L24, L25, L28).
  await t.test('sync with main: a Stop pressed on the web side while the workflow process spins its turn up ends it as stopped', async () => {
    const a = await app();
    const s = await inReview(a);
    await procs.arm(pool, 'sync.turn');
    const out = await platform.requestSync({ sessionId: s.id, appId: a.id, reason: 'person', userId: author.id });
    assert.equal(out.status, 'accepted', JSON.stringify(out));
    await procs.reached(pool, 'sync.turn');
    const stop = await platform.stopWorkflowTurn({ sessionId: s.id, by: author.username });
    assert.equal(stop?.body?.stopped, true, JSON.stringify(stop));
    assert.equal(stop.body.machine, 'proposal');
    await procs.release(pool, 'sync.turn');
    await procs.until(async () => (await proposalOf(s))?.data?.lastSync?.outcome === 'stopped', 'the sync ended stopped');
    const i = await proposalOf(s);
    assert.equal(i.data.sync, null);
    assert.match(i.data.lastSync.message, /stopped by/);
    await procs.until(() => heard.some((e) => e.d?.type === 'session_update' && e.d.action === 'sync_status'
      && e.d.sessionId === s.id && e.d.syncResult === 'stopped'), 'the change page to hear its sync stopped');
    await procs.until(() => settled('proposal', `session:${s.id}`, 'turn.stop'), 'its turn was stopped');
    // What the cancelled sync reported afterwards changed nothing.
    assert.equal((await proposalOf(s)).data.lastSync.outcome, 'stopped');
  });

  // ── The Homeroom bot's loop (bot-request, bot-lane) ─────────────────
  const botUser = async () => {
    const { rows: [b] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE)
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE RETURNING id`);
    return b;
  };
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live')
                     ON CONFLICT (key) DO UPDATE SET value = 'live'`);
  const bot = await botUser();
  async function lookThrough({ crash = false } = {}) {
    const a = await app();
    const n = 1;
    await procs.arm(pool, 'bot.look');
    // A person asks on the web side (enqueueFront's append): the request's
    // instance takes it, and the lane, in the workflow process, grants it.
    await platform.botOwed(pool, { appId: a.id, issueNumber: n, reason: 'dm_answer', priority: 0, requestedBy: author.id, key: `ask-${a.id}` });
    await procs.reached(pool, 'bot.look');
    if (crash) {
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow();
      await procs.reached(pool, 'bot.look');
    }
    await procs.release(pool, 'bot.look');
    await procs.until(async () => (await instance('bot-request', `request:${a.id}:${n}`))?.state === 'idle', 'the look ended');
    return {
      state: (await instance('bot-request', `request:${a.id}:${n}`)).state,
      row: (await pool.query('SELECT 1 FROM homeroom_bot_queue WHERE app_id = $1', [a.id])).rows.length,
      looks: (await procs.effects(pool, 'bot.look')).filter((e) => e.data.appId === a.id).length,
      processes: await ranIn('bot-request', `request:${a.id}:${n}`, 'bot.look'),
    };
  }

  await t.test('bot loop: an ask from the web side is granted and looked at in the workflow process', async () => {
    assert.deepEqual(await lookThrough(), { state: 'idle', row: 0, looks: 1, processes: 1 });
  });

  await t.test('bot loop, restarted: killed mid-look; the next process carries the look on, granted once (trace L1, L3, L15)', async () => {
    assert.deepEqual(await lookThrough({ crash: true }), { state: 'idle', row: 0, looks: 2, processes: 2 });
  });

  await t.test('bot loop: a Stop pressed on the web side ends a look running in the workflow process', async () => {
    const a = await app();
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'main', 'paused') RETURNING id`, [a.id, bot.id]);
    await procs.arm(pool, 'bot.look');
    await platform.botOwed(pool, { appId: a.id, issueNumber: 2, reason: 'dm_answer', priority: 0, key: `ask-stop-${a.id}` });
    await procs.reached(pool, 'bot.look');
    const stop = await platform.stopWorkflowTurn({ sessionId: s.id, by: author.username });
    assert.equal(stop?.body?.machine, 'bot-request', JSON.stringify(stop));
    await procs.until(async () => (await instance('bot-request', `request:${a.id}:2`))?.state === 'idle', 'the look stopped');
    await procs.release(pool, 'bot.look');
    await procs.until(() => settled('bot-request', `request:${a.id}:2`, 'turn.stop'), 'its turn was stopped');
    assert.equal((await pool.query('SELECT 1 FROM homeroom_bot_queue WHERE app_id = $1', [a.id])).rows.length, 0, 'nothing owed after');
  });

  // ── What the workflow process's boot gives it (src/workflow/setup.ts) ─

  await t.test('a merge decided in the workflow process owes a badge to everyone it told, in its own transaction, which the sender drains', async () => {
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    const voter = await user();
    await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'pr_proposed')`, [voter.id, a.id, s.id]);
    await reportMerge({ sessionId: s.id, appId: a.id, mergeSha: SHA('9') });
    // The row is the transition's (platform.ts publishPushes): it outlives
    // a restart of either process, and is drained where the sender runs.
    await procs.until(async () => (await pool.query('SELECT 1 FROM mobile_push_badge_syncs WHERE user_id = $1', [voter.id])).rowCount === 1,
      'the badge owed');
    const { MobilePushWorker } = require('../src/services/mobile-push-worker');
    const synced = [];
    const worker = new MobilePushWorker({ pool, config: { mobilePushEnabled: true }, provider: {},
      badges: { debounceMs: 0, async syncUser(id) { synced.push(id); return 1; } } });
    worker.stopping = false;
    await worker.drainBadges();
    assert.ok(synced.includes(voter.id), 'synced once drained');
    assert.equal((await pool.query('SELECT 1 FROM mobile_push_badge_syncs WHERE user_id = $1', [voter.id])).rowCount, 0, 'and the row goes');
  });


  // The board change rides the push (pushes.ts boardMoved), which every web
  // process relays and hands to its Workshop listener (services/ws.js
  // _onBusMessage, pinned in tests/ws-workflow-relay.test.js): this test
  // process stands for the web side, its bus listener the relay's.
  await t.test('the Workshop hears a board change decided in the workflow process', async () => {
    const a = await app();
    const issue = await closeProposal(a, 77);
    await platform.fileProposal(issue.id, a.id);
    await platform.voteOnProposal({ ...issue, status: 'open' }, await user(), { vote: 'up', reason: null });
    const pushed = await procs.until(async () => heard.find((e) => e.k === 'scoped' && e.r?.boardChange === true && e.r.appId === a.id),
      'the board change, on the push the web side relays', 5000);
    assert.equal(pushed.d.type, 'issue_update');
    // Every process that relays the bus acts on it (its row lease makes that
    // safe), the conductor's own relay too: nothing runs after a commit but
    // the push itself (a machine has no notifiers).
  });

  // ── App delivery: the deploy and its "deploying" state ──────────────
  // A deploy here stops at its clone (`github.clone`), which then fails:
  // what these show is where the state lives, not a deploy that succeeds.
  const deployRow = async (a) => (await pool.query(
    'SELECT deploy_state, deploy_started_at, deploy_from_sha FROM apps WHERE id = $1', [a.id])).rows[0];
  const deploying = async (a) => require('../src/services/app-deploy-status').read(a.slug, await deployRow(a))?.deploying === true;

  await t.test('the version pill reads "deploying" while the workflow process deploys a merge', async () => {
    const a = await app();
    const s = await proposal(a);
    await procs.arm(pool, cloneOf(a));
    await reportMerge({ sessionId: s.id, appId: a.id, mergeSha: SHA('d') });
    try {
      await procs.reached(pool, cloneOf(a));
      await procs.until(async () => deploying(a), 'the row to say the deploy is under way');
      await procs.until(() => heard.some((e) => e.k === 'global' && e.d?.type === 'app_redeploy_status' && e.d.appSlug === a.slug
        && e.d.deploying === true), 'browsers to hear it started');
    } finally {
      await procs.release(pool, cloneOf(a));
    }
  });

  // ── A maintenance campaign: its change and its proposal ─────────────
  // Run with a workflow process whose model is the fixture's script.
  const MODEL = { WF_FAKE_MODEL: '1' };
  async function campaignThrough({ crashAt } = {}) {
    await workflow.stop();
    await startWorkflow(MODEL);
    // The fleet: one app, and the campaign proposed on the platform's own app
    // and applied by an admin from the web side; the apply inserts its row and
    // starts it (the apply is pinned in the governance suite).
    // (Its slug filter names only its own app.)
    const models = (await procs.effects(pool, 'llm.call')).length;
    const self = (await pool.query(`SELECT * FROM apps WHERE self_hosted = TRUE LIMIT 1`)).rows[0] || await app({ selfHosted: true });
    const target = await app();
    // A second app the model finds nothing to change in.
    const { rows: [skipped] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, status) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text, 'running')
       RETURNING *`, [`skip-${++seq}`, author.id]);
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [target.id]);
    const { rows: [issue] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Maintenance campaign: JWT', 'maintenance_campaign', $2, $3)
       RETURNING *`, [self.id, JSON.stringify({ title: 'JWT', instructions: 'Use the public key', targetFilter: [target.slug, skipped.slug] }), author.id]);
    const { rows: [adminUser] } = await pool.query(
      `INSERT INTO users (username, password, is_admin, has_platform_access) VALUES ($1, 'x', TRUE, TRUE) RETURNING id, username`,
      [`campaign_admin_${++seq}`]);
    await platform.fileProposal(issue.id, self.id);
    if (crashAt) await procs.arm(pool, crashAt);
    // The web side asks; the workflow process decides and works.
    const applied = await platform.adminApplyProposal({ ...issue, status: 'open' }, adminUser);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const c = await procs.until(async () => (await pool.query('SELECT id FROM maintenance_campaigns WHERE issue_id = $1', [issue.id])).rows[0],
      'the campaign\'s row, inserted by the apply');
    if (crashAt) {
      await procs.reached(pool, crashAt);
      await workflow.kill();
      await procs.expireLeases(pool);
      await startWorkflow(MODEL);
    }
    await procs.until(async () => (await instance('campaign', `campaign:${c.id}`))?.state === 'done', 'the campaign done');
    const { rows: [r] } = await pool.query(
      `SELECT mca.state, cs.status, cs.reviewed_head_sha FROM maintenance_campaign_apps mca JOIN chat_sessions cs ON cs.id = mca.session_id
        WHERE mca.campaign_id = $1 AND mca.app_id = $2`, [c.id, target.id]);
    const skip = (await pool.query('SELECT state FROM maintenance_campaign_apps WHERE campaign_id = $1 AND app_id = $2', [c.id, skipped.id])).rows[0].state;
    const repo = `acme/${target.slug}`;
    const out = {
      row: r.state, status: r.status, skip,
      prs: (await procs.effects(pool, 'github.createPR')).filter((e) => e.data.repo === repo).length,
      pushes: (await procs.effects(pool, 'github.push')).filter((e) => e.data.repo === repo).length,
      head: r.reviewed_head_sha === (await procs.effects(pool, 'github.push')).filter((e) => e.data.repo === repo).pop()?.data.sha,
      // The model's runs for the changed app (the skipped one asks it once).
      models: (await procs.effects(pool, 'llm.call')).length - models - 1,
      processes: await ranIn('campaign', `campaign:${c.id}`, 'campaign.change'),
    };
    await workflow.stop();
    await startWorkflow();
    return out;
  }

  await t.test('campaign: started from the web side, the change, its PR and its promote run in the workflow process', async () => {
    const r = await campaignThrough();
    assert.deepEqual(r, { row: 'pr_open', status: 'promoted', skip: 'skipped', prs: 1, pushes: 1, head: true, models: 1, processes: 1 });
  });

  await t.test('campaign, restarted: killed while the AI works on the change; the next process makes it again, and opens one PR', async () => {
    const r = await campaignThrough({ crashAt: 'llm.call' });
    assert.equal(r.processes, 2);
    assert.deepEqual({ ...r, processes: undefined }, { row: 'pr_open', status: 'promoted', skip: 'skipped', prs: 1, pushes: 1, head: true,
      models: 2, processes: undefined }, 'the AI again (nothing reached GitHub), one push, one PR');
  });

  await t.test('campaign, restarted: killed after the change was pushed, before its PR; the next process pushes nothing again', async () => {
    const r = await campaignThrough({ crashAt: 'github.findPR' });
    assert.equal(r.processes, 2);
    assert.deepEqual({ ...r, processes: undefined }, { row: 'pr_open', status: 'promoted', skip: 'skipped', prs: 1, pushes: 1, head: true,
      models: 1, processes: undefined }, 'the push checkpointed: no AI, no push again');
  });

  await t.test('campaign, restarted: killed after GitHub opened the change\'s PR, before its answer; the next process opens no second one (bug 1)', async () => {
    const r = await campaignThrough({ crashAt: 'github.createPR.done' });
    assert.equal(r.processes, 2, 'the change the crash interrupted, finished by the next process');
    assert.deepEqual({ ...r, processes: undefined }, { row: 'pr_open', status: 'promoted', skip: 'skipped', prs: 1, pushes: 1, head: true, models: 1, processes: undefined },
      'one model run, one push, one PR, one proposal: as without the crash (the push was checkpointed)');
  });

  await t.test('app delivery, restarted: a deploy asked while the workflow process is down is run, and reads deploying through a crash', async () => {
    const a = await app();
    await workflow.kill();
    // The admin's Redeploy, on the web side, with no workflow process running.
    await platform.requestDeploy(a.id, 'redeploy');
    await procs.arm(pool, cloneOf(a));
    await startWorkflow();
    await procs.reached(pool, cloneOf(a));
    assert.equal(await deploying(a), true);
    // Killed in the middle of the deploy: nothing says it ended.
    await workflow.kill();
    assert.equal(await deploying(a), true, 'still deploying with no process at all: the next one runs it again');
    await procs.arm(pool, cloneOf(a));
    await procs.expireLeases(pool);
    await startWorkflow();
    try {
      await procs.reached(pool, cloneOf(a));
      assert.equal(await ranIn('app-delivery', `app:${a.id}`, 'app.deploy'), 2, 'the deploy the crash interrupted, run by the next process');
    } finally {
      await procs.release(pool, cloneOf(a));
    }
  });

  // ── The Homeroom bot's replies (bot-voice, bot-dm) ──────────────────
  // What a person writes is an event in the statement or transaction that
  // stores it, on the web side; the turn that answers runs in the workflow
  // process, and a crash in the settle window or in the model's call still
  // ends in one reply.
  const replyBot = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE)
     ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE RETURNING id, username`)).rows[0];
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const settleNow = async (key) => {
    const cx = await pool.connect();
    try {
      await cx.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await cx.query(`UPDATE wf_instances SET deadline_at = now() WHERE machine = 'bot-voice' AND key = $1 AND deadline_at IS NOT NULL`, [key]);
      await cx.query(`SELECT pg_notify('wf_timer', (EXTRACT(EPOCH FROM now()) * 1000)::bigint::text)`);
      await cx.query('COMMIT');
    } finally { cx.release(); }
  };
  const botReplies = async (a, thread) => (await pool.query(
    `SELECT content FROM chat_messages WHERE app_id = $1 AND user_id = $2 AND thread_type = 'message' AND thread_ref = $3 ORDER BY id`,
    [a.id, replyBot.id, thread])).rows.map((r) => r.content);
  async function mentionInChat({ crashAt } = {}) {
    const a = await app();
    const person = await user();
    // On the web side: the message and its Heard event in one statement.
    const [row] = await platform.insertHeard(pool,
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, $3, 'message', '{}', NULL, NULL) RETURNING id, created_at`,
      [a.id, person.id, '@Homeroom bot can you add a dark mode?'], { appId: a.id, thread: null });
    const key = `place:${a.id}:chat:`;
    await procs.until(async () => (await instance('bot-voice', key))?.state === 'settling', 'the place to settle');
    if (crashAt === 'settling') {
      // Killed while the place settles: nothing but the instance knows the
      // reply is owed. The next process's timer asks for the turn.
      await workflow.kill();
      await startWorkflow();
    }
    if (crashAt === 'bot.model') await procs.arm(pool, 'bot.model');
    await settleNow(key);
    if (crashAt === 'bot.model') {
      await procs.reached(pool, 'bot.model');
      await workflow.kill();
      await procs.release(pool, 'bot.model');
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await instance('bot-voice', key))?.state === 'quiet' && (await botReplies(a, row.id)).length,
      'the bot to answer in a reply thread');
    return {
      replies: await botReplies(a, row.id),
      state: (await instance('bot-voice', key)).state,
      through: (await instance('bot-voice', key)).data.through === row.id,
      models: (await pool.query(`SELECT count(*)::int AS n FROM homeroom_bot_voice_turns WHERE place_key = $1 AND finished_at IS NOT NULL`, [`${a.id}:chat:`])).rows[0].n > 0,
    };
  }

  let voiceUninterrupted;
  await t.test('bot voice: a mention stored on the web side is answered by a turn in the workflow process', async () => {
    voiceUninterrupted = await mentionInChat();
    assert.deepEqual(voiceUninterrupted.replies, ['Here is my answer in the place.']);
    assert.equal(voiceUninterrupted.state, 'quiet');
    assert.equal(voiceUninterrupted.through, true, 'read through the message it answered');
  });

  await t.test('bot voice, restarted: killed while the place settles; the next process answers it (bug 1)', async () => {
    assert.deepEqual(await mentionInChat({ crashAt: 'settling' }), voiceUninterrupted, 'one reply, as without the crash');
  });

  await t.test('bot voice, restarted: killed in the turn\'s model call; the next process answers once', async () => {
    assert.deepEqual(await mentionInChat({ crashAt: 'bot.model' }), voiceUninterrupted, 'one reply, as without the crash');
  });

  const conversationsSvc = require('../src/services/conversations');
  const dmAnswers = async (conversationId, messageId) => (await pool.query(
    `SELECT content, idempotency_key FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND reply_to_id = $3 ORDER BY id`,
    [conversationId, replyBot.id, messageId])).rows;
  async function dmToTheBot({ crashAt } = {}) {
    const person = { ...(await user()), hasPlatformAccess: true };
    const opened = await conversationsSvc.ensureAdmittedDirect(pool, replyBot.id, person.id);
    if (crashAt === 'down') await workflow.kill();
    if (crashAt === 'bot.model') await procs.arm(pool, 'bot.model');
    // On the web side: the message, and the answer it is owed, in one
    // transaction (what routes/conversations.js does).
    const sent = await conversationsSvc.sendMessage(pool, person, opened.conversationId, { content: 'what are you working on for me?' }, {
      afterInsert: (db, m) => require('../src/services/homeroom-bot-dm').heardInDm(db, {
        user: person, conversationId: opened.conversationId, messageId: m.messageId, membership: m.membership, memberIds: m.memberIds,
      }),
    });
    if (crashAt === 'down') await startWorkflow();
    if (crashAt === 'bot.model') {
      await procs.reached(pool, 'bot.model');
      await workflow.kill();
      await procs.release(pool, 'bot.model');
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    const key = `person:${person.id}`;
    await procs.until(async () => (await instance('bot-dm', key))?.state === 'idle' && (await dmAnswers(opened.conversationId, sent.messageId)).length,
      'the bot to answer the DM');
    return {
      answers: (await dmAnswers(opened.conversationId, sent.messageId)).map((r) => [r.content, r.idempotency_key.replace(/\d+/, 'N')]),
      state: (await instance('bot-dm', key)).state,
    };
  }

  let dmUninterrupted;
  await t.test('bot DM: a message sent on the web side is answered in the workflow process', async () => {
    dmUninterrupted = await dmToTheBot();
    assert.deepEqual(dmUninterrupted.answers, [['Here is my answer in the DM.', 'hrbot-mayor-N']]);
    assert.equal(dmUninterrupted.state, 'idle');
  });

  await t.test('bot DM: a message sent while no workflow process runs is answered once one does (bugs 9-10)', async () => {
    assert.deepEqual(await dmToTheBot({ crashAt: 'down' }), dmUninterrupted);
  });

  await t.test('bot DM, restarted: killed in the answer\'s model call; the next process answers once (bug 10)', async () => {
    assert.deepEqual(await dmToTheBot({ crashAt: 'bot.model' }), dmUninterrupted, 'one answer, under its key, as without the crash');
  });

  // ── Main check: the unit suite on each new main ─────────────────────
  const checkKey = (a) => `app:${a.id}`;
  const mainCheckOf = async (a) => (await pool.query(
    'SELECT main_check_state AS state, main_check_sha AS sha, main_check_paused_sha AS paused FROM apps WHERE id = $1', [a.id])).rows[0];
  const suiteRuns = async (a) => (await procs.effects(pool, 'main.suite')).filter((e) => e.data.appId === a.id);
  async function mergeIsChecked({ crashAt } = {}) {
    const a = await app();
    const s = await proposal(a);
    if (crashAt) await procs.arm(pool, crashAt);
    await reportMerge({ sessionId: s.id, appId: a.id, mergeSha: SHA('6') });
    if (crashAt) {
      await procs.reached(pool, crashAt);
      await workflow.kill();
      await procs.release(pool, crashAt);
      await procs.expireLeases(pool);
      await startWorkflow();
    }
    await procs.until(async () => (await mainCheckOf(a)).state === 'passing', 'the merge commit\'s suite to pass');
    const { rows: [w] } = await pool.query(
      `SELECT attempt_count, lost_attempts, checkpoint FROM wf_work WHERE machine = 'main-check' AND key = $1 AND kind = 'main.suite'`, [checkKey(a)]);
    return {
      row: await mainCheckOf(a),
      state: (await instance('main-check', checkKey(a))).state,
      verdicts: (await pool.query('SELECT sha, state FROM main_watch_verdicts WHERE app_id = $1', [a.id])).rows,
      runs: (await suiteRuns(a)).map((e) => ({ resumeRunId: e.data.resumeRunId, here: e.pid === process.pid })),
      work: w, app: a,
      processes: await ranIn('main-check', checkKey(a), 'main.suite'),
    };
  }

  await t.test('main check: a merge from the web side gets its main check decided and run in the workflow process', async () => {
    const got = await mergeIsChecked();
    assert.deepEqual(got.row, { state: 'passing', sha: SHA('6'), paused: null });
    assert.equal(got.state, 'idle');
    assert.deepEqual(got.verdicts, [{ sha: SHA('6'), state: 'passing' }]);
    assert.deepEqual(got.runs, [{ resumeRunId: null, here: false }], 'one run, in the workflow process');
    assert.equal(got.processes, 1);
  });

  await t.test('main check, restarted: killed mid-suite, the next process carries the run on from the run id it kept', async () => {
    const got = await mergeIsChecked({ crashAt: 'main.suite' });
    assert.deepEqual(got.row, { state: 'passing', sha: SHA('6'), paused: null }, 'a verdict, where the old work item ended with none');
    assert.deepEqual(got.verdicts, [{ sha: SHA('6'), state: 'passing' }]);
    const runId = `run-${got.app.id}-${SHA('6').slice(0, 8)}`;
    assert.deepEqual(got.runs.map((r) => r.resumeRunId), [null, runId], 'the second attempt adopts the first one\'s run');
    assert.equal(got.processes, 2);
    assert.deepEqual([got.work.attempt_count, got.work.lost_attempts, got.work.checkpoint], [2, 1, { runId }],
      'the attempt lost with its process is not one of its tries');
  });

  await t.test('main check: a new main the drift poller saw, and an admin\'s Resume, from the web side', async () => {
    const a = await app();
    await platform.requestMainCheck({ appId: a.id, sha: SHA('7') });
    await procs.until(async () => (await mainCheckOf(a)).state === 'passing', 'the new main\'s suite to pass');
    assert.equal((await mainCheckOf(a)).sha, SHA('7'));
    // A pause an older release left: lifted by the instance the Resume makes.
    const b = await app();
    await pool.query(`UPDATE apps SET main_check_state = 'failing', main_check_sha = $2, main_check_paused_sha = $2, main_check_at = now(),
                             main_check_detail = '{}'::jsonb WHERE id = $1`, [b.id, SHA('8')]);
    assert.equal(await platform.resumeMainCheck(b.id, { id: author.id, username: author.username }), 'resumed');
    assert.deepEqual(await mainCheckOf(b), { state: 'failing', sha: SHA('8'), paused: null });
    assert.equal(await platform.resumeMainCheck(b.id, { id: author.id, username: author.username }), 'not_paused');
  });

  // ── The conductor is the process production runs ───────────────────
  // What a process that only ran the workflow would lack, and these tests
  // could not see while their child was one: its own code's pushes (the
  // bus), its holds (its process row), its listener (the bot's platform
  // tools call this process's own port).
  await t.test('the conductor\'s own code reaches the web side over the bus, other processes see it, and it listens', async () => {
    const before = relayed.length;
    await dmToTheBot();
    const fromConductor = relayed.slice(before);
    assert.ok(fromConductor.some((e) => e.k === 'user'),
      `the DM's answer reaches the person's tabs through the bus (heard: ${[...new Set(fromConductor.map((e) => e.k))].join(', ') || 'nothing'})`);
    const { rows } = await pool.query(`SELECT role, state FROM platform_processes WHERE id LIKE $1`, [`%:${workflow.pid}:%`]);
    assert.deepEqual(rows, [{ role: 'conductor', state: 'serving' }], 'its row, so what it holds is seen elsewhere');
    const res = await fetch(`http://127.0.0.1:${workflow.port}/health`);
    assert.equal(res.status, 200, 'it listens on its own port');
  });

  // ── Two conductors at once ──────────────────────────────────────────
  await t.test('two conductors: every flow ends once, whichever runs it', async () => {
    second = await startConductor();
    const [govs, merged, dm, checked] = await Promise.all([
      Promise.all([closeByVote(301), closeByVote(302), closeByVote(303)]),
      mergeGoesLive(),
      dmToTheBot(),
      mergeIsChecked(),
    ]);
    for (const g of govs) {
      assert.equal(g.state, 'applied');
      assert.equal(g.closed, 1, 'closed once');
      assert.equal(g.comments.length, 1, 'commented once');
    }
    assert.deepEqual(merged.row, { status: 'merged', live: true });
    assert.deepEqual(dm, dmUninterrupted);
    assert.deepEqual(checked.verdicts, [{ sha: SHA('6'), state: 'passing' }]);
    assert.equal(checked.runs.length, 1, 'one suite run between them');
    // The release's adoptions ran once between them (the release machine).
    const { rows: releases } = await pool.query(
      `SELECT count(*)::int AS n FROM wf_work WHERE machine = 'release' AND kind = 'release.adopt' AND status = 'settled'`);
    assert.ok(releases[0].n >= 1);
  });

  await t.test('two conductors: one killed mid-item, the other carries it on', async () => {
    const a = await app();
    const s = await proposal(a);
    await procs.arm(pool, 'main.suite');
    await reportMerge({ sessionId: s.id, appId: a.id, mergeSha: SHA('9') });
    const pid = await procs.reached(pool, 'main.suite');
    const [dead, alive] = pid === workflow.pid ? [workflow, second] : [second, workflow];
    await dead.kill();
    await procs.release(pool, 'main.suite');
    await procs.expireLeases(pool);
    await procs.until(async () => (await mainCheckOf(a)).state === 'passing', 'the other conductor to finish the suite');
    const runs = await suiteRuns(a);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].pid, alive.pid, 'carried on by the one still running');
    if (dead === workflow) workflow = await startConductor(); else second = await startConductor();
  });
});
