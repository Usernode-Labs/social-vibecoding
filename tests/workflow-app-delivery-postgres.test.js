'use strict';

// app-delivery (src/workflow/app-delivery/) against the full PostgreSQL
// schema: one production deploy at a time per app, a request served by the
// first successful deploy that started after it, whoever asked answered,
// and the "deploying" state durable on the app's row. The deploy itself is
// a fake service; the real one is staging.deployProduction.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-app-delivery-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { appDelivery, appKey, MACHINE, WORK } = require('../src/workflow/app-delivery/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40);

test('app-delivery machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_delivery_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  // pool.end() resolves before its sockets have closed: a connection cut
  // while it closes reports to the pool, not as an uncaught error.
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`);
  async function app({ selfHosted = false, repo = true, status = 'running', mainSha = SHA('0') } = {}) {
    const slug = `delivery-app-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url, status, main_sha)
       VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING *`,
      [slug, owner.id, selfHosted, repo ? `https://github.com/acme/${slug}` : null, status, mainSha]);
    return a;
  }

  // The deploy: each call answers what `next` says, in order.
  const deploys = { calls: [], next: [] };
  const machine = appDelivery();
  const pushed = [];
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: { [WORK.deploy]: {
      maxAttempts: 2, backoffMs: () => 0,
      async run({ input, key }) {
        deploys.calls.push({ key, input });
        const answer = deploys.next.shift() || { sha: SHA('a') };
        if (answer.throw) throw Object.assign(new Error(answer.throw), answer.permanent ? { permanent: true } : {});
        return answer;
      },
    } },
  });
  runtimes.push(rt);

  let rk = 0;
  // A request from a route or a sweep (system), or from another machine.
  const ask = (a, { reason = 'redeploy', from = null, ...payload } = {}) => rt.append(machine, appKey(a.id),
    { type: 'DeployRequested', payload: { appId: a.id, reason, ...payload } },
    { requestKey: `t-${++rk}`, appId: a.id,
      source: from ? { kind: 'message', from: { ...from, eventId: 1 } } : { kind: 'system', name: reason } });
  const settle = async () => { await rt.drain(); while (await rt.runServices()) await rt.drain(); };
  const inst = async (a) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, appKey(a.id)])).rows[0];
  const row = async (a) => (await pool.query('SELECT * FROM apps WHERE id = $1', [a.id])).rows[0];
  // What app-delivery said to other machines.
  const told = async (machineName, key) => (await pool.query(
    `SELECT type, payload FROM wf_events WHERE machine = $1 AND key = $2 AND source->>'kind' = 'message' ORDER BY id`,
    [machineName, key])).rows;
  const statusPushes = (a) => pushed.filter((p) => p.data.type === 'app_redeploy_status' && p.data.appSlug === a.slug);
  const reset = () => { deploys.calls.length = 0; deploys.next.length = 0; pushed.length = 0; };

  await t.test('a request starts a deploy, and the row says it is deploying, durably', async () => {
    reset();
    const a = await app();
    await ask(a);
    await rt.drain();
    const s = await inst(a);
    assert.equal(s.state, 'deploying');
    const r = await row(a);
    assert.equal(r.deploy_state, 'deploying', 'every process, and one after a restart, reads it');
    assert.equal(r.deploy_from_sha, SHA('0'));
    assert.ok(r.deploy_started_at);
    assert.deepEqual(statusPushes(a).map((p) => [p.kind, p.data.deploying]), [['global', true]]);
    await settle();
    assert.equal((await inst(a)).state, 'idle');
    assert.equal((await row(a)).deploy_state, null);
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1']);
  });

  await t.test('requests that arrive during a deploy are served by one more deploy, however many', async () => {
    reset();
    const a = await app();
    await ask(a);
    await rt.drain();
    for (let i = 0; i < 3; i++) await ask(a, { reason: 'drift' });
    await rt.drain();
    assert.equal((await inst(a)).data.requests.length, 4);
    await settle();
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1', 'deploy:2'], 'two deploys for four requests');
    assert.equal((await inst(a)).state, 'idle');
    assert.equal((await inst(a)).data.requests.length, 0);
  });

  await t.test('a success writes the result in the transition that says the deploy ended, and answers whoever asked', async () => {
    reset();
    const a = await app({ status: 'awaiting_secrets' });
    const merge = { machine: 'merge-followups', key: 'session:41' };
    await ask(a, { reason: 'merge', from: merge, prNumber: 7, revision: SHA('b') });
    deploys.next.push({ sha: SHA('b') });
    await settle();
    const r = await row(a);
    assert.equal(r.main_sha, SHA('b'));
    assert.equal(r.main_pr_number, 7, 'its pull request: the commit that deployed is the merge\'s own');
    assert.ok(r.last_deploy_at);
    assert.equal(r.status, 'running', 'a deploy that succeeded runs the app');
    assert.deepEqual(deploys.calls[0].input, { appId: a.id, revision: SHA('b'), reuse: null, prNumber: 7 });
    assert.deepEqual(await told('merge-followups', 'session:41'), [{ type: 'Delivered', payload: { sha: SHA('b') } }]);
    const end = statusPushes(a).find((p) => p.data.deploying === false);
    assert.equal(end.data.toSha, SHA('b'));
    assert.ok(pushed.some((p) => p.data.type === 'app_version_changed' && p.data.appSlug === a.slug && p.data.sha === SHA('b')));
  });

  await t.test('a deploy reuses what every request it serves offers, and nothing when one asks for a real deploy', async () => {
    reset();
    const a = await app();
    const merge = { machine: 'merge-followups', key: 'session:42' };
    await ask(a, { reason: 'merge', from: merge, prNumber: 8, revision: SHA('c') });
    await rt.drain();
    await ask(a, { reason: 'merge', from: { ...merge, key: 'session:43' }, prNumber: 9, revision: SHA('d') });
    await ask(a, { reason: 'secret_change', from: { machine: 'governance-proposal', key: 'issue:5' } });
    await settle();
    assert.equal(deploys.calls[0].input.revision, SHA('c'), 'one merge alone: its commit may already run');
    assert.deepEqual(deploys.calls[1].input, { appId: a.id, revision: null, reuse: null, prNumber: null },
      'a merge beside a secret change: a real deploy');
  });

  await t.test('a failure is told once and keeps the request open: the next deploy that succeeds answers it', async () => {
    reset();
    const a = await app();
    const merge = { machine: 'merge-followups', key: 'session:44' };
    deploys.next.push({ throw: 'the build failed', permanent: true });
    await ask(a, { reason: 'merge', from: merge, revision: SHA('e') });
    await settle();
    assert.equal((await inst(a)).state, 'idle', 'a failure alone does not loop');
    assert.equal((await row(a)).deploy_state, null);
    assert.deepEqual(await told('merge-followups', 'session:44'),
      [{ type: 'DeliveryFailed', payload: { message: 'the build failed', missingSecrets: null } }]);
    assert.equal((await inst(a)).data.requests.length, 1, 'still open');
    assert.ok(statusPushes(a).some((p) => p.data.deploying === false && p.data.failed === true));
    // Anyone's next request deploys, and answers the open one too.
    deploys.next.push({ sha: SHA('f') });
    await ask(a, { reason: 'drift' });
    await settle();
    assert.deepEqual((await told('merge-followups', 'session:44')).map((m) => m.type), ['DeliveryFailed', 'Delivered']);
    assert.equal((await inst(a)).data.requests.length, 0);
  });

  await t.test('missing keys are a failure that names them', async () => {
    reset();
    const a = await app();
    deploys.next.push({ failed: 'missing_secrets', message: 'missing required secrets: API_KEY', missingSecrets: ['API_KEY'] });
    await ask(a, { reason: 'secret_change', from: { machine: 'governance-proposal', key: 'issue:6' } });
    await settle();
    assert.deepEqual(await told('governance-proposal', 'issue:6'),
      [{ type: 'DeliveryFailed', payload: { message: 'missing required secrets: API_KEY', missingSecrets: ['API_KEY'] } }]);
    const end = statusPushes(a).find((p) => p.data.deploying === false);
    assert.deepEqual(end.data.missingSecrets, ['API_KEY'], 'the client names the keys');
    assert.equal(deploys.calls.length, 1, 'not retried');
  });

  await t.test('a deploy that fails for a passing reason is retried, and stays deploying meanwhile', async () => {
    reset();
    const a = await app();
    deploys.next.push({ throw: 'cluster unreachable' }, { sha: SHA('1') });
    await ask(a);
    await settle();
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1', 'deploy:1'], 'the same deploy, again');
    assert.equal((await row(a)).main_sha, SHA('1'));
  });

  await t.test('what no deploy here can serve is refused: the platform itself, an app without a repo, no app', async () => {
    const self = await app({ selfHosted: true });
    const bare = await app({ repo: false });
    for (const [a, reason] of [[self, 'self_hosted'], [bare, 'no_repo']]) {
      const id = await ask(a);
      await rt.drain();
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      assert.deepEqual([e.result, e.reason], ['rejected', reason]);
    }
    const refusal = async (key, appId) => {
      const id = await rt.append(machine, key, { type: 'DeployRequested', payload: { appId, reason: 'x' } },
        { requestKey: `refused-${key}-${appId}`, appId, source: { kind: 'system' } });
      await rt.drain();
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      return [e.result, e.reason];
    };
    assert.deepEqual(await refusal(appKey(999998), 999998), ['rejected', 'no_app']);
    assert.deepEqual(await refusal(appKey(999999), self.id), ['rejected', 'key_mismatch'], 'one instance per app, under its own key');
  });

  await t.test('merges still waiting to go live hear any deploy that succeeds', async () => {
    reset();
    const a = await app();
    // merge-followups instances as its pipeline writes them.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.wf_writer = 'transition'`);
      await c.query(
        `INSERT INTO wf_instances (machine, key, app_id, state, data, version, machine_version)
         VALUES ('merge-followups', 'session:77', $1, 'delivering', $2, 1, 2),
                ('merge-followups', 'session:78', $1, 'live', $2, 1, 3),
                ('merge-followups', 'session:79', $1, 'delivering', $3, 1, 3)`,
        [a.id, JSON.stringify({ role: 'merge' }), JSON.stringify({ role: 'merge', delivery: 'app-delivery' })]);
      await c.query('COMMIT');
    } finally { c.release(); }
    deploys.next.push({ sha: SHA('2') });
    await ask(a, { reason: 'drift' });
    await settle();
    assert.deepEqual(await told('merge-followups', 'session:77'), [{ type: 'Deployed', payload: { sha: SHA('2') } }]);
    assert.deepEqual(await told('merge-followups', 'session:78'), [], 'a live one waits for nothing');
    assert.deepEqual(await told('merge-followups', 'session:79'), [{ type: 'Deployed', payload: { sha: SHA('2') } }],
      'one that asked here before, and this deploy did not answer, hears it too');
  });

  await t.test('a merge whose own answer did not make it live hears every later deploy', async () => {
    reset();
    const a = await app();
    // merge-followups instances as its pipeline writes them: one that asked
    // here, answered by an earlier deploy, still waiting (GitHub had not
    // said the build contains it).
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`INSERT INTO wf_instances (machine, key, app_id, state, data, version, machine_version)
        VALUES ('merge-followups', 'session:88', $1, 'delivering', $2, 1, 3)`,
      [a.id, JSON.stringify({ role: 'merge', delivery: 'app-delivery' })]);
      await c.query('COMMIT');
    } finally { c.release(); }
    const asking = { machine: 'merge-followups', key: 'session:89' };
    deploys.next.push({ sha: SHA('3') });
    await ask(a, { reason: 'merge', from: asking, revision: SHA('3') });
    await settle();
    assert.deepEqual(await told('merge-followups', 'session:88'), [{ type: 'Deployed', payload: { sha: SHA('3') } }]);
    assert.deepEqual((await told('merge-followups', 'session:89')).map((m) => m.type), ['Delivered'],
      'the merge this deploy served hears its answer, not the fan-out too');
  });

  await t.test('a deploy of the commit already running keeps its pull request on the row and the pill', async () => {
    reset();
    const a = await app({ mainSha: SHA('4') });
    await pool.query('UPDATE apps SET main_pr_number = 12 WHERE id = $1', [a.id]);
    deploys.next.push({ sha: SHA('4') }, { sha: SHA('5') });
    await ask(a, { reason: 'redeploy' });
    await settle();
    assert.equal((await row(a)).main_pr_number, 12, 'the same commit: still that pull request\'s');
    assert.ok(pushed.some((p) => p.data.type === 'app_version_changed' && p.data.appSlug === a.slug && p.data.prNumber === 12));
    await ask(a, { reason: 'drift' });
    await settle();
    assert.equal((await row(a)).main_pr_number, null, 'a commit no merge here named');
  });

  await t.test('one more deploy right after another says it starts from the build that just deployed', async () => {
    reset();
    const a = await app({ mainSha: SHA('6') });
    await ask(a);
    await rt.drain();
    await ask(a, { reason: 'drift' });
    deploys.next.push({ sha: SHA('7') }, { sha: SHA('8') });
    await settle();
    const starts = statusPushes(a).filter((p) => p.data.deploying === true).map((p) => p.data.fromSha);
    assert.deepEqual(starts, [SHA('6'), SHA('7')]);
  });

  await t.test('a request another machine cannot have served is answered, not refused', async () => {
    reset();
    const bare = await app({ repo: false });
    await ask(bare, { reason: 'merge', from: { machine: 'merge-followups', key: 'session:90' } });
    await rt.drain();
    assert.deepEqual(await told('merge-followups', 'session:90'),
      [{ type: 'DeliveryFailed', payload: { message: 'the app has no repository to deploy from', missingSecrets: null } }]);
    assert.equal(deploys.calls.length, 0);
  });

  await t.test('an admin ends a deploy that never answers: whoever asked is told, and its late result is stale', async () => {
    reset();
    const a = await app();
    await ask(a, { reason: 'merge', from: { machine: 'merge-followups', key: 'session:91' } });
    await rt.drain();
    assert.equal((await inst(a)).state, 'deploying');
    await rt.append(machine, appKey(a.id), { type: 'EndDeploy', payload: {} },
      { requestKey: `t-${++rk}`, appId: a.id, source: { kind: 'admin' } });
    await rt.drain();
    assert.equal((await inst(a)).state, 'idle');
    assert.equal((await row(a)).deploy_state, null);
    assert.deepEqual((await told('merge-followups', 'session:91')).map((m) => m.type), ['DeliveryFailed']);
    await settle();   // the deploy it ended still runs, and answers
    assert.equal((await inst(a)).state, 'idle', 'its result belongs to no deploy now');
    const forged = await rt.append(machine, appKey(a.id), { type: 'EndDeploy', payload: {} },
      { requestKey: `t-${++rk}`, appId: a.id, source: { kind: 'system' } });
    await rt.drain();
    assert.equal((await pool.query('SELECT reason FROM wf_events WHERE id = $1', [forged])).rows[0].reason, 'admin_only');
  });

  await t.test('only the machine writes the deploying state', async () => {
    const a = await app();
    await ask(a);
    await settle();
    await assert.rejects(pool.query(`UPDATE apps SET deploy_state = 'deploying' WHERE id = $1`, [a.id]), /WF_OWNERSHIP_VIOLATION/);
  });
});
