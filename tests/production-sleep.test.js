'use strict';

// test:changed: when src/services/production-sleep.js (idle admission and wake)
// test:changed: when src/services/gateway-activity.js (streaming safety)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const sleep = require('../src/services/production-sleep');
const { createActivity } = require('../src/services/gateway-activity');
const kubernetes = require('../src/services/kubernetes');

test('activity retains long requests and sockets until they end, without counting health checks', () => {
  let now = 100;
  const activity = createActivity({ now: () => now });
  const one = activity.begin('app', '/events');
  const two = activity.begin('app', '/socket');
  activity.begin('app', '/health?probe=1')();
  assert.equal(activity.snapshot().upstreams.app.active, 2);
  now = 200; one(); one();
  assert.equal(activity.snapshot().upstreams.app.active, 1);
  now = 300; two();
  assert.deepEqual(activity.snapshot().upstreams.app, { active: 0, lastRequestAt: 300 });
  const idle = { ...activity.snapshot(), now: 5000 };
  assert.equal(sleep.idleAt([idle], 'app', 5000, 1000), true);
  assert.equal(sleep.idleAt([{ ...idle, now: 0 }], 'app', 20000, 1000), false);
  assert.equal(sleep.idleAt([{ ...idle, overflow: true }], 'app', 5000, 1000), false);
  assert.equal(sleep.idleAt([], 'app', 5000, 1000), false);
  const overflow = createActivity({ maxEntries: 1 });
  overflow.begin('one', '/')(); overflow.begin('two', '/')();
  assert.equal(overflow.snapshot().overflow, true, 'lost observations prevent sleeping');
});

