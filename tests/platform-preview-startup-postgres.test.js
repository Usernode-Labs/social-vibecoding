'use strict';
// test:changed: when src/workflow/platform.ts (security clock boot ordering)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { Pool } = require('pg');
const startup = require('../src/services/platform-preview-startup');
const retirement = require('../src/services/platform-preview-retirement');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { MACHINE, clock, clockKey } = require('../src/workflow/clock/machine.ts');
const { JOBS, clockServices } = require('../src/workflow/clock/services.ts');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const config = { appRuntime: 'kubernetes', edgeJwtSecret: 'fake-startup-receipt-key', kubernetes: { appNamespace: 'fake-apps' } };

test('web boot waits for fresh conductor retirement using only a read-only database login', async t => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (error) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw error;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const suffix = crypto.randomBytes(6).toString('hex');
  const name = `preview_boot_${suffix}`, role = `preview_web_${suffix}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fake-local-test-password'`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url) });
  pool.on('error', () => {});
  const saved = { role: process.env.PROCESS_ROLE, sha: process.env.GIT_SHA, staging: process.env.USERNODE_ENV, retire: retirement.retire };
  process.env.PROCESS_ROLE = 'conductor'; process.env.GIT_SHA = 'a'.repeat(40); delete process.env.USERNODE_ENV;
  const children = new Set();
  let runtime;
  t.after(async () => {
    for (const child of children) child.kill();
    await runtime?.stop();
    retirement.retire = saved.retire;
    for (const [key, value] of [['PROCESS_ROLE', saved.role], ['GIT_SHA', saved.sha], ['USERNODE_ENV', saved.staging]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${role}`); await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT SELECT ON wf_instances TO ${role}`);
  const reader = new URL(url); reader.username = role; reader.password = 'fake-local-test-password';
  let scans = 0, failure = null, scanning = null;
  retirement.retire = async () => {
    assert.ok(['conductor', 'all'].includes(process.env.PROCESS_ROLE)); scans++;
    if (failure) throw failure;
    if (scanning) await scanning();
    return { examined: 2, retired: 1 };
  };
  const deps = { config, pool, previewRetirement: await startup.beforeServe(config, pool) };
  const job = JOBS.find(job => job.name === startup.JOB);
  runtime = createRuntime({ pool, machines: [clock()], services: clockServices([job], deps) });
  await runtime.append(MACHINE, clockKey(job.name), { type: 'Arm', payload: { job: job.name, everyMs: job.everyMs } },
    { requestKey: 'arm:test', source: { kind: 'system', name: 'release' } });
  await runtime.drain();

  function web(overrides = {}) {
    const env = { ...process.env, PROCESS_ROLE: 'web', PREVIEW_STARTUP_TEST_URL: String(reader),
      PREVIEW_STARTUP_TEST_CONFIG: JSON.stringify(config), ...overrides };
    delete env.NODE_TEST_CONTEXT;
    const child = fork(require.resolve('./fixtures/preview-startup-web'), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    const queue = []; let receiver;
    child.on('message', message => { if (receiver) { const r = receiver; receiver = null; r(message); } else queue.push(message); });
    child.on('exit', code => {
      children.delete(child);
      if (code) { const message = { type: 'crashed', code, errors }; if (receiver) receiver(message); else queue.push(message); }
    });
    return {
      poll: (expire = false) => child.send({ expire }),
      next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`web fixture did not answer: ${errors}`)), 20000);
        receiver = message => { clearTimeout(timer); resolve(message); };
      }),
    };
  }
  const waiting = async w => {
    const message = await w.next(); assert.equal(message.type, 'waiting');
    assert.deepEqual(message.grants, { read: true, write: false, append: false, read_apps: false }); assert.equal(message.privilegedCalls, 0);
  };
  const refused = async w => {
    w.poll(true); const message = await w.next(); assert.equal(message.type, 'refused');
    assert.match(message.message, /conductor has not confirmed preview retirement/); assert.equal(message.privilegedCalls, 0);
  };
  const run = async ({ settle = true } = {}) => {
    await runtime.append(MACHINE, clockKey(job.name), { type: 'RunNow', payload: {} },
      { requestKey: crypto.randomUUID(), source: { kind: 'admin', name: 'test' } });
    await runtime.drain(); await runtime.runServices(); if (settle) await runtime.drain();
  };
  const report = async last => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.wf_writer = 'transition'`);
      const { rows: [time] } = await client.query('SELECT clock_timestamp()::text AS at');
      await client.query(`UPDATE wf_instances SET data = jsonb_set(data, '{last}', $1::jsonb) WHERE machine = $2 AND key = $3`,
        [JSON.stringify({ ...last, at: time.at }), MACHINE, clockKey(job.name)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };

  await t.test('the boot scan becomes a durable clock result without a duplicate inventory', async () => {
    const w = web(); await waiting(w);
    await run({ settle: false });
    w.poll(); await waiting(w);
    await runtime.drain(); w.poll();
    const message = await w.next(); assert.equal(message.type, 'ready');
    assert.equal(message.result.retired, 1); assert.equal(message.privilegedCalls, 0); assert.equal(scans, 1);
    assert.deepEqual(message.result.checkedAt, deps.previewRetirement.checkedAt);
    await run(); assert.equal(scans, 2, 'subsequent clock ticks run a new inventory');
  });
  await t.test('a web restart during a short conductor outage reuses recent matching proof', async () => {
    const { rows: [prior] } = await pool.query(
      `SELECT clock_timestamp()::text AS now, data->'last' AS last FROM wf_instances WHERE machine = $1 AND key = $2`, [MACHINE, clockKey(job.name)]);
    await report({ ...prior.last, result: { ...prior.last.result,
      checkedAt: new Date(Date.parse(prior.now) - 2 * job.everyMs).toISOString() } });
    const before = scans;
    for (let n = 0; n < 2; n++) {
      const message = await web().next(); assert.equal(message.type, 'ready');
      assert.equal(message.privilegedCalls, 0);
    }
    assert.equal(scans, before, 'no conductor ran for either web restart');
  });
  await t.test('a recent in-flight scan may finish and open the barrier after web boots', async () => {
    await report({ ok: false, result: null });
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    scanning = () => { entered(); return gate; };
    const running = run(); await started;
    const w = web();
    try { await waiting(w); } finally { release(); await running; scanning = null; }
    w.poll(); assert.equal((await w.next()).type, 'ready');
  });
  await t.test('old conductor results, failed checks and future timestamps fail closed', async () => {
    for (const result of [
      { ok: true, result: { examined: 2, retired: 0 } },
      { ok: false, result: (await pool.query('SELECT data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey(job.name)])).rows[0].data.last.result },
    ]) {
      await report(result);
      const w = web(); await waiting(w);
      await refused(w);
    }
    const w = web(); await waiting(w); failure = new Error('inventory unavailable');
    await run(); failure = null;
    assert.equal((await pool.query('SELECT data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey(job.name)])).rows[0].data.last.ok, false);
    await refused(w);
    // A malformed/future report is never evidence that retirement has run.
    const future = web(); await waiting(future);
    const value = { ...await startup.check(config, pool), checkedAt: '2099-01-01T00:00:00Z' };
    await report({ ok: true, result: value });
    await refused(future);
  });
  await t.test('an expired successful proof refuses startup, despite a matching scope', async () => {
    const value = await startup.check(config, pool);
    value.checkedAt = new Date(Date.parse(value.checkedAt) - startup.MAX_AGE_MS - 5000).toISOString();
    await report({ ok: true, result: value });
    const w = web(); await waiting(w); await refused(w);
    assert.equal(startup.MAX_AGE_MS, job.everyMs * 3);
    assert.ok(startup.WAIT_MS >= 2 * job.everyMs + 30_000 + 30_000);
  });
  await t.test('another release, key or runtime namespace cannot satisfy web startup', async () => {
    for (const overrides of [
      { GIT_SHA: 'b'.repeat(40) },
      { PREVIEW_STARTUP_TEST_CONFIG: JSON.stringify({ ...config, edgeJwtSecret: 'rotated-fake-key' }) },
      { PREVIEW_STARTUP_TEST_CONFIG: JSON.stringify({ ...config, kubernetes: { appNamespace: 'other' } }) },
      { PREVIEW_STARTUP_TEST_CONFIG: JSON.stringify({ ...config, appRuntime: 'docker' }) },
    ]) {
      const w = web(overrides); await waiting(w); await run(); await refused(w);
    }
  });
  await t.test('an older conductor cannot publish a proof after a newer conductor registers', async () => {
    await report({ ok: false, result: null });
    const w = web(); await waiting(w); const before = scans;
    await pool.query(`INSERT INTO platform_processes (id, release, role) VALUES ('newer-conductor', $1, 'conductor')`, ['b'.repeat(40)]);
    try { await run(); assert.equal(scans, before); await refused(w); }
    finally { await pool.query(`DELETE FROM platform_processes WHERE id = 'newer-conductor'`); }
  });
  await t.test('a later failed clock run cannot be hidden by reusing the boot scan', async () => {
    const boot = await startup.beforeServe(config, pool);
    deps.previewRetirement = boot;
    await report({ ok: false, result: null });
    const before = scans; failure = new Error('inventory still unavailable');
    try { await run(); } finally { failure = null; }
    assert.equal(scans, before + 1, 'a later clock result prevents reusing the earlier scan');
    const w = web(); await waiting(w); await refused(w);
  });
  await t.test('a missing receipt key cannot disable periodic retirement or publish proof', async () => {
    deps.previewRetirement = await startup.beforeServe(config, pool);
    const edgeKey = process.env.EDGE_JWT_SECRET; delete process.env.EDGE_JWT_SECRET;
    const keyedConfig = deps.config; deps.config = { ...config, edgeJwtSecret: undefined };
    const before = scans;
    try {
      await run();
      assert.equal(scans, before + 1);
      const last = (await pool.query('SELECT data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey(job.name)])).rows[0].data.last;
      assert.equal(last.ok, false); assert.match(last.error, /runtime receipt key is unavailable/);
      const w = web(); await waiting(w); await refused(w);
    } finally { deps.config = keyedConfig; if (edgeKey !== undefined) process.env.EDGE_JWT_SECRET = edgeKey; }
  });
  await t.test('expired or mismatched boot results cause an actual clock inventory', async () => {
    for (const invalid of [{ checkedAt: '2000-01-01T00:00:00Z' }, { scope: 'obsolete-policy' }]) {
      deps.previewRetirement = { ...await startup.beforeServe(config, pool), ...invalid };
      const before = scans; await run(); assert.equal(scans, before + 1);
    }
  });
  await t.test('a keyless conductor or all boot retires, logs the missing proof and leaves web closed', async () => {
    await report({ ok: false, result: null });
    const logger = require('../src/services/logger');
    const warn = logger.warn, edgeKey = process.env.EDGE_JWT_SECRET;
    const unkeyed = { ...config, edgeJwtSecret: undefined }, warnings = [];
    delete process.env.EDGE_JWT_SECRET;
    logger.warn = (...args) => { warnings.push(args); };
    const before = scans;
    try {
      for (const role of ['conductor', 'all']) {
        process.env.PROCESS_ROLE = role;
        const result = await startup.beforeServe(unkeyed, pool);
        assert.deepEqual(result, { examined: 2, retired: 1 }, 'retirement succeeds without inventing a proof');
      }
      assert.equal(scans, before + 2); assert.equal(warnings.length, 2);
      for (const [category, message, detail] of warnings) {
        assert.equal(category, 'preview-policy');
        assert.match(message, /without readiness proof/);
        assert.match(detail.message, /runtime receipt key is unavailable/);
      }
      failure = new Error('unsafe preview could not be retired');
      await assert.rejects(startup.beforeServe(unkeyed, pool), /unsafe preview could not be retired/);
      assert.equal(warnings.length, 2, 'retirement errors are never swallowed'); failure = null;
      process.env.PROCESS_ROLE = 'web';
      await assert.rejects(startup.beforeServe(unkeyed, pool), /runtime receipt key is unavailable/);
      const w = web(); await waiting(w); await refused(w);
    } finally {
      failure = null; process.env.PROCESS_ROLE = 'conductor'; logger.warn = warn;
      if (edgeKey !== undefined) process.env.EDGE_JWT_SECRET = edgeKey;
    }
  });
  await t.test('all/conductor preserve the pre-work scan and its failures; staging does no runtime work', async () => {
    for (const role of ['all', 'conductor']) {
      process.env.PROCESS_ROLE = role;
      retirement.retire = async () => { throw new Error('cannot retire unsafe preview'); };
      await assert.rejects(startup.beforeServe(config, pool), /cannot retire unsafe preview/);
    }
    process.env.USERNODE_ENV = 'staging';
    assert.deepEqual(await startup.beforeServe({}, pool), { skipped: 'staging' });
    delete process.env.USERNODE_ENV; process.env.PROCESS_ROLE = 'web';
    await assert.rejects(startup.check(config, pool), /requires a conductor/);
    await assert.rejects(startup.beforeServe({}, pool), /runtime receipt key is unavailable/);
    await assert.rejects(startup.beforeServe(config, { query: async () => { throw new Error('database unavailable'); } }), /database unavailable/);
  });
});

test('the security barrier precedes serving, and its clock does not wait for release adoption', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = server.slice(server.indexOf('async function start()'));
  const barrier = start.indexOf("require('./src/services/platform-preview-startup').beforeServe");
  assert.ok(barrier >= 0 && barrier < start.indexOf('.startWorkflow(config'));
  assert.ok(barrier < start.indexOf('app.listen('));
  assert.doesNotMatch(start, /platform-preview-retirement/);
  assert.match(start, /if \(processRole\.runsWorkflow\(ownRole\)\) worker\.ensureWorkerImage\(\)/);
  const platform = fs.readFileSync(require.resolve('../src/workflow/platform.ts'), 'utf8');
  const loops = platform.slice(platform.indexOf('export async function startWorkflowLoops()'), platform.indexOf('const ADOPTIONS'));
  assert.ok(loops.indexOf('clockKey(job.name)') >= 0);
  assert.ok(loops.indexOf('clockKey(job.name)') < loops.indexOf("type: 'Booted'"));
  assert.ok(loops.indexOf('clockKey(job.name)') < loops.indexOf('runtime.start('));
  assert.match(loops, /firstDueAt: new Date\(\)\.toISOString\(\)/);
});
