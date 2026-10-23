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
  async function app({ selfHosted = false, repo = true, status = 'running', mainSha = SHA('0'), runtime = null, lastFailure = null } = {}) {
    const slug = `delivery-app-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url, status, main_sha, runtime_kind, last_failure)
       VALUES ($1, $1, $2, $3, $4, $5, $6, COALESCE($7, 'kubernetes'), $8) RETURNING *`,
      [slug, owner.id, selfHosted, repo ? `https://github.com/acme/${slug}` : null, status, mainSha, runtime,
        lastFailure ? JSON.stringify(lastFailure) : null]);
    return a;
  }

  // The deploy: each call answers what `next` says, in order.
  const deploys = { calls: [], next: [] };
  // The heal: each call answers what `next` says, in order.
  const heals = { calls: [], next: [] };
  const COOLDOWN_MS = 10 * 60 * 1000;
  const machine = appDelivery({ healCooldownMs: COOLDOWN_MS, githubOn: () => true, runtimeMode: 'kubernetes' });
  const pushed = [];
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: {
      [WORK.deploy]: {
        maxAttempts: 2, backoffMs: () => 0,
        async run({ input, key }) {
          deploys.calls.push({ key, input });
          const answer = deploys.next.shift() || { sha: SHA('a') };
          if (answer.throw) throw Object.assign(new Error(answer.throw), answer.permanent ? { permanent: true } : {});
          return answer;
        },
      },
      [WORK.heal]: {
        maxAttempts: 1,
        async run({ input, key }) {
          heals.calls.push({ key, input });
          const answer = heals.next.shift() || { status: 'restarted' };
          if (answer.throw) throw new Error(answer.throw);
          return answer;
        },
      },
    },
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
  const instDeadline = async (a) => (await inst(a)).deadline_at;
  const row = async (a) => (await pool.query('SELECT * FROM apps WHERE id = $1', [a.id])).rows[0];
  // What app-delivery said to other machines.
  const told = async (machineName, key) => (await pool.query(
    `SELECT type, payload FROM wf_events WHERE machine = $1 AND key = $2 AND source->>'kind' = 'message' ORDER BY id`,
    [machineName, key])).rows;
  const statusPushes = (a) => pushed.filter((p) => p.data.type === 'app_redeploy_status' && p.data.appSlug === a.slug);
  const reset = () => {
    deploys.calls.length = 0; deploys.next.length = 0; heals.calls.length = 0; heals.next.length = 0; pushed.length = 0;
  };
  // A report from the app-health clock (keyed by its run) or the error page.
  const report = (a, type, payload = {}, key = `t-${++rk}`) => rt.append(machine, appKey(a.id),
    { type, payload: { appId: a.id, ...payload } }, { requestKey: key, appId: a.id, source: { kind: 'system', name: 'test' } });
  const moved = (a, sha, { byHand = false, key = `drift:${a.id}:${sha}` } = {}) => rt.append(machine, appKey(a.id),
    { type: 'MainMoved', payload: { appId: a.id, sha, byHand } }, { requestKey: key, appId: a.id, source: { kind: 'system', name: 'drift' } });
  const outcomeOf = async (id) => (await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id])).rows[0];
  // The instance's data rewritten, as an older transition would have left it.
  const shiftData = async (a, fn) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      const { rows: [i] } = await c.query('SELECT data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, appKey(a.id)]);
      await c.query('UPDATE wf_instances SET data = $3 WHERE machine = $1 AND key = $2', [MACHINE, appKey(a.id), JSON.stringify(fn(i.data))]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const receipts = async (key) => Number((await pool.query('SELECT count(*) AS n FROM wf_receipts WHERE machine = $1 AND request_key = $2', [MACHINE, key])).rows[0].n);
  const workStatus = async (a, key) => (await pool.query('SELECT status FROM wf_work WHERE machine = $1 AND key = $2 AND work_key = $3', [MACHINE, appKey(a.id), key])).rows[0]?.status;
  const dueNow = async (a) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, appKey(a.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };

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
    assert.deepEqual(statusPushes(a).map((p) => [p.kind, p.routing, p.data.deploying]), [['scoped', { appSlug: a.slug }, true]]);
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

  await t.test('a merge that asked during a deploy waits for its own: that deploy started before its keys were applied', async () => {
    reset();
    const a = await app();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`INSERT INTO wf_instances (machine, key, app_id, state, data, version, machine_version)
        VALUES ('merge-followups', 'session:93', $1, 'delivering', $2, 1, 3)`,
      [a.id, JSON.stringify({ role: 'merge', delivery: 'app-delivery' })]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await ask(a, { reason: 'drift' });
    await rt.drain();
    await ask(a, { reason: 'merge', from: { machine: 'merge-followups', key: 'session:93' }, revision: SHA('9') });
    deploys.next.push({ sha: SHA('8') }, { throw: 'the build failed', permanent: true });
    await settle();
    assert.deepEqual((await told('merge-followups', 'session:93')).map((m) => m.type), ['DeliveryFailed'],
      'not the earlier deploy\'s Deployed: its own deploy\'s answer');
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
    assert.equal(await workStatus(a, 'deploy:1'), 'settled', 'its work is cancelled');
    await settle();
    assert.equal(deploys.calls.length, 0, 'never run');
    assert.equal((await inst(a)).state, 'idle');
    const forged = await rt.append(machine, appKey(a.id), { type: 'EndDeploy', payload: {} },
      { requestKey: `t-${++rk}`, appId: a.id, source: { kind: 'system' } });
    await rt.drain();
    assert.equal((await pool.query('SELECT reason FROM wf_events WHERE id = $1', [forged])).rows[0].reason, 'admin_only');
  });

  // ── Health ────────────────────────────────────────────────────────────

  await t.test('H1: an app reported down is healed once, as the machine\'s work, and not again inside its backoff', async () => {
    reset();
    const a = await app();
    await report(a, 'Unhealthy', { state: 'stopped' });
    await rt.drain();
    assert.equal((await inst(a)).state, 'healing');
    await report(a, 'Unhealthy', { state: 'stopped' });
    await report(a, 'Unreachable');
    await settle();
    assert.deepEqual(heals.calls.map((c) => c.key), ['heal:1'], 'one heal, however many reports');
    assert.equal(heals.calls[0].input.probe, false);
    assert.equal((await inst(a)).state, 'idle');
    // Down again at once: its backoff runs, nothing is healed, and the
    // report is refused, keeping nothing (a dead app is reported every
    // minute for days).
    const held = await report(a, 'Unhealthy', { state: 'stopped' }, 'in-backoff');
    await settle();
    assert.equal(heals.calls.length, 1, 'a heal right after a heal waits for its backoff');
    assert.deepEqual(await outcomeOf(held), { result: 'rejected', reason: 'backoff' });
    assert.equal(await receipts('in-backoff'), 0);
    // The backoff over (the last heal 11 minutes ago): healed again, the
    // second in a row, so the next backoff is twice as long.
    await shiftData(a, (d) => ({ ...d, heal: { ...d.heal, at: ago(11 * 60 * 1000) } }));
    await report(a, 'Unreachable');
    await settle();
    assert.deepEqual(heals.calls.map((c) => c.key), ['heal:1', 'heal:2']);
    assert.equal(heals.calls[1].input.probe, true, 'a person could not reach it: probed first');
    assert.equal((await inst(a)).data.heal.streak, 2);
    await shiftData(a, (d) => ({ ...d, heal: { ...d.heal, at: ago(11 * 60 * 1000) } }));
    await report(a, 'Unhealthy', { state: 'stopped' });
    await settle();
    assert.equal(heals.calls.length, 2, 'the second backoff is twenty minutes');
  });

  await t.test('H2: a heal that needs a deploy gets one; a report during a deploy is ignored; a failed heal deploy is not retried', async () => {
    reset();
    const a = await app();
    heals.next.push({ status: 'needs_deploy' });
    deploys.next.push({ throw: 'build broke', permanent: true });
    await report(a, 'Unhealthy', { state: 'not_found' });
    await rt.drain();
    await rt.runServices();   // the heal
    await rt.drain();
    assert.equal((await inst(a)).state, 'deploying');
    assert.deepEqual((await inst(a)).data.requests.map((r) => r.reason), ['heal']);
    const during = await report(a, 'Unhealthy', { state: 'not_found' });
    await rt.drain();
    assert.equal((await outcomeOf(during)).reason, 'deploying', 'the deploy replaces the runtime');
    await settle();
    assert.equal((await inst(a)).state, 'idle');
    assert.deepEqual((await inst(a)).data.requests, [], 'nobody to tell: the heal backoff asks again');
    assert.equal((await instDeadline(a)), null, 'no retry deadline for a heal');
  });

  await t.test('H3: a deploy asked for during a heal is deployed right after it', async () => {
    reset();
    const a = await app();
    await report(a, 'Unhealthy', { state: 'stopped' });
    await rt.drain();
    await ask(a, { reason: 'redeploy' });
    await rt.drain();
    assert.equal((await inst(a)).state, 'healing');
    assert.equal(deploys.calls.length, 0, 'no deploy beside a heal');
    await settle();
    assert.deepEqual(heals.calls.map((c) => c.key), ['heal:1']);
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1']);
    assert.equal((await inst(a)).state, 'idle');
  });

  await t.test('H4: a Docker container seen restarting is given its grace, then healed if it still is', async () => {
    reset();
    const a = await app({ runtime: 'docker' });
    await report(a, 'Unhealthy', { state: 'restarting' });
    await settle();
    assert.equal(heals.calls.length, 0, 'its restart policy is mid-backoff');
    const inGrace = await report(a, 'Unhealthy', { state: 'restarting' }, 'in-grace');
    await settle();
    assert.equal(heals.calls.length, 0, 'inside its grace');
    assert.deepEqual(await outcomeOf(inGrace), { result: 'rejected', reason: 'grace' });
    assert.equal(await receipts('in-grace'), 0);
    await shiftData(a, (d) => ({ ...d, heal: { ...d.heal, seenRestarting: ago(90 * 1000) } }));
    await report(a, 'Unhealthy', { state: 'restarting' });
    await settle();
    assert.equal(heals.calls.length, 1, 'still restarting after its grace');
    const k = await app();
    await report(k, 'Unhealthy', { state: 'restarting' });
    await settle();
    assert.equal(heals.calls.length, 2, 'Kubernetes: a crash loop is healed at once');
  });

  await t.test('H5: only the system reports, and never for an app that is not running', async () => {
    reset();
    const a = await app({ status: 'creating' });
    const id = await report(a, 'Unhealthy', { state: 'stopped' });
    await rt.drain();
    assert.equal((await outcomeOf(id)).reason, 'not_running');
    const b = await app();
    const forged = await rt.append(machine, appKey(b.id), { type: 'Unreachable', payload: { appId: b.id } },
      { requestKey: `t-${++rk}`, appId: b.id, source: { kind: 'admin' } });
    await rt.drain();
    assert.equal((await outcomeOf(forged)).reason, 'system_only');
  });

  await t.test('H6: a deploy is a new runtime: the heals before it hold back none after it', async () => {
    reset();
    const a = await app();
    await report(a, 'Unhealthy', { state: 'stopped' });
    await settle();
    assert.equal((await inst(a)).data.heal.streak, 1);
    await ask(a);
    await settle();
    assert.equal(deploys.calls.length, 1);
    assert.equal((await inst(a)).data.heal.streak, 0);
    await report(a, 'Unhealthy', { state: 'stopped' });
    await settle();
    assert.deepEqual(heals.calls.map((c) => c.key), ['heal:1', 'heal:2'], 'healed at once, inside the old backoff');
    assert.equal((await inst(a)).data.heal.streak, 1);
  });

  await t.test('H7: an admin ends a heal that never answers: its work is cancelled', async () => {
    reset();
    const a = await app();
    await report(a, 'Unhealthy', { state: 'stopped' });
    await rt.drain();
    assert.equal((await inst(a)).state, 'healing');
    await rt.append(machine, appKey(a.id), { type: 'EndDeploy', payload: {} },
      { requestKey: `t-${++rk}`, appId: a.id, source: { kind: 'admin' } });
    await rt.drain();
    assert.equal((await inst(a)).state, 'idle');
    assert.equal(await workStatus(a, 'heal:1'), 'settled');
    await settle();
    assert.equal(heals.calls.length, 0);
  });

  // ── Drift ─────────────────────────────────────────────────────────────

  await t.test('D1: main moving deploys once per commit; a drift a running deploy already covers adds nothing', async () => {
    reset();
    const a = await app({ mainSha: SHA('0') });
    await moved(a, SHA('1'));
    await moved(a, SHA('1'));   // the clock's next look, the same key
    await rt.drain();
    assert.equal((await inst(a)).state, 'deploying');
    // The clock looks again while it deploys, under another key (a restart's).
    const again = await moved(a, SHA('1'), { key: 'another-look' });
    await rt.drain();
    assert.equal((await outcomeOf(again)).reason, 'already_asked');
    // main moved again during the deploy: one more after it.
    await moved(a, SHA('2'));
    deploys.next.push({ sha: SHA('1') }, { sha: SHA('2') });
    await settle();
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1', 'deploy:2']);
    assert.equal((await row(a)).main_sha, SHA('2'));
    const none = await moved(a, SHA('2'), { key: 'no-drift' });
    await rt.drain();
    assert.equal((await outcomeOf(none)).reason, 'no_drift');
  });

  await t.test('D2: a drift seen during a deploy of that very commit is served by it', async () => {
    reset();
    const a = await app({ mainSha: SHA('0') });
    await ask(a, { reason: 'merge', from: { machine: 'merge-followups', key: 'session:70' } });
    await rt.drain();
    await moved(a, SHA('3'));   // the merge's own commit, seen by the clock mid-deploy
    deploys.next.push({ sha: SHA('3') });
    await settle();
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1'], 'no second deploy of the same commit');
    assert.deepEqual((await inst(a)).data.requests, []);
  });

  await t.test('D3: a failed drift deploy is tried again by its own deadline, backing off', async () => {
    reset();
    const a = await app({ mainSha: SHA('0') });
    deploys.next.push({ throw: 'registry down', permanent: true });
    await moved(a, SHA('4'));
    await settle();
    let i = await inst(a);
    assert.equal(i.state, 'idle');
    assert.deepEqual(i.data.requests.map((r) => r.reason), ['drift'], 'kept for its retry');
    assert.equal(i.data.retry.failures, 1);
    assert.equal(i.deadline_event.type, 'RetryDue');
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - (Date.now() + 30 * 60 * 1000)) < 60000, 'thirty minutes');
    // The clock sees the same commit again meanwhile: nothing new.
    const again = await moved(a, SHA('4'), { key: 'look-again' });
    await rt.drain();
    assert.equal((await outcomeOf(again)).reason, 'already_asked');
    // Its deadline: deployed again, and failing again doubles the wait.
    deploys.next.push({ throw: 'registry down', permanent: true });
    await shiftData(a, (d) => ({ ...d, retry: { ...d.retry, at: ago(1000) } }));
    await dueNow(a);
    await rt.fireTimers();
    await settle();
    i = await inst(a);
    assert.deepEqual(deploys.calls.map((c) => c.key), ['deploy:1', 'deploy:2']);
    assert.equal(i.data.retry.failures, 2);
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - (Date.now() + 60 * 60 * 1000)) < 60000, 'an hour');
    // It succeeds next time: the retry is over.
    await shiftData(a, (d) => ({ ...d, retry: { ...d.retry, at: ago(1000) } }));
    await dueNow(a);
    await rt.fireTimers();
    await settle();
    i = await inst(a);
    assert.equal(i.data.retry, null);
    assert.deepEqual(i.data.requests, []);
    assert.equal(i.deadline_at, null);
  });

  await t.test('D4: a commit whose image runs as root waits for a new one, unless asked by hand', async () => {
    reset();
    const a = await app({ mainSha: SHA('0'), lastFailure: { kind: 'root_image', sha: SHA('5'), stage: 'start' } });
    const auto = await moved(a, SHA('5'));
    await rt.drain();
    assert.equal((await outcomeOf(auto)).reason, 'waits_for_new_commit');
    await moved(a, SHA('5'), { byHand: true, key: 'by-hand' });
    await settle();
    assert.equal(deploys.calls.length, 1);
    assert.equal(deploys.calls[0].input.retrySameCommit, true);
    // A drift whose deploy is refused for the same reason is not kept.
    const b = await app({ mainSha: SHA('0') });
    deploys.next.push({ failed: 'root_image', message: 'runs as root' });
    await moved(b, SHA('6'));
    await settle();
    assert.deepEqual((await inst(b)).data.requests, []);
    assert.equal((await inst(b)).deadline_at, null);
  });

  await t.test('D5: a commit whose deploy just failed (any deploy) waits for its retry before drift deploys it; by hand it goes now', async () => {
    reset();
    const at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const a = await app({ mainSha: SHA('0'), lastFailure: { stage: 'build', sha: SHA('7'), at } });
    await moved(a, SHA('7'));
    await settle();
    let i = await inst(a);
    assert.equal(deploys.calls.length, 0, 'not deployed again at once');
    assert.deepEqual(i.data.requests.map((r) => r.reason), ['drift']);
    assert.equal(i.deadline_event.type, 'RetryDue');
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - (Date.parse(at) + 30 * 60 * 1000)) < 5000, 'thirty minutes after the failure');
    // A failure that named no commit (its clone failed) waits the same.
    const b = await app({ mainSha: SHA('0'), lastFailure: { stage: 'clone', sha: null, at } });
    await moved(b, SHA('8'));
    await settle();
    assert.equal(deploys.calls.length, 0);
    // A new commit is a new attempt, and a person's check goes now.
    const c = await app({ mainSha: SHA('0'), lastFailure: { stage: 'build', sha: SHA('7'), at } });
    await moved(c, SHA('9'));
    await moved(a, SHA('7'), { byHand: true, key: 'by-hand-7' });
    await settle();
    assert.equal(deploys.calls.length, 2);
    i = await inst(a);
    assert.deepEqual(i.data.requests, [], 'the deploy by hand served the drift it held too');
  });

  await t.test('D6: an admin ending a drift deploy keeps the drift for its retry', async () => {
    reset();
    const a = await app({ mainSha: SHA('0') });
    await moved(a, SHA('b'));
    await rt.drain();
    assert.equal((await inst(a)).state, 'deploying');
    await rt.append(machine, appKey(a.id), { type: 'EndDeploy', payload: {} },
      { requestKey: `t-${++rk}`, appId: a.id, source: { kind: 'admin' } });
    await rt.drain();
    const i = await inst(a);
    assert.equal(i.state, 'idle');
    assert.deepEqual(i.data.requests.map((r) => r.reason), ['drift'], 'nothing else would deploy that commit');
    assert.equal(i.deadline_event.type, 'RetryDue');
    assert.equal(await workStatus(a, 'deploy:1'), 'settled');
  });

  await t.test('D7: a retry that nothing here can serve any more tells whoever waits, and ends', async () => {
    reset();
    const a = await app({ mainSha: SHA('0') });
    deploys.next.push({ throw: 'registry down', permanent: true });
    await moved(a, SHA('c'));
    await settle();
    assert.equal((await inst(a)).data.retry.failures, 1);
    // One asker's request is open too, never told (an older transition's).
    await shiftData(a, (d) => ({ ...d, retry: { ...d.retry, at: ago(1000) }, nextId: d.nextId + 1,
      requests: [...d.requests, { id: d.nextId, reason: 'merge', from: { machine: 'merge-followups', key: 'session:d7-unserved' },
        at: ago(2000), prNumber: null, revision: null, reuse: null, told: false }] }));
    await pool.query('UPDATE apps SET repo_url = NULL WHERE id = $1', [a.id]);
    await dueNow(a);
    await rt.fireTimers();
    await settle();
    const i = await inst(a);
    assert.equal(deploys.calls.length, 1, 'not deployed again');
    assert.deepEqual(i.data.requests, []);
    assert.equal(i.data.retry, null);
    assert.equal(i.deadline_at, null);
    const said = await told('merge-followups', 'session:d7-unserved');
    assert.deepEqual(said.map((m) => [m.type, m.payload.message]), [['DeliveryFailed', 'the app has no repository to deploy from']]);
  });

  await t.test('D8: main moving back to a commit production ran before deploys it again', async () => {
    reset();
    const a = await app({ mainSha: SHA('0') });
    const A = SHA('d');
    const B = SHA('e');
    // Keyed as the main-drift clock keys a movement: from what production
    // runs, to the commit.
    deploys.next.push({ sha: A });
    await moved(a, A, { key: `drift:${a.id}:${SHA('0')}@1:${A}` });
    await settle();
    deploys.next.push({ sha: B });
    await moved(a, B, { key: `drift:${a.id}:${A}@2:${B}` });
    await settle();
    deploys.next.push({ sha: A });
    await moved(a, A, { key: `drift:${a.id}:${B}@3:${A}` });
    await settle();
    assert.equal(deploys.calls.length, 3);
    assert.equal((await row(a)).main_sha, A);
  });

  await t.test('only the machine writes the deploying state', async () => {
    const a = await app();
    await ask(a);
    await settle();
    await assert.rejects(pool.query(`UPDATE apps SET deploy_state = 'deploying' WHERE id = $1`, [a.id]), /WF_OWNERSHIP_VIOLATION/);
  });
});
