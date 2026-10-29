'use strict';

// `proposal.commit` (services/proposal-commit-operation.js) against the real
// schema and kernel: a web runtime appends the request, a conductor runs it.
// SEC-09: a local agent's commit, from a CLI hand-off's upload or a local
// agent's build turn, is written on the conductor, never by the route's
// process. What is pinned here is where claims and locks matter:
//
//   - the commit, its record and the draft PR are steps, so a retry after a
//     lost reply commits once and opens one PR;
//   - a client asking again after its answer was lost is told the same head;
//   - authority revoked between attempts stops the retry before any write;
//   - a refused request leaves nothing behind (no commit, no record, no
//     files kept, no lock held);
//   - the hand-off's proposal lock orders the write after another writer's,
//     and the head the route expected is read again under it;
//   - a turn's lease is read again before its commit.
//
// Only the code host and the preview machine's hand-off are faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool, Client } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { platformOperation, MACHINE, WORK, operationKey, requested } = require('../src/workflow/platform-operation/machine.ts');
const { platformOperationServices } = require('../src/workflow/platform-operation/services.ts');
const { waitFor, within } = require('./lib/wait-for');

const SHA = (c) => String(c).repeat(40).slice(0, 40);
const BASE = SHA('0');
const BASE_TREE = SHA('1');

