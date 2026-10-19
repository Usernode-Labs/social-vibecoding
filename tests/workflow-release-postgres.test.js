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
  const make = () => {
    const r = createRuntime({ pool, machines: [releaseMachine()], services: releaseServices({ adoptions }), pollMs: 50 });
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
    const a = make();
    const b = make();
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
      pool, machines: [releaseMachine()], pollMs: 50,
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

  await t.test('adoptions that keep failing end the release failed, for a person to see', async () => {
    ran.length = 0;
    failNext = 100;
    const r = createRuntime({
      pool, machines: [releaseMachine()], pollMs: 50,
      services: { 'release.adopt': { ...releaseServices({ adoptions })['release.adopt'], backoffMs: () => 0 } },
    });
    runtimes.push(r);
    await booted(r, 'sha-3');
    await r.start({ loops: true });
    await until(async () => (await instance('sha-3'))?.state === 'failed', 'the release failed');
    assert.equal((await instance('sha-3')).data.error, 'the database blinked');
    const { inspect } = require('../src/workflow/kernel/index.ts');
    const p = await inspect.problems(pool, { attention: [{ machine: MACHINE, state: 'failed', says: 'x' }] });
    assert.ok(p.waiting.some((i) => i.key === releaseKey('sha-3')));
    await r.stop();
    failNext = 0;
  });
});
