'use strict';

// The release machine (src/workflow/release/): what a release owes what an
// older one left (the boot adoptions) runs once per release, whichever of a
// release's processes boots first and however many run the workflow, as
// resumable work: a step a restart cut is carried on, not done again, and a
// release whose adoptions fail for good says so in Admin → Workflows.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a release\'s adoptions run once, between all its processes, and a failed step is tried again', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_release_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  // The DROP below forces the runtimes' connections closed: reported here.
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
  const { MACHINE, releaseKey, releaseMachine } = require('../src/workflow/release/machine.ts');
  const { releaseServices } = require('../src/workflow/release/services.ts');
  const ran = [];
  let failNext = 0;
  const adoptions = [
    ['first', async (release) => { ran.push(['first', release]); return 1; }],
    ['second', async (release) => {
      if (failNext > 0) { failNext -= 1; throw new Error('the database blinked'); }
      ran.push(['second', release]);
      return 2;
    }],
  ];
  const make = (release) => {
    const r = createRuntime({ pool, machines: [releaseMachine()], services: releaseServices({ adoptions }), pollMs: 50, release });
    runtimes.push(r);
    return r;
  };
  const booted = (r, release) => r.append(MACHINE, releaseKey(release), { type: 'Booted', payload: { release } },
    { requestKey: `booted:${release}`, source: { kind: 'system', name: 'boot' } });
  const instance = async (release) => (await pool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, releaseKey(release)])).rows[0];
  const until = async (check, what) => {
    const deadline = Date.now() + 20000;
    while (!(await check())) { assert.ok(Date.now() < deadline, what); await sleep(25); }
  };

  await t.test('two processes of one release boot: the adoptions run once', async () => {
    const a = make('sha-1');
    const b = make('sha-1');
    await Promise.all([booted(a, 'sha-1'), booted(b, 'sha-1')]);
    await a.start({ loops: true });
    await b.start({ loops: true });
    await until(async () => (await instance('sha-1'))?.state === 'done', 'the release adopted');
    assert.deepEqual(ran, [['first', 'sha-1'], ['second', 'sha-1']]);
    assert.deepEqual((await instance('sha-1')).data.adopted, { first: 1, second: 2 });
    // A later boot of the same release (a crash, a third replica) owes nothing.
    await booted(a, 'sha-1');
    await sleep(300);
    assert.equal(ran.length, 2);
    await a.stop();
    await b.stop();
  });

  await t.test('a step that failed is tried again; the ones done are not run again', async () => {
    ran.length = 0;
    failNext = 1;
    const r = createRuntime({
      pool, machines: [releaseMachine()], pollMs: 50, release: 'sha-2',
      services: { 'release.adopt': { ...releaseServices({ adoptions })['release.adopt'], backoffMs: () => 0 } },
    });
    runtimes.push(r);
    await booted(r, 'sha-2');
    await r.start({ loops: true });
    await until(async () => (await instance('sha-2'))?.state === 'done', 'adopted on its second try');
    assert.deepEqual(ran, [['first', 'sha-2'], ['second', 'sha-2']], 'the first step ran once');
    const { rows: [w] } = await pool.query(`SELECT attempt_count FROM wf_work WHERE key = $1`, [releaseKey('sha-2')]);
    assert.equal(w.attempt_count, 2);
    await r.stop();
  });

  await t.test('an adoption that keeps failing is kept as its error; the others still run', async () => {
    ran.length = 0;
    failNext = 100;
    const r = createRuntime({
      pool, machines: [releaseMachine()], pollMs: 50, release: 'sha-3',
      services: { 'release.adopt': { ...releaseServices({ adoptions })['release.adopt'], backoffMs: () => 0 } },
    });
    runtimes.push(r);
    await booted(r, 'sha-3');
    await r.start({ loops: true });
    await until(async () => (await instance('sha-3'))?.state === 'done', 'the release adopted what it could');
    assert.deepEqual((await instance('sha-3')).data.adopted, { first: 1, second: { error: 'the database blinked' } });
    assert.deepEqual(ran, [['first', 'sha-3']], 'the first step ran once, through every retry of the second');
    await r.stop();
    failNext = 0;
  });

  await t.test('an older build still running during a rollout never runs the new release\'s adoptions', async () => {
    ran.length = 0;
    const old = make('sha-old');
    await old.start({ loops: true });
    // The new build's first process says it booted before its loops start.
    const fresh = make('sha-new');
    await booted(fresh, 'sha-new');
    await sleep(600);
    assert.deepEqual(ran, [], 'the older build left it alone');
    assert.equal((await instance('sha-new')).state, 'adopting');
    const { inspect } = require('../src/workflow/kernel/index.ts');
    const seenByOld = await inspect.problems(pool, { ...old.workLimits(), unclaimedMs: 0 });
    assert.equal(seenByOld.unclaimed.length, 0, 'and does not report it as nobody\'s');
    await fresh.start({ loops: true });
    await until(async () => (await instance('sha-new'))?.state === 'done', 'adopted by its own release');
    assert.deepEqual(ran, [['first', 'sha-new'], ['second', 'sha-new']]);
    const { rows: [w] } = await pool.query(
      `SELECT a.service_id FROM wf_work_attempts a JOIN wf_work w ON w.id = a.work_id WHERE w.key = $1`, [releaseKey('sha-new')]);
    assert.ok(w, 'claimed once');
    await old.stop();
    await fresh.stop();
  });

  await t.test('a release none of whose processes took its adoptions is abandoned; one whose process is at it waits', async () => {
    // Time passing, and a process's claim, written as the kernel writes them.
    const asKernel = async (sql, values) => {
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c.query(sql, values);
        await c.query('COMMIT');
      } finally { c.release(); }
    };
    // Replaced before its loops ran: nobody of its release will claim it.
    const r = make('sha-later');
    await booted(r, 'sha-gone');
    await r.drain();
    assert.ok((await pool.query('SELECT deadline_at FROM wf_instances WHERE key = $1', [releaseKey('sha-gone')])).rows[0].deadline_at,
      'a release gives its processes a while to take its work');
    await asKernel(`UPDATE wf_instances SET deadline_at = now() - interval '1 second' WHERE key = $1`, [releaseKey('sha-gone')]);
    await r.fireTimers();
    await r.drain();
    assert.equal((await instance('sha-gone')).state, 'abandoned');
    const { rows: [w] } = await pool.query(
      `SELECT status, result FROM wf_work WHERE key = $1`, [releaseKey('sha-gone')]);
    assert.equal(w.status, 'settled');
    assert.equal(w.result.cancelled, true, 'its work given up, so nothing waits on it');

    // Its own process holds the work (a long adoption): the deadline waits.
    await booted(r, 'sha-slow');
    await r.drain();
    await asKernel(
      `UPDATE wf_work SET status = 'running', claim_id = gen_random_uuid(), lease_until = now() + interval '1 minute' WHERE key = $1`,
      [releaseKey('sha-slow')]);
    await asKernel(`UPDATE wf_instances SET deadline_at = now() - interval '1 second' WHERE key = $1`, [releaseKey('sha-slow')]);
    await r.fireTimers();
    await r.drain();
    const slow = (await pool.query('SELECT state, deadline_at FROM wf_instances WHERE key = $1', [releaseKey('sha-slow')])).rows[0];
    assert.equal(slow.state, 'adopting');
    assert.ok(new Date(slow.deadline_at) > new Date(), 'asked again later');
  });
});