test('a local agent\'s commit is conductor work', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (e) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw e;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this check'); return;
  }
  const name = `proposal_commit_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
  const operations = require('../src/services/platform-operations');
  const { currentProposalBranchHead } = require('../src/routes/proposal-handoff');

  // The code host: a branch moved only from the head it was asked to build
  // on, that knows its own commit when it is asked again (as github.js and
  // hosted-git.js createProposalCommit do). Every call is recorded with the
  // process role that made it, and when.
  const host = { calls: [], branches: new Map(), next: 0 };
  const github = require('../src/services/github');
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'createProposalCommit', async (_o, _r, a) => {
    const call = { role: process.env.PROCESS_ROLE, branch: a.branchName, at: Date.now(), created: false };
    host.calls.push(call);
    const tip = host.branches.get(a.branchName);
    if (!tip) throw Object.assign(new Error('Not Found'), { status: 404 });
    const message = `${a.message}\n\nUsernode-Local-Commit: ${a.localCommitSha}`;
    if ((tip.sha === a.expectedRemoteParentSha || tip.parent === a.expectedRemoteParentSha)
        && tip.message === message && tip.tree === a.expectedTreeSha) {
      return { sha: tip.sha, treeSha: tip.tree, previousSha: tip.parent, localParentSha: a.localParentSha, created: false };
    }
    if (tip.sha !== a.expectedRemoteParentSha) throw Object.assign(new Error('moved'), { code: 'branch_moved' });
    if (tip.tree !== a.localParentTreeSha) throw Object.assign(new Error('parent tree'), { code: 'parent_tree_mismatch' });
    host.next += 1;
    const sha = String(host.next).padStart(40, 'c');
    host.branches.set(a.branchName, { sha, parent: tip.sha, message, tree: a.expectedTreeSha });
    call.created = true;
    return { sha, treeSha: a.expectedTreeSha, previousSha: tip.sha, localParentSha: a.localParentSha, created: true };
  });
  const commits = () => host.calls.filter((c) => c.created);
  // The draft PR, made on the host and recorded on the row.
  const prs = [];
  t.mock.method(require('../src/services/pr-metadata'), 'applyPrMetadata', async ({ pool: db, session }) => {
    prs.push({ role: process.env.PROCESS_ROLE, sessionId: session.id });
    const number = 800 + prs.length;
    await db.query('UPDATE chat_sessions SET pr_number = $2, pr_url = $3 WHERE id = $1',
      [session.id, number, `https://github.com/acme/demo/pull/${number}`]);
    Object.assign(session, { pr_number: number, pr_url: `https://github.com/acme/demo/pull/${number}` });
  });
  // The verdict cleared for the preview machine; `failNext` throws once,
  // after the record it follows has committed.
  const cleared = [];
  let clearFails = 0;
  t.mock.method(require('../src/services/preview-workflow'), 'clear', async ({ session, reason }) => {
    if (clearFails > 0) { clearFails -= 1; throw new Error('connection reset'); }
    cleared.push([Number(session.id), reason]);
  });

  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  const machine = platformOperation();
  const services = platformOperationServices({ pool, config: {} });
  const web = createRuntime({ pool, machines: [machine], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [machine], services, slots: 1 });
  const holder = new Client({ connectionString: String(url) });
  await holder.connect();
  t.after(async () => {
    await holder.end().catch(() => {});
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });

  let seq = 0;
  // A CLI hand-off on a project only its collaborators build, on a branch
  // at BASE.
  async function handoff() {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [`cw_${seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, repo_url, collab_visibility, view_visibility)
       VALUES ($1, $1, $2, 'running', 'https://github.com/acme/demo', 'invite', 'invite') RETURNING id`, [`cw-${seq}`, u.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [a.id, u.id]);
    const branch = `dev/cli-u${u.id}-req-${seq}`;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, handoff_base_sha)
       VALUES ($1, $2, 'active', 'cli_handoff', $3, $4) RETURNING id`, [a.id, u.id, branch, BASE]);
    host.branches.set(branch, { sha: BASE, parent: null, message: 'base', tree: BASE_TREE });
    return { userId: u.id, appId: a.id, sessionId: s.id, branch };
  }
  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  // What the upload route asks with: the head it builds on as the route
  // reads it, and the commit; the files are its payload.
  const upload = (h, n, { expectedParent = BASE, parentTreeSha = BASE_TREE } = {}) => ({
    appId: h.appId, userId: h.userId,
    input: {
      surface: 'handoff', sessionId: h.sessionId, branch: h.branch, repoUrl: 'https://github.com/acme/demo',
      expectedParent, localCommitSha: SHA(n.toString(16)), parentSha: SHA('a'), parentTreeSha, treeSha: SHA((n + 1).toString(16)),
      authoredAt: '2026-10-29T10:00:00Z', committedAt: '2026-10-29T10:00:01Z',
    },
    payload: { message: `Local change ${n}`, files: [{ path: 'src/a.js', mode: '100644', contentBase64: 'YQ==' }] },
  });
  async function ask(p) {
    const requestId = randomUUID();
    const request = { appId: p.appId, userId: p.userId, op: 'proposal.commit', input: p.input, requestId };
    requested(request);
    await operations.keepInput(pool, request, p.payload);
    const key = operationKey(request);
    await web.append(MACHINE, key, { type: 'Requested', payload: request }, {
      requestKey: requestId, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK },
    });
    return { key, requestId };
  }
  async function settle(rounds = 4) {
    process.env.PROCESS_ROLE = 'conductor';
    try {
      for (let i = 0; i < rounds; i += 1) {
        await conductor.drain(); await conductor.runServices(); await conductor.drain();
        await pool.query(`UPDATE wf_work SET due_at = NOW() WHERE machine = $1 AND status = 'queued'`, [MACHINE]);
      }
    } finally { process.env.PROCESS_ROLE = 'web'; }
  }
  const instance = async (key) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, key])).rows[0];
  const attempts = async (key) => (await pool.query('SELECT attempt_count FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, key])).rows[0].attempt_count;
  const kept = async (requestId) => (await pool.query('SELECT 1 FROM platform_operation_inputs WHERE request_id = $1', [requestId])).rowCount;
  // Advisory locks held in this test's database (the proposal lock is one).
  const locksHeld = async () => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
      WHERE l.locktype = 'advisory' AND d.datname = current_database()`)).rows[0].n;

  await t.test('an upload is committed, recorded and its draft PR opened by the conductor alone', async () => {
    const h = await handoff();
    const { key, requestId } = await ask(upload(h, 2));
    assert.equal(host.calls.length, 0, 'the web append writes nothing to the host');
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done');
    const head = host.branches.get(h.branch).sha;
    assert.deepEqual(done.data, {
      ok: true, surface: 'handoff', sessionId: h.sessionId, localCommitSha: SHA('2'), headSha: head, treeSha: SHA('3'),
      branch: h.branch, prNumber: 801, prUrl: 'https://github.com/acme/demo/pull/801', uploaded: true,
    });
    assert.deepEqual(commits().map((c) => c.role), ['conductor']);
    assert.deepEqual(prs.map((p) => p.role), ['conductor']);
    const r = await row(h.sessionId);
    assert.equal(r.handoff_uploaded_sha, head);
    assert.equal(r.handoff_local_commit_sha, SHA('2'));
    assert.equal(r.pr_number, 801);
    assert.deepEqual(cleared.at(-1), [h.sessionId, 'upload']);
    assert.equal(await kept(requestId), 0, 'its files are dropped once the commit is made');

    // The client asks again after its answer was lost: a new request, from
    // the head the route now reads, is told the same head and writes nothing.
    const before = { commits: commits().length, prs: prs.length, cleared: cleared.length };
    const again = await ask(upload(h, 2, { expectedParent: currentProposalBranchHead(await row(h.sessionId)) }));
    await settle();
    const retried = (await instance(again.key)).data;
    assert.equal(retried.ok, true);
    assert.equal(retried.headSha, head, 'the same head');
    assert.equal(retried.uploaded, false, 'answered 200, as it always was');
    assert.equal(retried.prNumber, 801);
    assert.deepEqual({ commits: commits().length, prs: prs.length, cleared: cleared.length }, before,
      'no second commit, no second PR, and the verdict is not cleared again');
    assert.equal(await locksHeld(), 0);
  });

  await t.test('a retry after its record was kept but its reply lost commits once and opens one PR', async () => {
    const h = await handoff();
    const before = { commits: commits().length, prs: prs.length };
    clearFails = 1;
    const { key } = await ask(upload(h, 4));
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done');
    assert.equal(done.data.ok, true, JSON.stringify(done.data));
    assert.equal(done.data.uploaded, true);
    assert.equal(await attempts(key), 2, 'the first attempt failed after its record committed');
    assert.equal(commits().length - before.commits, 1, 'one commit');
    assert.equal(prs.length - before.prs, 1, 'one PR');
    const r = await row(h.sessionId);
    assert.equal(r.handoff_uploaded_sha, host.branches.get(h.branch).sha);
    assert.deepEqual(cleared.at(-1), [h.sessionId, 'upload'], 'the retry finished its record');
  });

  await t.test('authority revoked between attempts stops the retry before any write, and leaves nothing behind', async () => {
    const h = await handoff();
    const before = host.calls.length;
    // The first attempt fails reading its files, before any write.
    const query = pool.query.bind(pool);
    let failed = false;
    t.mock.method(pool, 'query', async (sql, params) => {
      if (!failed && /SELECT payload FROM platform_operation_inputs/.test(String(sql))) {
        failed = true; throw new Error('connection reset');
      }
      return query(sql, params);
    });
    const { key, requestId } = await ask(upload(h, 6));
    process.env.PROCESS_ROLE = 'conductor';
    try { await conductor.drain(); await conductor.runServices(); } finally { process.env.PROCESS_ROLE = 'web'; }
    t.mock.method(pool, 'query', query);
    assert.equal(failed, true, 'the first attempt failed on its read');
    // The requester stops building here before the retry.
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [h.appId, h.userId]);
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done');
    assert.deepEqual(done.data, { ok: false, status: 404, error: 'Active handoff session not found' });
    assert.equal(host.calls.length, before, 'nothing reached the host');
    assert.equal(prs.filter((p) => p.sessionId === h.sessionId).length, 0);
    const r = await row(h.sessionId);
    assert.equal(r.handoff_uploaded_sha, null, 'nothing recorded');
    assert.equal(await kept(requestId), 0, 'its files are dropped');
    assert.equal(await locksHeld(), 0, 'no lock held');
  });

  await t.test('a request refused by the conductor leaves nothing behind', async () => {
    const h = await handoff();
    const before = host.calls.length;
    const { key, requestId } = await ask(upload(h, 8));
    // Archived between the route's check and the conductor's.
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [h.sessionId]);
    await settle();
    const done = (await instance(key)).data;
    assert.equal(done.status, 409);
    assert.equal(done.error, 'proposal_closed');
    assert.equal(host.calls.length, before);
    assert.equal((await row(h.sessionId)).handoff_uploaded_sha, null);
    assert.equal(await kept(requestId), 0);
    assert.equal(await locksHeld(), 0);
  });

  await t.test('the proposal lock orders the write after the writer holding it, and the head is read again under it', async () => {
    const { PROPOSAL_UPDATE_LOCK } = require('../src/services/advisory-locks');
    const running = (key) => waitFor(async () => (await pool.query(
      `SELECT 1 FROM wf_work WHERE machine = $1 AND key = $2 AND status = 'running'`, [MACHINE, key])).rowCount > 0,
    { label: 'the commit is under way on the conductor', timeoutMs: 10000 });

    // Another process holds the lock: the write waits for it.
    const h = await handoff();
    await holder.query('SELECT pg_advisory_lock($1::int, $2::int)', [PROPOSAL_UPDATE_LOCK, h.sessionId]);
    const first = await ask(upload(h, 10));
    const settling = settle();
    await running(first.key);
    // fixed wait: nothing may reach the host while another process holds the lock; this is how long it is watched
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(host.calls.filter((c) => c.branch === h.branch).length, 0, 'nothing written while the lock is held');
    const releasedAt = Date.now();
    await holder.query('SELECT pg_advisory_unlock($1::int, $2::int)', [PROPOSAL_UPDATE_LOCK, h.sessionId]);
    await within(settling, 30000, 'the conductor');
    assert.equal((await instance(first.key)).data.ok, true);
    const made = commits().filter((c) => c.branch === h.branch);
    assert.equal(made.length, 1);
    assert.ok(made[0].at >= releasedAt, 'the commit was made once the lock was released');

    // Another writer records a newer upload while it holds the lock: the
    // head this request expected is no longer the branch's, so nothing is
    // written.
    const next = currentProposalBranchHead(await row(h.sessionId));
    await holder.query('SELECT pg_advisory_lock($1::int, $2::int)', [PROPOSAL_UPDATE_LOCK, h.sessionId]);
    const second = await ask(upload(h, 12, { expectedParent: next, parentTreeSha: SHA('b') }));
    const settlingAgain = settle();
    await running(second.key);
    await pool.query(
      `UPDATE chat_sessions SET handoff_uploaded_sha = $2, handoff_local_commit_sha = $3, handoff_upload_checked_sha = checks_commit_sha
        WHERE id = $1`, [h.sessionId, SHA('e'), SHA('f')]);
    await holder.query('SELECT pg_advisory_unlock($1::int, $2::int)', [PROPOSAL_UPDATE_LOCK, h.sessionId]);
    await within(settlingAgain, 30000, 'the conductor');
    assert.deepEqual((await instance(second.key)).data, { ok: false, status: 409, error: 'session_state_changed' });
    assert.equal(commits().filter((c) => c.branch === h.branch).length, 1, 'no second commit');
    assert.equal(await kept(second.requestId), 0);
  });

  await t.test('a build turn\'s commit becomes its head on the conductor; a lease lost before it writes nothing', async () => {
    const h = await handoff();
    const turn = async () => {
      const { rows: [lease] } = await pool.query(
        `INSERT INTO session_agent_leases (session_id, user_id, label, expires_at)
         VALUES ($1, $2, 'laptop', NOW() + INTERVAL '5 minutes') RETURNING id`, [h.sessionId, h.userId]);
      const { rows: [tr] } = await pool.query(
        `INSERT INTO local_agent_turns (session_id, lease_id, user_id, status, mode, prompt, base_sha, branch_name)
         VALUES ($1, $2, $3, 'running', 'build', 'Add the button', $4, $5) RETURNING id`,
        [h.sessionId, lease.id, h.userId, host.branches.get(h.branch).sha, h.branch]);
      return { leaseId: String(lease.id), turnId: String(tr.id) };
    };
    const asTurn = (ids, n) => {
      const p = upload(h, n, { expectedParent: host.branches.get(h.branch).sha });
      return { ...p, input: { ...p.input, surface: 'turn', ...ids } };
    };

    const ids = await turn();
    const { key, requestId } = await ask(asTurn(ids, 14));
    await settle();
    const done = (await instance(key)).data;
    const head = host.branches.get(h.branch).sha;
    assert.deepEqual(done, { ok: true, surface: 'turn', headSha: head, treeSha: SHA('f'), branch: h.branch, uploaded: true });
    const { rows: [tr] } = await pool.query('SELECT head_sha, status FROM local_agent_turns WHERE id = $1', [ids.turnId]);
    assert.deepEqual(tr, { head_sha: head, status: 'running' });
    assert.equal(commits().at(-1).role, 'conductor');
    assert.equal(await kept(requestId), 0);

    // The lease is handed back after the route's check, before the conductor's.
    const before = host.calls.length;
    const lost = await ask(asTurn(ids, 16));
    await pool.query(`UPDATE session_agent_leases SET released_at = NOW(), release_reason = 'detached' WHERE id = $1`, [ids.leaseId]);
    await settle();
    assert.deepEqual((await instance(lost.key)).data, { ok: false, status: 409, error: 'lease_lost' });
    assert.equal(host.calls.length, before, 'nothing reached the host');
    const { rows: [after] } = await pool.query('SELECT head_sha FROM local_agent_turns WHERE id = $1', [ids.turnId]);
    assert.equal(after.head_sha, head, 'the turn\'s head is unchanged');
    assert.equal(await kept(lost.requestId), 0);
  });
});
