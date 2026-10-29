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

  await t.test('targets: each an item of its own, asked again by each run, once per generation it names, none while one is outstanding', async () => {
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
    // pr:2 names no generation: once its item ends, the next run asks again.
    release();
    await until(async () => healed.filter((h) => h.startsWith('pr:2')).length >= 2, 'each run asks again for what is still owed');
    const { data } = await instance('targets');
    assert.ok(data.last.result.items <= 2);
    await r.stop();
  });

  await t.test('a run asks for every target it found, not only the first ones', async () => {
    // The Workshop's sweep hands back up to 200 apps an hour: each gets its
    // item, every run (a cap below the list starved the rest).
    const seen = new Set();
    const job = {
      name: 'many', everyMs: 60 * 60 * 1000,
      async run() { return { items: Array.from({ length: 120 }, (_, i) => ({ target: `app:${i + 1}`, input: { i } })) }; },
      item: { concurrency: 8, async run(ctx) { seen.add(ctx.input.target); return {}; } },
    };
    const r = make([job]);
    await arm(r, 'many', 60 * 60 * 1000);
    await r.start({ loops: true });
    await until(async () => seen.size === 120, 'all 120 targets reconciled by one run');
    assert.equal((await instance('many')).data.last.result.items, 120);
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
    // The machine enters running before a service claims its work.
    await until(async () => (await instance('slow'))?.state === 'running' && typeof stop === 'function', 'the first handler entered');
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

  await t.test('an on-demand job runs only when an admin asks, one run at a time, and its run is read from any process', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let release = null;
    const asked = [];
    const job = {
      name: 'fleet', everyMs: 0, onDemand: true,
      async run(ctx) {
        asked.push(ctx.input.asked);
        const steps = ctx.steps({ owner: 'fleet' });
        await steps.once('first', () => 'done');
        await new Promise((r) => { release = r; ctx.signal.addEventListener('abort', r); });
        return { units: 1 };
      },
    };
    const r = make([job]);
    const ask = (by, key) => r.appendAndWait(MACHINE, clockKey('fleet'), { type: 'RunNow', payload: { by, userId: 3 } },
      { requestKey: `admin:${key}`, source: { kind: 'admin', name: 'console' } });
    await r.appendAndWait(MACHINE, clockKey('fleet'), { type: 'Arm', payload: { job: 'fleet', everyMs: DAY, onDemand: true, firstDueAt: new Date(Date.now() - 1000).toISOString() } },
      { requestKey: 'arm:r1', source: { kind: 'system', name: 'release' } });
    await r.start({ loops: true });
    const deadline = async () => (await pool.query('SELECT deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey('fleet')])).rows[0].deadline_at;
    await until(async () => (await instance('fleet'))?.state === 'waiting', 'armed');
    assert.equal(await deadline(), null, 'no deadline: nothing runs it but an admin');
    await sleep(200);
    assert.equal((await instance('fleet')).state, 'waiting');
    assert.deepEqual(asked, []);

    assert.equal((await ask('ada', 1)).status, 'accepted');
    await until(async () => release !== null, 'the run asked for');
    assert.deepEqual(asked, [{ by: 'ada', userId: 3 }], 'the run knows who asked');
    const second = await ask('bob', 2);
    assert.equal(second.status, 'rejected', 'one run at a time: a second press is refused, not queued');
    assert.equal(second.reason, 'running');
    const { clockRunOf } = require('../src/workflow/platform.ts');
    await until(async () => (await clockRunOf(pool, 'fleet'))?.checkpoint?.first === 'done', 'its checkpoint, read from the database');
    const under = await clockRunOf(pool, 'fleet');
    assert.equal(under.running, true);
    assert.deepEqual(under.input.asked, { by: 'ada', userId: 3 });
    release();
    await until(async () => (await instance('fleet'))?.data?.last?.n === 1, 'the run ended');
    const ended = await clockRunOf(pool, 'fleet');
    assert.equal(ended.running, false);
    assert.deepEqual(ended.result, { units: 1 });
    assert.equal((await instance('fleet')).state, 'waiting');
    assert.equal(await deadline(), null, 'it waits to be asked again');
    await r.stop();
  });

  await t.test('an on-demand job armed on an interval by an older build does nothing when nobody asked', async () => {
    let runs = 0;
    const r = make([{ name: 'fleet-old', everyMs: 0, onDemand: true, async run() { runs += 1; return {}; } }]);
    // An older build knows no on-demand job: it arms it on its interval, due now.
    await arm(r, 'fleet-old', 24 * 60 * 60 * 1000, 'r0', new Date(Date.now() - 1000).toISOString());
    await r.start({ loops: true });
    await until(async () => (await instance('fleet-old'))?.data?.last?.n === 1, 'the scheduled run');
    assert.equal(runs, 0);
    assert.deepEqual((await instance('fleet-old')).data.kept, { skipped: 'not_asked' });
    // An admin's press says the job is asked for, not scheduled: it runs, a
    // second press meanwhile is refused, and it waits with no deadline after.
    let release;
    const gate = new Promise((res) => { release = res; });
    r.stop && await r.stop();
    const r2 = make([{ name: 'fleet-old', everyMs: 0, onDemand: true, async run(ctx) { runs += 1; await gate; return { asked: ctx.input.asked }; } }]);
    await r2.start({ loops: true });
    const press = (key) => r2.appendAndWait(MACHINE, clockKey('fleet-old'), { type: 'RunNow', payload: { by: 'ada', userId: 3, onDemand: true } },
      { requestKey: `admin:old-${key}`, source: { kind: 'admin', name: 'console' } });
    assert.equal((await press(1)).status, 'accepted');
    await until(async () => runs === 1, 'the asked run');
    const second = await press(2);
    assert.deepEqual([second.status, second.reason], ['rejected', 'running']);
    release();
    await until(async () => (await instance('fleet-old'))?.data?.last?.n === 2, 'it ended');
    const healed = await instance('fleet-old');
    assert.equal(healed.data.onDemand, true);
    const { rows: [i] } = await pool.query('SELECT deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, clockKey('fleet-old')]);
    assert.equal(i.deadline_at, null, 'no deadline any more');
    await r2.stop();
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

  // What a new conductor relies on to open web readiness at once
  // (src/workflow/platform.ts pullInSecurityClock): an Arm at one second and
  // then at the job's interval, applied by any build alike, makes a waiting
  // run due now and leaves the interval as it was.
  await t.test('an Arm at one second then at its interval runs a waiting job now and keeps the interval', async () => {
    let runs = 0;
    const r = make([{ name: 'barrier', everyMs: 60 * 1000, async run() { runs += 1; return {}; } }]);
    await r.start({ loops: true });
    await arm(r, 'barrier', 60 * 1000, 'r1', new Date(Date.now() + 60 * 1000).toISOString());
    assert.equal(runs, 0);
    await r.appendAndWait(MACHINE, clockKey('barrier'), { type: 'Arm', payload: { job: 'barrier', everyMs: 1000, onDemand: false } },
      { requestKey: 'pull-in:r1', source: { kind: 'system', name: 'release' } });
    await r.appendAndWait(MACHINE, clockKey('barrier'), { type: 'Arm', payload: { job: 'barrier', everyMs: 60 * 1000, onDemand: false } },
      { requestKey: 'pull-back:r1', source: { kind: 'system', name: 'release' } });
    const pulled = (await instance('barrier')).data;
    assert.equal(pulled.everyMs, 60 * 1000, 'the interval is the job\'s again');
    assert.ok(Date.parse(pulled.due) <= Date.now() + 1000, 'due within a second');
    await until(async () => runs === 1 && (await instance('barrier')).data.last?.ok === true, 'the pulled-in run ran');
    const after = (await instance('barrier')).data;
    assert.ok(Date.parse(after.due) >= Date.now() + 50 * 1000, 'and the next is an interval on');
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
