'use strict';

// `pr.sync` (src/services/pr-sync-operation.js) against the real schema and
// kernel: a web runtime appends, a conductor decides and writes to GitHub.
// Only GitHub is faked. A create whose reply was lost is tried again and
// adopts the pull request it opened, so a retry never opens a second one;
// the description sync takes the proposal's lock on the conductor and leads
// the body with the stored description.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { platformOperation, MACHINE, WORK, operationKey } = require('../src/workflow/platform-operation/machine.ts');
const { platformOperationServices } = require('../src/workflow/platform-operation/services.ts');

test('a pull request\'s metadata is conductor work', { timeout: 90000 }, async (t) => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (e) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw e;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this check'); return;
  }
  const name = `pr_sync_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);

  // GitHub, for the platform repository: every write recorded with the
  // process role that made it.
  const platform = require('../src/services/repo-ref').platformRepoUrl();
  const github = require('../src/services/github');
  const host = { calls: [], prs: new Map(), bodies: new Map(), loseNextReply: false };
  const write = (op, ...args) => host.calls.push([op, process.env.PROCESS_ROLE, ...args]);
  t.mock.method(github, 'findOpenPrByBranch', async (_o, _r, branch) => {
    const pr = host.prs.get(branch);
    return pr ? { ...pr, body: host.bodies.get(pr.number) } : null;
  });
  t.mock.method(github, 'createPR', async (_o, _r, { branch, title, body }) => {
    if (host.prs.has(branch)) throw Object.assign(new Error('A pull request already exists'), { code: 'pr_exists' });
    const number = 800 + host.prs.size;
    host.prs.set(branch, { number, html_url: `https://github.com/x/y/pull/${number}`, title });
    host.bodies.set(number, body);
    write('createPR', branch);
    // Made on GitHub, and the reply lost on the way back.
    if (host.loseNextReply) { host.loseNextReply = false; throw new Error('socket hang up'); }
    return { number, html_url: `https://github.com/x/y/pull/${number}` };
  });
  t.mock.method(github, 'getPR', async (_o, _r, n) => ({ number: n, body: host.bodies.get(Number(n)) ?? '', state: 'open', merged: false }));
  t.mock.method(github, 'updatePR', async (_o, _r, n, value) => {
    write('updatePR', Number(n), value);
    if (typeof value.body === 'string') host.bodies.set(Number(n), value.body);
  });

  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  const machine = platformOperation();
  const services = platformOperationServices({ pool, config: {} });
  const web = createRuntime({ pool, machines: [machine], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [machine], services, slots: 1 });
  t.after(async () => {
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });

  let seq = 0;
  async function change(columns = {}) {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id`, [`sync_${seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, repo_url) VALUES ($1, $1, $2, 'running', $3) RETURNING id`,
      [`sync-${seq}`, u.id, platform]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [a.id, u.id]);
    const keys = Object.keys(columns);
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, session_title${keys.map((k) => `, ${k}`).join('')})
       VALUES ($1, $2, 'active', $3, 'Cloned build'${keys.map((_, i) => `, $${i + 4}`).join('')}) RETURNING id`,
      [a.id, u.id, `dev/sync-${seq}`, ...Object.values(columns)]);
    return { userId: u.id, appId: a.id, sessionId: s.id, branch: `dev/sync-${seq}` };
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
  async function ask(c, input) {
    const requestId = randomUUID();
    const payload = { appId: c.appId, userId: c.userId, op: 'pr.sync', input: { sessionId: c.sessionId, ...input }, requestId };
    const key = operationKey(payload);
    await web.append(MACHINE, key, { type: 'Requested', payload }, {
      requestKey: requestId, appId: c.appId, actor: `user:${c.userId}`, source: { kind: 'route', name: WORK },
    });
    return key;
  }
  const instance = async (key) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, key])).rows[0];
  const row = async (id) => (await pool.query('SELECT pr_number, pr_url, pr_title, pr_body FROM chat_sessions WHERE id = $1', [id])).rows[0];

  await t.test('a create whose reply was lost is tried again and adopts the pull request it opened', async () => {
    const c = await change();
    const before = host.calls.length;
    host.loseNextReply = true;
    const key = await ask(c, { write: 'create', from: 'clone' });
    assert.equal(host.calls.length, before, 'the web append writes nothing to GitHub');
    await settle();
    const done = await instance(key);
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.data.ok, true);
    const writes = host.calls.slice(before);
    assert.deepEqual(writes.filter((w) => w[0] === 'createPR').map((w) => w[2]), [c.branch], 'one pull request, never a second');
    assert.ok(writes.every((w) => w[1] === 'conductor'), 'every write runs on the conductor');
    const pr = host.prs.get(c.branch);
    assert.equal(done.data.prNumber, pr.number);
    assert.equal((await row(c.sessionId)).pr_number, pr.number, 'the row learned the number');

    // Asked again, the change has its pull request.
    const again = await ask(c, { write: 'create', from: 'clone' });
    await settle(2);
    assert.equal((await instance(again)).data.created, false);
    assert.equal(host.calls.filter((w) => w[0] === 'createPR').length, writes.filter((w) => w[0] === 'createPR').length);
  });

  await t.test('a description is led into the body under the proposal\'s lock, on the conductor', async () => {
    const number = 900 + seq;
    host.bodies.set(number, 'Old words\n\n## Technical details\nKept.');
    const c = await change({
      pr_number: number, pr_url: `https://github.com/x/y/pull/${number}`, pr_body: 'Old words\n\n## Technical details\nKept.',
      pr_summary_md: 'New words', pr_summary_previous_md: 'Old words', pr_summary_source: 'author',
    });
    const before = host.calls.length;
    const key = await ask(c, { write: 'summary' });
    await settle(2);
    const done = await instance(key);
    assert.equal(done.data.ok, true, JSON.stringify(done));
    assert.equal(done.data.prBodyStatus, 'synced');
    assert.equal(host.bodies.get(number), 'New words\n\n## Technical details\nKept.');
    assert.equal((await row(c.sessionId)).pr_body, host.bodies.get(number), 'the mirror follows');
    assert.deepEqual(host.calls.slice(before).map((w) => [w[0], w[1]]), [['updatePR', 'conductor']]);
  });

  await t.test('a requester who no longer owns the change is refused before any write', async () => {
    const c = await change({ pr_number: 950, pr_url: 'https://github.com/x/y/pull/950', pr_title: 'Named' });
    const { rows: [other] } = await pool.query(`INSERT INTO users (username, password, has_platform_access) VALUES ('sync_other', 'x', TRUE) RETURNING id`);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [c.appId, other.id]);
    const before = host.calls.length;
    const key = await ask({ ...c, userId: other.id }, { write: 'title' });
    await settle(2);
    const done = await instance(key);
    assert.equal(done.data.ok, false);
    assert.equal(done.data.status, 404);
    assert.equal(host.calls.length, before);
  });
});
