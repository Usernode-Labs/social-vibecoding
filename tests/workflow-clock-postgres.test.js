'use strict';

// The clock machine (src/workflow/clock/): a platform job on a schedule,
// run as kernel work on whichever process runs the workflow, never two runs
// of one job at once however many processes run it, with what it found kept
// as its last run and handed to the next. Its targets (an effect owed once
// each) are items of their own, keyed by target and generation. The release
// arms what a build defines and retires what it dropped.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the clock machine runs each job once at a time, wherever the workflow runs', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_clock_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { createRuntime } = require('../src/workflow/kernel/index.ts');
  const { MACHINE, clock, clockKey } = require('../src/workflow/clock/machine.ts');
  const { clockServices } = require('../src/workflow/clock/services.ts');

  const make = (jobs) => {
    const r = createRuntime({ pool, machines: [clock()], services: clockServices(jobs, { config: {}, pool }), pollMs: 50 });
    runtimes.push(r);
    return r;
  };
  const arm = (r, job, everyMs, release = 'r1', firstDueAt = null) => r.appendAndWait(MACHINE, clockKey(job),
    { type: 'Arm', payload: { job, everyMs, firstDueAt } }, { requestKey: `arm:${release}`, source: { kind: 'system', name: 'release' } });
  const instance = async (job) => (await pool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey(job)])).rows[0];
  const until = async (check, what, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) { assert.ok(Date.now() < deadline, what); await sleep(25); }
  };

  await t.test('two processes: one run at a time, the next an interval after the last ends, its result handed on', async () => {
    let running = 0;
    let most = 0;
    const seen = [];
    const job = {
      name: 'count', everyMs: 300,
      async run(ctx) {
        running += 1; most = Math.max(most, running);
        seen.push(ctx.input.previous);
        await sleep(120);
        running -= 1;
        return { n: (ctx.input.previous?.n ?? 0) + 1 };
      },
    };
    const a = make([job]);
    const b = make([job]);
    await Promise.all([arm(a, 'count', 300), arm(b, 'count', 300)]);
    await a.start({ loops: true });
    await b.start({ loops: true });
    await until(async () => ((await instance('count'))?.data?.last?.n ?? 0) >= 4, 'four runs');
    assert.equal(most, 1, 'never two runs of one job at once');
    assert.deepEqual(seen.slice(0, 3), [null, { n: 1 }, { n: 2 }], 'each run hears the last one\'s result');
    const { data } = await instance('count');
    assert.equal(data.everyMs, 300);
    assert.ok(data.last.ok);
    await a.stop(); await b.stop();
  });

  await t.test('a failed run is recorded as failed, the next comes sooner, and what was kept stays', async () => {
    let calls = 0;
    const job = {
      name: 'flaky', everyMs: 60 * 60 * 1000,
      async run() { calls += 1; if (calls === 2) throw new Error('the provider blinked'); return { calls }; },
    };
    const r = make([job]);
    await arm(r, 'flaky', 60 * 60 * 1000);
    await r.start({ loops: true });
    await until(async () => (await instance('flaky'))?.data?.last?.n === 1, 'the first run');
    // Run it now: this one fails.
    await r.appendAndWait(MACHINE, clockKey('flaky'), { type: 'RunNow', payload: {} },
      { requestKey: 'admin:1', source: { kind: 'admin', name: 'console' } });
    await until(async () => (await instance('flaky'))?.data?.last?.n === 2, 'the failed run recorded');
    const { data } = await instance('flaky');
    assert.equal(data.last.ok, false);
    assert.match(data.last.error, /the provider blinked/);
    assert.equal(data.failures, 1);
    assert.deepEqual(data.kept, { calls: 1 }, 'a failed run keeps the last good result');
    const dueIn = Date.parse(data.due) - Date.parse(data.last.at);
    assert.ok(dueIn > 0 && dueIn <= 60 * 1000, `retried sooner than its hour (${dueIn} ms)`);
    await r.stop();
  });

  await t.test('targets: each an item of its own, once per generation, none while one is outstanding', async () => {
    const healed = [];
    let release = null;
    const gate = new Promise((r) => { release = r; });
    let gen = 0;
    const job = {
      name: 'targets', everyMs: 150,
      async run() { return { found: 2, items: [{ target: 'pr:1', gen: String(gen), input: { id: 1 } }, { target: 'pr:2', input: { id: 2 } }] }; },
      item: {
        async run(ctx) {
          healed.push(`${ctx.input.target}@${ctx.input.input.id}`);
          if (ctx.input.target === 'pr:2') await gate;
          return { ok: true };
        },
      },
    };
    const r = make([job]);
    await arm(r, 'targets', 150);
    await r.start({ loops: true });
    await until(async () => ((await instance('targets'))?.data?.last?.n ?? 0) >= 4, 'several runs');
    assert.deepEqual(healed.filter((h) => h.startsWith('pr:1')), ['pr:1@1'], 'the same target and generation once');
    assert.deepEqual(healed.filter((h) => h.startsWith('pr:2')), ['pr:2@2'], 'no second item while one is outstanding');
    gen = 1;
    await until(async () => healed.filter((h) => h.startsWith('pr:1')).length === 2, 'a new generation is a new item');
    release();
    const { data } = await instance('targets');
    assert.ok(data.last.result.items <= 2);
    await r.stop();
  });

  await t.test('Run now during a run runs once more after it; Retire cancels the run and stops the clock', async () => {
    let runs = 0;
    let stop = null;
    const job = {
      name: 'slow', everyMs: 60 * 60 * 1000,
      async run(ctx) {
        runs += 1;
        if (runs === 1) await new Promise((r) => { stop = r; ctx.signal.addEventListener('abort', r); });
        return { runs };
      },
    };
    const r = make([job]);
    await arm(r, 'slow', 60 * 60 * 1000);
    await r.start({ loops: true });
    await until(async () => (await instance('slow'))?.state === 'running', 'the first run');
    await r.appendAndWait(MACHINE, clockKey('slow'), { type: 'RunNow', payload: {} },
      { requestKey: 'admin:2', source: { kind: 'admin', name: 'console' } });
    assert.equal((await instance('slow')).data.again, true);
    stop();
    await until(async () => (await instance('slow'))?.data?.last?.n === 2, 'run again at once');
    assert.equal(runs, 2);
    await r.appendAndWait(MACHINE, clockKey('slow'), { type: 'Retire', payload: {} },
      { requestKey: 'retire:r2', source: { kind: 'system', name: 'release' } });
    const retired = await instance('slow');
    assert.equal(retired.state, 'retired');
    const { rows: [i] } = await pool.query('SELECT deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey('slow')]);
    assert.equal(i.deadline_at, null, 'no deadline once retired');
    // Defined again by a later build: armed again.
    await arm(r, 'slow', 60 * 60 * 1000, 'r3');
    assert.equal((await instance('slow')).state, 'waiting');
    await r.stop();
  });

  await t.test('a continuous job runs again as soon as a run ends', async () => {
    let runs = 0;
    const job = { name: 'drain', everyMs: 0, async run() { runs += 1; await sleep(20); return { runs }; } };
    const r = make([job]);
    await arm(r, 'drain', 0);
    await r.start({ loops: true });
    await until(async () => runs >= 5, 'back to back');
    await r.stop();
  });

  await t.test('the first run waits for the leader sweep it replaces, and an Arm moves an interval', async () => {
    const r = make([{ name: 'later', everyMs: 60 * 60 * 1000, async run() { return {}; } }]);
    await r.start({ loops: true });
    const first = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await arm(r, 'later', 60 * 60 * 1000, 'r1', first);
    assert.equal((await instance('later')).data.due, first);
    await arm(r, 'later', 10 * 60 * 1000, 'r2');
    const { data } = await instance('later');
    assert.equal(data.everyMs, 10 * 60 * 1000);
    assert.ok(Date.parse(data.due) <= Date.now() + 10 * 60 * 1000 + 1000, 'a shorter interval brings the due time in');
    await r.stop();
  });

  await t.test('a clock keeps a week of history', async () => {
    const r = make([]);
    // Aged as the kernel would have written them (its tables refuse other writers).
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_events SET processed_at = now() - interval '8 days' WHERE machine = 'clock' AND status = 'processed';
      UPDATE wf_work SET settled_at = now() - interval '8 days' WHERE machine = 'clock' AND status = 'settled';
      COMMIT`);
    assert.equal(await r.purge(), true);
    const { rows: [e] } = await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = $1 AND status = 'processed'`, [MACHINE]);
    const { rows: [w] } = await pool.query(`SELECT count(*)::int AS n FROM wf_work WHERE machine = $1 AND status = 'settled'`, [MACHINE]);
    assert.equal(e.n, 0);
    assert.equal(w.n, 0);
  });
});
