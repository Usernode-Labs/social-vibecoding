'use strict';

// The git-host flows' platform operations (services/platform-operations.js,
// "git-host flows") against the real schema and kernel, through a version's
// suggestion to its original (`suggestBack.open`,
// services/suggest-back-operation.js): a web runtime appends, a conductor
// decides and runs the work. Only the code host is faked. Pinned: the web
// side writes nothing; the conductor reads the requester's standing again;
// a retry whose proposal row committed while its reply was lost finds that
// row (the one-open-suggestion index would refuse a second) and pushes and
// opens nothing again; another open suggestion refuses before any push.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { platformOperation, MACHINE, WORK, operationKey } = require('../src/workflow/platform-operation/machine.ts');
const { platformOperationServices } = require('../src/workflow/platform-operation/services.ts');

const SHA = (c) => c.repeat(40);

test('a version\'s suggestion is conductor work', { timeout: 90000 }, async (t) => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (e) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw e;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this check'); return;
  }
  const name = `git_host_flows_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);

  // The code host: every write recorded with the process role that made it.
  const host = { calls: [] };
  const write = (op, ...args) => host.calls.push([op, process.env.PROCESS_ROLE, ...args]);
  let prs = 0;
  let losePrReply = false;
  const openPulls = new Map();
  const deps = {
    github: {
      isEnabled: () => true,
      getRepoHead: async () => ({ headSha: SHA('c') }),
      compareCommitSubjects: async () => ({ commits: [{ sha: SHA('c'), subject: 'Add dark mode (#1)' }], totalCommits: 1, files: ['app.js'] }),
      findOpenPrByBranch: async (owner, repo, branch) => openPulls.get(`${owner}/${repo}/${branch}`) || null,
      createPR: async (owner, repo, { branch }) => {
        prs += 1; write('createPR', prs);
        const made = { number: 40 + prs, html_url: null, base: { sha: SHA('a') } };
        openPulls.set(`${owner}/${repo}/${branch}`, made);
        if (losePrReply) { losePrReply = false; throw new (require('../src/workflow/kernel/steps.ts').StepsStopped)(); }
        return made;
      },
      getBotUsername: async () => 'homeroom',
      closePR: async (_o, _r, n) => write('closePR', n),
    },
    head: {
      resolveWriteCredential: async () => ({ token: 'tok', username: 'homeroom', source: 'git_host' }),
      appRemote: (owner, repo) => `${owner}/${repo}`,
      withScratchRepo: async () => ({ patch: 'diff --git a/app.js b/app.js\n', files: ['app.js'], manifestKeys: [] }),
      redactToken: (m) => m,
      deleteBranch: async ({ branch }) => write('deleteBranch', branch),
    },
    externalAgentPatch: {
      applyPatch: async () => { write('applyPatch'); return { ok: true, branch: `usernode/patch-${host.calls.length}`, headSha: SHA('d'), cleanup: async () => write('cleanup') }; },
    },
    appAccess: { checkAppAccess: async () => true },
    communities: { isMember: async () => true, joinRequiredBody: require('../src/services/communities').joinRequiredBody },
    limits: { checkPromotedCap: async () => null },
    topicAttrs: { selfAssignProposal: async () => {} },
    prImportSync: { kickImportedChecks: () => {} },
    ws: { pushSessionUpdate: () => {} },
    lineage: { resolveLegacy: async () => null },
  };
  const operation = require('../src/services/suggest-back-operation');
  const prior = operation._setDepsForTests(deps);

  // The conductor's pool: the real one, with a proposal row whose reply is
  // lost after it committed, when `loseInsertReply` says so.
  let loseInsertReply = false;
  const conductorPool = {
    async query(sql, params) {
      const out = await pool.query(sql, params);
      if (loseInsertReply && /INSERT INTO chat_sessions/.test(String(sql))) { loseInsertReply = false; throw new Error('connection reset'); }
      return out;
    },
    connect: (...a) => pool.connect(...a),
  };
  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  const config = {};
  const machine = platformOperation();
  const services = platformOperationServices({ pool: conductorPool, config });
  const web = createRuntime({ pool, machines: [machine], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [machine], services, slots: 1 });
  t.after(async () => {
    operation._setDepsForTests(prior);
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });

  async function settle(rounds = 4) {
    process.env.PROCESS_ROLE = 'conductor';
    try {
      for (let i = 0; i < rounds; i += 1) {
        await conductor.drain(); await conductor.runServices(); await conductor.drain();
        await pool.query(`UPDATE wf_work SET due_at = NOW() WHERE machine = $1 AND status = 'queued'`, [MACHINE]);
      }
    } finally { process.env.PROCESS_ROLE = 'web'; }
  }
  async function ask(p) {
    const requestId = randomUUID();
    const payload = { appId: p.appId, userId: p.userId, op: 'suggestBack.open', input: { picked: false }, requestId };
    const key = operationKey(payload);
    await web.append(MACHINE, key, { type: 'Requested', payload }, {
      requestKey: requestId, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK },
    });
    return key;
  }
  const instance = async (key) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, key])).rows[0];

  let seq = 0;
  async function versionOf() {
    seq += 1;
    const { rows: [u] } = await pool.query(
      'INSERT INTO users (username, password, has_platform_access) VALUES ($1, \'x\', TRUE) RETURNING id', [`sb_${seq}`]);
    const { rows: [orig] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, repo_url) VALUES ($1, $1, $2, 'running', $3) RETURNING id`,
      [`orig-${seq}`, u.id, `https://github.com/acme/orig-${seq}`]);
    const { rows: [copy] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, repo_url, forked_from) VALUES ($1, $1, $2, 'running', $3, $4::jsonb) RETURNING id`,
      [`copy-${seq}`, u.id, `https://github.com/acme/copy-${seq}`,
        JSON.stringify({ appId: orig.id, slug: `orig-${seq}`, sourceSha: SHA('a'), forkBaseSha: SHA('b') })]);
    for (const appId of [orig.id, copy.id]) {
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [appId, u.id]);
    }
    return { userId: u.id, appId: copy.id, originalId: orig.id };
  }
  const rowsOf = async (p) => (await pool.query(
    'SELECT id, pr_number, status, source FROM chat_sessions WHERE app_id = $1 AND suggested_from_app_id = $2 ORDER BY id',
    [p.originalId, p.appId])).rows;

  await t.test('the web side appends; the conductor builds, pushes and opens the proposal', async () => {
    const p = await versionOf();
    const before = host.calls.length;
    const key = await ask(p);
    assert.equal(host.calls.length, before, 'the web append writes nothing to the host');
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done');
    assert.equal(done.data.ok, true, JSON.stringify(done.data));
    const writes = host.calls.slice(before);
    assert.deepEqual(writes.map((c) => c[0]), ['applyPatch', 'createPR']);
    assert.ok(writes.every((c) => c[1] === 'conductor'), 'every write runs on the conductor');
    const rows = await rowsOf(p);
    assert.deepEqual(rows.map((r) => [r.status, r.source, Number(r.id) === done.data.sessionId]), [['active', 'imported', true]]);

    // Another send while it is open: refused before anything is pushed.
    const again = await ask(p);
    const mark = host.calls.length;
    await settle();
    const refused = await instance(again);
    assert.equal(refused.data.ok, false);
    assert.equal(refused.data.status, 409);
    assert.equal(refused.data.body.code, 'already_open');
    assert.equal(host.calls.length, mark);
  });

  await t.test('a proposal row that committed while its reply was lost is found again, and nothing is pushed or opened twice', async () => {
    const p = await versionOf();
    const before = host.calls.length;
    loseInsertReply = true;
    const key = await ask(p);
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done');
    assert.equal(done.data.ok, true, JSON.stringify(done.data));
    assert.deepEqual(host.calls.slice(before).map((c) => c[0]), ['applyPatch', 'createPR'], 'one push, one pull request, nothing closed');
    const rows = await rowsOf(p);
    assert.equal(rows.length, 1, 'one proposal');
    assert.equal(Number(rows[0].id), done.data.sessionId);
    const { rows: [w] } = await pool.query('SELECT attempt_count FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, key]);
    assert.equal(w.attempt_count, 2);
  });

  await t.test('a requester who is no longer a collaborator on their version is refused on the conductor', async () => {
    const p = await versionOf();
    await pool.query("UPDATE apps SET view_visibility = 'private', collab_visibility = 'private' WHERE id = $1", [p.appId]);
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1', [p.appId]);
    const before = host.calls.length;
    const key = await ask(p);
    await settle();
    const done = await instance(key);
    assert.equal(done.data.ok, false);
    assert.equal(done.data.status, 404);
    assert.equal(host.calls.length, before, 'nothing reached the host');
  });
});
