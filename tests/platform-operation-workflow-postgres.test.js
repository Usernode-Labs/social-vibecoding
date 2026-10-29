'use strict';

// Privileged operations (src/workflow/platform-operation/) against the real
// schema and kernel: a web runtime appends, a conductor decides and runs the
// work. Only the code host is faked; the web side must leave every write to
// the conductor, which reads the requester's authority again, and carries a
// retried request on from its last finished step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { platformOperation, MACHINE, WORK, operationKey, workKind } = require('../src/workflow/platform-operation/machine.ts');
const { platformOperationServices } = require('../src/workflow/platform-operation/services.ts');

test('privileged operations are conductor work', { timeout: 90000 }, async (t) => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (e) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw e;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this check'); return;
  }
  const name = `platform_ops_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);

  // The code host: every write recorded with the process role that made it.
  const github = require('../src/services/github');
  const host = { calls: [], prs: new Map(), branches: new Map(), files: new Map(), failNext: new Map() };
  const write = (op, ...args) => {
    host.calls.push([op, process.env.PROCESS_ROLE, ...args]);
    const fail = host.failNext.get(op);
    if (fail) { host.failNext.delete(op); fail(); }
  };
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'hasWriteAccess', () => true);
  t.mock.method(github, 'getFileContent', async (_o, _r, _p, ref) => host.files.get(ref) ?? JSON.stringify({ name: 'Demo' }));
  t.mock.method(github, 'getBranchSha', async (_o, _r, branch) => host.branches.get(branch) ?? null);
  t.mock.method(github, 'createBranch', async (_o, _r, branch) => {
    write('createBranch', branch);
    if (host.branches.has(branch)) throw Object.assign(new Error('Reference already exists'), { status: 422 });
    host.branches.set(branch, 'a'.repeat(40));
  });
  t.mock.method(github, 'ensureBranchAtSha', async (_o, _r, branch, sha) => {
    write('ensureBranchAtSha', branch, sha);
    const at = host.branches.get(branch);
    if (at && at !== sha) throw Object.assign(new Error('conflict'), { code: 'branch_conflict' });
    host.branches.set(branch, sha);
  });
  t.mock.method(github, 'pushFiles', async (_o, _r, files, { branch }) => {
    write('pushFiles', branch); host.files.set(branch, files[0].content);
  });
  t.mock.method(github, 'findOpenPrByBranch', async (_o, _r, branch) => host.prs.get(branch) ?? null);
  t.mock.method(github, 'createPR', async (_o, _r, { branch }) => {
    const pr = { number: 700 + host.prs.size, html_url: `https://github.com/acme/demo/pull/${700 + host.prs.size}` };
    host.prs.set(branch, pr);
    write('createPR', branch); // made on the host even when the reply is lost
    return pr;
  });

  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  const config = {};
  const machine = platformOperation();
  const services = platformOperationServices({ pool, config });
  const web = createRuntime({ pool, machines: [machine], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [machine], services, slots: 1 });
  t.after(async () => {
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });

  let seq = 0;
  async function project({ access = true } = {}) {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', $2) RETURNING id, username`, [`ops_${seq}`, access]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, repo_url) VALUES ($1, $1, $2, 'running', 'https://github.com/acme/demo') RETURNING id, slug`,
      [`ops-${seq}`, u.id]);
    // The creator is the community's first member, as app creation makes it.
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [a.id, u.id]);
    return { userId: u.id, username: u.username, appId: a.id, slug: a.slug };
  }
  // Settle the conductor's decisions and work, then any retry it scheduled.
  async function settle(rounds = 4) {
    process.env.PROCESS_ROLE = 'conductor';
    try {
      for (let i = 0; i < rounds; i += 1) {
        await conductor.drain(); await conductor.runServices(); await conductor.drain();
        await pool.query(`UPDATE wf_work SET due_at = NOW() WHERE machine = $1 AND status = 'queued'`, [MACHINE]);
      }
    } finally { process.env.PROCESS_ROLE = 'web'; }
  }
  async function ask(p, envelope = {}) {
    const requestId = randomUUID();
    const payload = { appId: p.appId, userId: p.userId, op: p.op, input: p.input, requestId };
    const key = operationKey(payload);
    const id = await web.append(MACHINE, key, { type: 'Requested', payload }, {
      requestKey: requestId, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK }, ...envelope,
    });
    return { id, key };
  }
  const instance = async key => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, key])).rows[0];
  const rename = (p, newName = 'Renamed') => ({ ...p, op: 'manifest.propose', input: { flavor: 'rename', args: { newName }, repoUrl: 'https://github.com/acme/demo' } });

  await t.test('a settings proposal is written by the conductor and answered to the route', async () => {
    const p = await project(); const before = host.calls.length;
    const { key } = await ask(rename(p));
    assert.equal(host.calls.length, before, 'the web append writes nothing to the host');
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done');
    assert.equal(done.data.ok, true); assert.ok(done.data.prUrl); assert.ok(done.data.sessionId);
    const writes = host.calls.slice(before);
    assert.deepEqual(writes.map(c => c[0]), ['createBranch', 'pushFiles', 'createPR']);
    assert.ok(writes.every(c => c[1] === 'conductor'), 'every write runs on the conductor');
    const { rows } = await pool.query(`SELECT status, source FROM chat_sessions WHERE app_id = $1`, [p.appId]);
    assert.deepEqual(rows, [{ status: 'promoted', source: 'settings' }]);
  });

  await t.test('admission refuses another producer, a forged actor, a mismatched key or project and an erased account', async () => {
    const p = await project();
    for (const change of ['source', 'actor', 'key', 'app', 'erased']) {
      const requestId = randomUUID();
      const payload = { appId: p.appId, userId: p.userId, op: 'manifest.propose', input: { flavor: 'rename', args: { newName: 'X' } }, requestId };
      if (change === 'erased') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [p.userId]);
      const id = await web.append(MACHINE, operationKey({ ...payload, requestId: change === 'key' ? randomUUID() : requestId }), { type: 'Requested', payload }, {
        requestKey: requestId, appId: change === 'app' ? p.appId + 1000 : p.appId,
        actor: change === 'actor' ? 'user:999999' : `user:${p.userId}`,
        source: change === 'source' ? { kind: 'system', name: WORK } : { kind: 'route', name: WORK },
      });
      await settle(1);
      assert.equal((await web.waitForEvent(id, 1000)).status, 'rejected', change);
    }
    await assert.rejects(ask({ ...p, op: 'shell; exec', input: {} }), /name its kind/);
    // A well-formed operation this build does not know is admitted and left
    // queued: its work is a kind only a conductor that knows it claims.
    const later = await ask({ ...(await project()), op: 'later.operation', input: {} });
    await settle(1);
    assert.equal((await web.waitForEvent(later.id, 1000)).status, 'accepted');
    assert.equal((await instance(later.key)).state, 'queued');
    const { rows: work } = await pool.query('SELECT kind, status FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, later.key]);
    assert.deepEqual(work.map((w) => w.kind), ['operation.later.operation']);
  });

  await t.test('authority lost after admission refuses before any write', async () => {
    const p = await project(); const before = host.calls.length;
    const { key } = await ask({ ...rename(p), op: 'manifest.propose', input: { flavor: 'admins', args: { usernames: ['someone'] } } });
    // Admitted while the requester created the project; since then it is
    // someone else's, so the requester can no longer manage it.
    const { rows: [other] } = await pool.query(`INSERT INTO users (username, password, has_platform_access) VALUES ('ops_owner_${seq}', 'x', TRUE) RETURNING id`);
    await pool.query('UPDATE apps SET created_by = $2 WHERE id = $1', [p.appId, other.id]);
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done'); assert.equal(done.data.ok, false); assert.equal(done.data.status, 403);
    assert.equal(host.calls.length, before, 'nothing reached the host');
  });

  await t.test('a requester shut out of the platform is refused on the conductor', async () => {
    const p = await project();
    const { key } = await ask(rename(p));
    await pool.query('UPDATE users SET has_platform_access = FALSE WHERE id = $1', [p.userId]);
    const before = host.calls.length;
    await settle();
    assert.equal((await instance(key)).data.status, 403); assert.equal(host.calls.length, before);
  });

  await t.test('a retry after a lost reply carries on from its steps: one branch, one push, one PR, one session', async () => {
    const p = await project(); const before = host.calls.length;
    host.failNext.set('createPR', () => { throw new Error('socket hang up'); });
    const { key } = await ask(rename(p, 'Retried'));
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done'); assert.equal(done.data.ok, true);
    assert.deepEqual(host.calls.slice(before).map(c => c[0]), ['createBranch', 'pushFiles', 'createPR'],
      'the retry found the PR its first try made and wrote nothing again');
    const { rows } = await pool.query(`SELECT pr_number FROM chat_sessions WHERE app_id = $1`, [p.appId]);
    assert.equal(rows.length, 1); assert.equal(rows[0].pr_number, done.data.prNumber);
    const { rows: [w] } = await pool.query(`SELECT attempt_count FROM wf_work WHERE machine = $1 AND key = $2`, [MACHINE, key]);
    assert.equal(w.attempt_count, 2);
  });

  await t.test('a retry after the branch was made but its reply lost reuses the branch', async () => {
    const p = await project(); const before = host.calls.length;
    host.failNext.set('createBranch', () => {
      const branch = host.calls.at(-1)[2]; host.branches.set(branch, 'b'.repeat(40));
      throw new Error('timeout');
    });
    const { key } = await ask(rename(p, 'Branch lost'));
    await settle();
    assert.equal((await instance(key)).data.ok, true);
    // The same attempt finds its own branch there and goes on.
    assert.deepEqual(host.calls.slice(before).map(c => c[0]), ['createBranch', 'pushFiles', 'createPR']);
  });

  await t.test('the same request asked twice runs once', async () => {
    const p = await project(); const before = host.calls.length;
    const requestId = randomUUID();
    const payload = { appId: p.appId, userId: p.userId, op: 'manifest.propose', input: { flavor: 'rename', args: { newName: 'Twice' } }, requestId };
    const opts = { requestKey: requestId, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK } };
    await web.append(MACHINE, operationKey(payload), { type: 'Requested', payload }, opts);
    const second = await web.append(MACHINE, operationKey(payload), { type: 'Requested', payload }, opts);
    await settle();
    assert.notEqual((await web.waitForEvent(second, 1000)).status, 'accepted');
    assert.equal(host.calls.slice(before).filter(c => c[0] === 'createPR').length, 1);
  });

  await t.test('a branch is made only under dev/, at the start the requester may use, and never moved', async () => {
    const p = await project(); const before = host.calls.length;
    const base = 'c'.repeat(40);
    const branch = (b, extra = {}) => ask({ ...p, op: 'branch.ensure', input: { purpose: 'proposal-start', branch: b, baseSha: base, ...extra } });
    const ok = await branch(`dev/cli-u${p.userId}-req-1`);
    const theirs = await branch(`dev/cli-u${p.userId + 1}-req-1`);
    const main = await ask({ ...p, op: 'branch.ensure', input: { purpose: 'headless', branch: 'main' } });
    host.branches.set(`dev/cli-u${p.userId}-req-2`, 'd'.repeat(40));
    const conflict = await branch(`dev/cli-u${p.userId}-req-2`);
    await settle();
    assert.equal((await instance(ok.key)).data.ok, true);
    assert.equal((await instance(theirs.key)).data.status, 400);
    assert.equal((await instance(main.key)).data.status, 400);
    const c = (await instance(conflict.key)).data;
    assert.equal(c.status, 409); assert.equal(c.error, 'branch_conflict');
    assert.equal(host.branches.get(`dev/cli-u${p.userId}-req-2`), 'd'.repeat(40), 'the existing ref is never moved');
    const made = host.calls.slice(before).filter(x => x[0] === 'ensureBranchAtSha').map(x => x[2]);
    assert.deepEqual(made, [`dev/cli-u${p.userId}-req-1`, `dev/cli-u${p.userId}-req-2`]);
  });

  await t.test('a first-turn branch is refused once the change records another', async () => {
    const p = await project();
    host.branches.set('main', 'e'.repeat(40));
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/other-1') RETURNING id`, [p.appId, p.userId]);
    const { key } = await ask({ ...p, op: 'branch.ensure', input: { purpose: 'session', branch: 'dev/mine-1', sessionId: s.id } });
    await settle();
    assert.equal((await instance(key)).data.status, 409);
    await pool.query('UPDATE chat_sessions SET branch_name = NULL WHERE id = $1', [s.id]);
    const again = await ask({ ...p, op: 'branch.ensure', input: { purpose: 'session', branch: 'dev/mine-1', sessionId: s.id } });
    await settle();
    const done = (await instance(again.key)).data;
    assert.equal(done.ok, true); assert.equal(done.sha, 'e'.repeat(40));
  });

  await t.test('authority revoked after a failed first read stops the retry before any write', async () => {
    const p = await project(); const before = host.calls.length;
    let failed = false;
    const read = github.getBranchSha;
    t.mock.method(github, 'getBranchSha', async (...args) => {
      if (!failed) { failed = true; throw new Error('host timeout'); }
      return read(...args);
    });
    const { key } = await ask({ ...p, op: 'branch.ensure', input: { purpose: 'headless', branch: 'dev/auto-issue-1-x-1' } });
    process.env.PROCESS_ROLE = 'conductor';
    try { await conductor.drain(); await conductor.runServices(); } finally { process.env.PROCESS_ROLE = 'web'; }
    assert.equal(failed, true, 'the first attempt failed on its read, before any write');
    // Collab access goes before the retry.
    const { rows: [other] } = await pool.query(`INSERT INTO users (username, password, has_platform_access) VALUES ('ops_new_owner_${seq}', 'x', TRUE) RETURNING id`);
    await pool.query('UPDATE apps SET created_by = $2 WHERE id = $1', [p.appId, other.id]);
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [p.appId, p.userId]);
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done'); assert.equal(done.data.ok, false);
    assert.deepEqual(host.calls.slice(before), [], 'no branch was made');
    t.mock.method(github, 'getBranchSha', read);
  });

  await t.test('a conductor whose build does not know an operation leaves it for one that does', async () => {
    const p = await project();
    const older = Object.fromEntries(Object.entries(services).filter(([kind]) => kind !== workKind('branch.ensure')));
    const old = createRuntime({ pool, machines: [machine], services: older, slots: 1 });
    host.branches.set('main', 'f'.repeat(40));
    try {
      const { key } = await ask({ ...p, op: 'branch.ensure', input: { purpose: 'headless', branch: 'dev/auto-issue-2-y-1' } });
      process.env.PROCESS_ROLE = 'conductor';
      try { await old.drain(); await old.runServices(); } finally { process.env.PROCESS_ROLE = 'web'; }
      assert.equal((await instance(key)).state, 'queued', 'not claimed, not failed');
      const { rows: [w] } = await pool.query(`SELECT status, attempt_count FROM wf_work WHERE machine = $1 AND key = $2`, [MACHINE, key]);
      assert.deepEqual(w, { status: 'queued', attempt_count: 0 });
      await settle();
      assert.equal((await instance(key)).data.ok, true);
    } finally { await old.stop(); }
  });

  // An Undo of a merged change on the platform's GitHub repository: the
  // revert's clone and push are faked; everything else is real.
  const docker = require('../src/services/docker');
  t.mock.method(github, 'getInstallationToken', async () => 'token');
  t.mock.method(docker, 'execFileAsync', async (_cmd, args) => {
    if (args.includes('push')) { host.calls.push(['push', process.env.PROCESS_ROLE, args.at(-1)]); host.branches.set(args.at(-1), 'r'.repeat(40)); }
    return { stdout: '' };
  });
  async function mergedChange(p) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title, merge_commit_sha)
       VALUES ($1, $2, 'merged', 'dev/x-1', 9, 'A change', $3) RETURNING id`, [p.appId, p.userId, 'a'.repeat(40)]);
    return s.id;
  }
  const revertRows = async id => (await pool.query('SELECT id, status, pr_number FROM chat_sessions WHERE revert_of_session_id = $1 AND id <> $1', [id])).rows;

  await t.test('an Undo whose PR reply was lost is tried again and opened once, with its session', async () => {
    const p = await project(); const id = await mergedChange(p); const before = host.calls.length;
    host.failNext.set('createPR', () => { throw new Error('socket hang up'); });
    const { key } = await ask({ ...p, op: 'revert.open', input: { sessionId: id } });
    await settle();
    assert.deepEqual((await instance(key)).data, { ok: true, reverted: true, revertSessionId: (await revertRows(id))[0].id });
    assert.deepEqual(host.calls.slice(before).map(c => c[0]), ['push', 'createPR'], 'one push, one PR');
    const rows = await revertRows(id);
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'promoted');
    const { rows: [orig] } = await pool.query('SELECT revert_of_session_id FROM chat_sessions WHERE id = $1', [id]);
    assert.equal(orig.revert_of_session_id, rows[0].id, 'the claim points at the revert');
  });

  await t.test('a second Undo while one is under way is the same request; a retry adopts the claim it made', async () => {
    const votes = require('../src/routes/votes');
    const p = await project(); const id = await mergedChange(p);
    // Two clicks before either is claimed: one instance, one work item.
    const first = await ask({ ...p, op: 'revert.open', input: { sessionId: id } });
    const second = await ask({ ...p, op: 'revert.open', input: { sessionId: id } });
    assert.equal(first.key, second.key);
    process.env.PROCESS_ROLE = 'conductor';
    try { await conductor.drain(); } finally { process.env.PROCESS_ROLE = 'web'; }
    const { rows: items } = await pool.query(`SELECT 1 FROM wf_work WHERE machine = $1 AND key = $2`, [MACHINE, first.key]);
    assert.equal(items.length, 1, 'the second click is the first request');
    await pool.query(`UPDATE wf_work SET status = 'settled' WHERE machine = $1 AND key = $2`, [MACHINE, first.key]);

    // The earlier try kept `claiming`, made the claim and went before
    // recording it: the retry's claim is its own.
    await pool.query('UPDATE chat_sessions SET revert_of_session_id = id WHERE id = $1', [id]);
    const kernelSteps = require('../src/workflow/kernel/steps.ts');
    const resumed = kernelSteps.steps({ resumeFrom: { claiming: true }, checkpoint: async () => {}, triesLeft: 2 });
    const session = (await pool.query(`SELECT cs.*, a.slug AS app_slug, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [id])).rows[0];
    const opened = await votes.checkAndOpenRevert({}, pool, session, { id: p.userId, username: p.username }, { steps: resumed });
    assert.equal(opened.reverted, true);
    assert.equal((await revertRows(id)).length, 1);
    // A first try that finds a claim it never began does not take it.
    const other = await mergedChange(p);
    await pool.query('UPDATE chat_sessions SET revert_of_session_id = id WHERE id = $1', [other]);
    const fresh = kernelSteps.steps({ resumeFrom: null, checkpoint: async () => {}, triesLeft: 2 });
    const otherSession = (await pool.query(`SELECT cs.*, a.slug AS app_slug, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [other])).rows[0];
    assert.equal((await votes.checkAndOpenRevert({}, pool, otherSession, { id: p.userId, username: p.username }, { steps: fresh })).inProgress, true);
  });

  await t.test('a competing proposal opened while a request waited to retry is refused; its own is not', async () => {
    const p = await project(); const before = host.calls.length;
    const visibility = { ...p, op: 'manifest.propose', input: { flavor: 'visibility', args: { collab: 'invite', view: 'invite' }, repoUrl: 'https://github.com/acme/demo' } };
    await pool.query(`UPDATE apps SET collab_visibility = 'public', view_visibility = 'public' WHERE id = $1`, [p.appId]);
    // The first try fails on its first read, before writing anything; another
    // visibility proposal is opened before the retry.
    let read = 0;
    const getFile = github.getFileContent;
    t.mock.method(github, 'getFileContent', async (...args) => { read += 1; if (read === 1) throw new Error('host timeout'); return getFile(...args); });
    const { key } = await ask(visibility);
    process.env.PROCESS_ROLE = 'conductor';
    try { await conductor.drain(); await conductor.runServices(); } finally { process.env.PROCESS_ROLE = 'web'; }
    await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number) VALUES ($1, $2, 'promoted', 'visibility/other-1', 900)`, [p.appId, p.userId]);
    await settle();
    const refused = (await instance(key)).data;
    assert.equal(refused.status, 409); assert.equal(refused.prNumber, 900);
    assert.deepEqual(host.calls.slice(before), [], 'nothing written for the duplicate');
    t.mock.method(github, 'getFileContent', getFile);

    // Its own proposal whose insert committed but whose reply was lost (no
    // `session` checkpoint) is found by its PR, not refused as a duplicate,
    // and the rest of its setup is made.
    const r = await project();
    await pool.query(`UPDATE apps SET collab_visibility = 'public', view_visibility = 'public' WHERE id = $1`, [r.appId]);
    const query = pool.query.bind(pool);
    let lost = false;
    t.mock.method(pool, 'query', async (sql, params) => {
      const out = await query(sql, params);
      if (!lost && /INSERT INTO chat_sessions/.test(String(sql)) && /'settings'/.test(String(sql))) { lost = true; throw new Error('connection lost after commit'); }
      return out;
    });
    const lostReply = await ask({ ...visibility, ...r });
    await settle();
    t.mock.method(pool, 'query', query);
    const recovered = (await instance(lostReply.key)).data;
    assert.equal(lost, true, 'the insert committed and its reply was lost');
    assert.equal(recovered.ok, true);
    const { rows: [mine] } = await pool.query(
      `SELECT id, requires_explicit_approval, explicit_approval_reason FROM chat_sessions WHERE app_id = $1 AND branch_name LIKE 'visibility/%'`, [r.appId]);
    assert.equal(recovered.sessionId, mine.id);
    assert.deepEqual([mine.requires_explicit_approval, mine.explicit_approval_reason], [true, 'visibility'], 'its setup was finished');

    // Its own proposal, recorded before a later step failed, is not a duplicate.
    const q = await project();
    await pool.query(`UPDATE apps SET collab_visibility = 'public', view_visibility = 'public' WHERE id = $1`, [q.appId]);
    const topicAttrs = require('../src/services/topic-attributes');
    let assigned = 0;
    const assign = topicAttrs.selfAssignProposal;
    t.mock.method(topicAttrs, 'selfAssignProposal', async (...args) => { assigned += 1; if (assigned === 1) throw new Error('db blip'); return assign(...args); });
    const own = await ask({ ...visibility, ...q });
    await settle();
    const done = (await instance(own.key)).data;
    assert.equal(done.ok, true);
    assert.equal((await pool.query(`SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name LIKE 'visibility/%'`, [q.appId])).rowCount, 1);
    t.mock.method(topicAttrs, 'selfAssignProposal', assign);
  });

  await t.test('an app is removed on the conductor, for someone who may still delete it', async () => {
    const runtime = require('../src/services/application-runtime');
    const removed = [];
    t.mock.method(runtime, 'remove', async (_config, ref) => { removed.push([process.env.PROCESS_ROLE, ref.runtimeName]); });
    const p = await project();
    await pool.query(`UPDATE apps SET runtime_kind = 'kubernetes', runtime_name = 'sv-app-x' WHERE id = $1`, [p.appId]);
    const { key } = await ask({ ...p, op: 'app.remove', input: {} });
    assert.deepEqual(removed, [], 'the web append removes nothing');
    await settle();
    assert.equal((await instance(key)).data.ok, true);
    assert.deepEqual(removed, [['conductor', 'sv-app-x']]);
    assert.equal((await pool.query('SELECT 1 FROM apps WHERE id = $1', [p.appId])).rowCount, 0);

    // Someone else, who could delete nothing of it, is refused before anything goes.
    const q = await project();
    const { rows: [other] } = await pool.query(`INSERT INTO users (username, password, has_platform_access) VALUES ('ops_other_${seq}', 'x', TRUE) RETURNING id`);
    const refused = await ask({ ...q, userId: other.id, op: 'app.remove', input: {} });
    await settle();
    assert.equal((await instance(refused.key)).data.status, 403);
    assert.equal((await pool.query('SELECT 1 FROM apps WHERE id = $1', [q.appId])).rowCount, 1);
  });

  await t.test('a web process never runs the work', async () => {
    const p = await project();
    await ask(rename(p, 'Web only'));
    const webOnly = createRuntime({ pool, machines: [machine], services, slots: 1 });
    try {
      await webOnly.drain();
      await assert.rejects(async () => {
        const runs = await webOnly.runServices();
        if (runs) {
          const { rows: [w] } = await pool.query(`SELECT last_error FROM wf_work WHERE machine = $1 AND last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [MACHINE]);
          throw new Error(w?.last_error?.message || 'ran');
        }
        throw new Error('no work claimed');
      }, /workflow process|no work claimed/);
    } finally { await webOnly.stop(); }
    await settle();
  });
});