test('production sleep uses real SQL claims and session locks', { timeout: 120000 }, async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this check'); return;
  }
  const dbName = `app_sleep_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(dsn); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${dbName}`); await admin.end(); });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('sleep-owner', 'x') RETURNING id`);
  let seq = 0;
  async function fixture() {
    await pool.query('DELETE FROM app_runtime_sleep');
    const slug = `sleep-app-${++seq}`;
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, runtime_kind, runtime_name)
       VALUES ($1, $1, $2, 'running', 'kubernetes', $1) RETURNING *`, [slug, owner.id]);
    const config = { appRuntime: 'kubernetes', appSleepAppIds: [app.id], appSleepAfterMs: 3600000,
      kubernetes: { appGate: 'on', appNamespace: 'apps' } };
    let deployment = { metadata: { uid: 'uid', name: slug, resourceVersion: '1', annotations: {},
      labels: { 'social.usernode.io/environment': 'production' } },
    spec: { replicas: 1, template: { image: 'immutable', env: 'unchanged' } } };
    const fx = { config, app, active: 0, lastRequestAt: Date.now() - 7200000, telemetryError: false,
      conflict: false, sleepError: null, wakeError: false, scales: [], wakes: [], wait: async () => {},
      get deployment() { return deployment; },
      async row() { return (await pool.query('SELECT * FROM app_runtime_sleep WHERE app_id = $1', [app.id])).rows[0]; },
      async age() { await pool.query(`UPDATE app_runtime_sleep SET last_request_at = now() - interval '2 hours' WHERE app_id = $1`, [app.id]); },
    };
    fx.deps = { kubernetes: {
      async appGateActivity() {
        if (fx.telemetryError) throw new Error('gateway unavailable');
        return [{ version: 1, now: Date.now(), upstreams: { [slug]: { active: fx.active, lastRequestAt: fx.lastRequestAt } } }];
      },
      async readProductionForSleep() { return structuredClone(deployment); },
      async scaleProductionForSleep(_config, read, replicas, at) {
        if (fx.conflict) { deployment.metadata.resourceVersion = 'new-deploy'; return 'conflict'; }
        if (replicas === 0 && fx.sleepError === 'before') throw new Error('connection reset before the write');
        assert.equal(read.metadata.resourceVersion, deployment.metadata.resourceVersion);
        fx.scales.push(replicas); deployment = structuredClone(read);
        deployment.spec.replicas = replicas;
        deployment.metadata.resourceVersion += 'x';
        if (replicas === 0) deployment.metadata.annotations[sleep.ANNOTATION] = new Date(at).toISOString();
        else delete deployment.metadata.annotations[sleep.ANNOTATION];
        if (replicas === 0 && fx.sleepError === 'after') throw new Error('connection reset after the write');
        return 'scaled';
      },
      async waitForPreview() { await fx.wait(); },
    }, workflow: { async reportAppWake(id, key) {
      if (fx.wakeError) throw new Error('workflow unavailable');
      fx.wakes.push({ id, key });
    } } };
    await sleep.sweep(config, pool, { deps: fx.deps });
    return fx;
  }

  await t.test('new assignments observe a complete idle window; streams and fresh use prevent sleeping', async () => {
    const fx = await fixture();
    assert.equal(fx.scales.length, 0);
    await fx.age(); fx.active = 1;
    await sleep.sweep(fx.config, pool, { deps: fx.deps });
    assert.equal(fx.scales.length, 0);
    fx.active = 0; fx.lastRequestAt = Date.now();
    await sleep.sweep(fx.config, pool, { deps: fx.deps });
    assert.equal(fx.scales.length, 0);
  });

  await t.test('active lower IDs do not starve an idle app beyond the first twenty assignments', async () => {
    const prefix = `busy-before-${++seq}-`;
    const { rows: busy } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, runtime_kind, runtime_name)
       SELECT $1 || n, $1 || n, $2, 'running', 'kubernetes', $1 || n
         FROM generate_series(1, 20) n RETURNING id, runtime_name`, [prefix, owner.id]);
    const fx = await fixture();
    assert.ok(busy.every((app) => app.id < fx.app.id));
    fx.config.appSleepAppIds = [...busy.map((app) => app.id), fx.app.id];
    fx.deps.kubernetes.appGateActivity = async () => [{ version: 1, now: Date.now(), upstreams: {
      ...Object.fromEntries(busy.map((app) => [app.runtime_name, { active: 1, lastRequestAt: Date.now() - 7200000 }])),
      [fx.app.runtime_name]: { active: 0, lastRequestAt: Date.now() - 7200000 },
    } }];
    await sleep.sweep(fx.config, pool, { deps: fx.deps });
    await pool.query(`UPDATE app_runtime_sleep SET last_request_at = now() - interval '2 hours'
      WHERE app_id = ANY($1::int[])`, [fx.config.appSleepAppIds]);
    assert.equal((await sleep.sweep(fx.config, pool, { deps: fx.deps })).asleep, 1);
    assert.ok((await fx.row()).asleep_at);
    assert.deepEqual(fx.scales, [0]);
    const { rows } = await pool.query('SELECT asleep_at FROM app_runtime_sleep WHERE app_id = ANY($1::int[])',
      [busy.map((app) => app.id)]);
    assert.equal(rows.length, 20);
    assert.ok(rows.every((row) => row.asleep_at === null));
  });

  await t.test('telemetry failure leaves both SQL and runtime awake', async () => {
    const fx = await fixture(); await fx.age(); fx.telemetryError = true;
    assert.equal((await sleep.sweep(fx.config, pool, { deps: fx.deps })).telemetryUnavailable, true);
    assert.equal((await fx.row()).asleep_at, null);
    assert.equal(fx.scales.length, 0);
  });

  await t.test('sleep retains the runtime template; access requests a coalesced wake and probes do not', async () => {
    const fx = await fixture(); await fx.age();
    const template = structuredClone(fx.deployment.spec.template);
    assert.equal((await sleep.sweep(fx.config, pool, { deps: fx.deps })).asleep, 1);
    assert.deepEqual(fx.scales, [0]);
    assert.deepEqual(fx.deployment.spec.template, template);
    const before = await fx.row();
    const health = await sleep.access(pool, fx.app.id, '/health', { config: fx.config, deps: fx.deps });
    assert.equal(health.ready, false); assert.equal(health.waking, false);
    assert.equal((await fx.row()).last_request_at.getTime(), before.last_request_at.getTime());
    const decisions = await Promise.all(Array.from({ length: 12 }, () =>
      sleep.access(pool, fx.app.id, '/api/write', { config: fx.config, deps: fx.deps })));
    assert.ok(decisions.every((d) => !d.ready));
    assert.equal(new Set(fx.wakes.map((w) => w.key)).size, 1);
    let finish; let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    fx.wait = () => { started(); return new Promise((resolve) => { finish = resolve; }); };
    const wake = sleep.wake(fx.config, pool, fx.app.id, { deps: fx.deps });
    await waiting;
    // A readiness wait must not hold the activity admission lock.
    const during = await Promise.race([sleep.access(pool, fx.app.id, '/', { config: fx.config, deps: fx.deps }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('activity lock held through readiness')), 1000))]);
    assert.equal(during.ready, false);
    finish(); assert.equal((await wake).status, 'started');
    assert.equal((await fx.row()).asleep_at, null);
    assert.equal((await sleep.access(pool, fx.app.id, '/', { config: fx.config, deps: fx.deps })).ready, true);
    assert.deepEqual(fx.scales, [0, 1]);
  });

  await t.test('a newer deployment wins the sleep fence and the sleep claim is undone', async () => {
    const fx = await fixture(); await fx.age(); fx.conflict = true;
    assert.equal((await sleep.sweep(fx.config, pool, { deps: fx.deps })).asleep, 0);
    assert.equal((await fx.row()).asleep_at, null);
    assert.equal(fx.deployment.spec.replicas, 1);
  });

  for (const lost of ['before', 'after']) await t.test(`a response lost ${lost} scale-down retains a recoverable claim`, async () => {
    const fx = await fixture(); await fx.age(); fx.sleepError = lost;
    assert.equal((await sleep.sweep(fx.config, pool, { deps: fx.deps })).asleep, 0);
    assert.ok((await fx.row()).asleep_at, 'an uncertain provider write must not erase the wake intent');
    assert.equal(fx.deployment.spec.replicas, lost === 'after' ? 0 : 1);
    assert.equal(fx.wakes.length, 1, 'a bounded conductor wake recovers or fences the uncertain write');
    assert.equal((await sleep.access(pool, fx.app.id, '/', { config: fx.config, deps: fx.deps })).ready, false);
    assert.equal((await sleep.wake(fx.config, pool, fx.app.id, { deps: fx.deps })).status, 'started');
    assert.equal(fx.deployment.spec.replicas, 1);
    assert.equal((await fx.row()).asleep_at, null);
    assert.equal((await sleep.access(pool, fx.app.id, '/', { config: fx.config, deps: fx.deps })).ready, true);
  });

  await t.test('rollback can recover an ambiguous write even when the recovery wake could not be queued', async () => {
    const fx = await fixture(); await fx.age(); fx.sleepError = 'after'; fx.wakeError = true;
    await sleep.sweep(fx.config, pool, { deps: fx.deps });
    assert.equal(fx.deployment.spec.replicas, 0);
    assert.ok((await fx.row()).asleep_at);
    assert.equal(fx.wakes.length, 0);
    fx.wakeError = false;
    const disabled = { ...fx.config, appSleepAppIds: [], appSleepAfterMs: 0 };
    assert.equal((await sleep.sweep(disabled, pool, { deps: fx.deps })).waking, 1);
    await sleep.wake(disabled, pool, fx.app.id, { deps: fx.deps });
    assert.equal(fx.deployment.spec.replicas, 1);
    assert.equal((await fx.row()).asleep_at, null);
  });

  await t.test('activity racing a sleep claim is rechecked under the shared app lock', async () => {
    const fx = await fixture(); await fx.age();
    const read = fx.deps.kubernetes.readProductionForSleep;
    fx.deps.kubernetes.readProductionForSleep = async () => {
      await pool.query('UPDATE app_runtime_sleep SET last_request_at = now() WHERE app_id = $1', [fx.app.id]);
      return read();
    };
    await sleep.sweep(fx.config, pool, { deps: fx.deps });
    assert.equal(fx.scales.length, 0);
  });

  await t.test('disabling sleep schedules bounded workflow wakes even when telemetry is unavailable', async () => {
    const fx = await fixture(); await fx.age();
    await sleep.sweep(fx.config, pool, { deps: fx.deps });
    fx.telemetryError = true; fx.config.appSleepAfterMs = 0;
    assert.equal((await sleep.sweep(fx.config, pool, { deps: fx.deps })).waking, 1);
    assert.equal(fx.wakes.length, 1);
    await sleep.wake(fx.config, pool, fx.app.id, { deps: fx.deps });
    assert.equal((await fx.row()).asleep_at, null);
    await pool.query('DELETE FROM apps WHERE id = $1', [fx.app.id]);
    assert.equal(await fx.row(), undefined);
  });
});

test('production scale writes are fenced and wake fences even an already-awake runtime', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const writes = [];
  kubernetes._setClientsForTest({ apps: { async replaceNamespacedDeployment({ body }) { writes.push(body); } } });
  const deployment = { metadata: { name: 'app', uid: 'uid', resourceVersion: '7', annotations: {} },
    spec: { replicas: 1, template: { unchanged: true } }, status: {} };
  await kubernetes.scaleProductionForSleep({ kubernetes: { appNamespace: 'apps' } }, deployment, 1);
  assert.equal(writes[0].metadata.resourceVersion, '7');
  assert.ok(writes[0].metadata.annotations['social.usernode.io/production-wake-at']);
  assert.deepEqual(writes[0].spec.template, deployment.spec.template);
  let accepted;
  kubernetes._setClientsForTest({ apps: { async replaceNamespacedDeployment({ body }) {
    accepted = body;
    throw Object.assign(new Error('response lost after commit'), { code: 'ECONNRESET' });
  } } });
  await assert.rejects(kubernetes.scaleProductionForSleep({ kubernetes: { appNamespace: 'apps' } },
    deployment, 0, new Date().toISOString()), /response lost/);
  assert.equal(accepted.spec.replicas, 0);
  assert.ok(accepted.metadata.annotations[sleep.ANNOTATION]);
});
