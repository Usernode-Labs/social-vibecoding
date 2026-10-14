'use strict';

// The bot-build machine wired into the platform (src/workflow/platform.ts,
// src/workflow/bot-build/, docs/plans/bot-build-workflow.md), on the full
// PostgreSQL schema with a running runtime. The targets' pipelines are stood
// in for (services/build-runs.js TARGETS); everything between them is real:
// a build asked for runs once and its caller hears its result; a restart in
// the middle gives the lease up at once and the next runtime carries the
// build on from the step it saved, its lost attempt not counted as a try;
// and a build whose handler keeps failing ends failed, recorded as lost.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('bot builds through the platform runtime', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_bot_build_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const id = require.resolve('../src/db/pool');
  require.cache[id] = { id, filename: id, loaded: true, exports: { getPool: () => pool }, paths: [] };

  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfMergeFollowupsEnabled: false,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise',
  };
  const platform = require('../src/workflow/platform.ts');
  const buildRuns = require('../src/services/build-runs');
  const was = { ...buildRuns.TARGETS };
  t.after(async () => {
    Object.assign(buildRuns.TARGETS, was);
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await platform.startWorkflow(config, { loops: true });
  assert.equal(platform.botBuildsRunning(), true, 'the runtime runs for builds with every other flag off');

  const instance = async (key) => (await pool.query(
    `SELECT state, data FROM wf_instances WHERE machine = 'bot-build' AND key = $1`, [key])).rows[0] || null;
  const work = async (key) => (await pool.query(
    `SELECT kind, status, attempt_count, lost_attempts FROM wf_work WHERE machine = 'bot-build' AND key = $1 ORDER BY created_at`,
    [key])).rows;
  const until = async (check, what, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() >= deadline) assert.fail(what);
      await new Promise((res) => setTimeout(res, 50));
    }
  };

  await t.test('a build asked for runs on the machine, and its caller hears what it did', async () => {
    const runs = [];
    buildRuns.TARGETS.live = {
      run: async ({ id: runId, input, steps }) => {
        runs.push(runId);
        assert.equal(steps.active, true);
        assert.equal(steps.owner, 'bot-build/run:101@w1');
        await steps.once('session', async () => ({ id: 7 }));
        return { ok: true, input };
      },
      lost: async () => { throw new Error('not lost'); },
    };
    const out = await buildRuns.start({ pool, config, target: 'live', id: 101, nonce: 'w1', appId: null, input: { args: { issueNumber: 3 } } });
    // The target reads what its caller asked with beside the build's identity.
    assert.deepEqual(out, { state: 'done', result: { ok: true, input: { target: 'live', id: 101, nonce: 'w1', args: { issueNumber: 3 } } } });
    assert.deepEqual(runs, [101]);
    // Heard as the handler ended; the instance moves to its end as the
    // kernel takes the result.
    await until(async () => (await instance('run:101@w1'))?.state === 'done', 'the instance ended done');
    // Asked again (a second dispatch of the same build): nothing runs twice.
    const again = await buildRuns.start({ pool, config, target: 'live', id: 101, nonce: 'w1', appId: null, input: {} });
    assert.equal(again.state, 'done');
    assert.deepEqual(runs, [101], 'one build, once');
  });

  await t.test('a restart in the middle: the lease is given up, and the next runtime carries the build on from its last step', async () => {
    const seen = [];
    let started;
    const inTurn = new Promise((r) => { started = r; });
    buildRuns.TARGETS.trial = {
      run: async ({ steps }) => {
        seen.push({ resumed: steps.resumed, lost: steps.lostAttempts, spec: steps.get('spec') ?? null });
        await steps.once('spec', async () => 'the plan');
        if (!steps.resumed) {
          started();
          // A turn under way when the platform restarts: only the stop ends it.
          await steps.race(new Promise(() => {}));
        }
        return { status: 'ok' };
      },
      lost: async () => { throw new Error('not lost'); },
    };
    const key = buildRuns.keyOf('trial', 55, 'c1');
    const waiting = buildRuns.start({ pool, config, target: 'trial', id: 55, nonce: 'c1', appId: null, input: {} });
    await inTurn;
    await platform.stopWorkflow();
    const [item] = await work(key);
    assert.equal(item.status, 'running', 'still its build\'s: nothing reported');
    const { rows: [lease] } = await pool.query(
      `SELECT lease_until <= now() AS free FROM wf_work WHERE machine = 'bot-build' AND key = $1`, [key]);
    assert.equal(lease.free, true, 'the stopping process gave its lease up at once');
    await platform.startWorkflow(config, { loops: true });
    await until(async () => (await instance(key))?.state === 'done', 'the build carried on and ended');
    assert.deepEqual(seen, [
      { resumed: false, lost: 0, spec: null },
      { resumed: true, lost: 1, spec: 'the plan' },
    ], 'the second attempt went on from the spec the first one saved');
    const [after] = await work(key);
    assert.equal(after.lost_attempts, 1);
    assert.deepEqual(await waiting, { state: 'done', result: { status: 'ok' } }, 'the wait outlived the restart');
  });

  await t.test('a build whose handler keeps failing ends failed, recorded as lost with why', async () => {
    let tries = 0;
    const lost = [];
    buildRuns.TARGETS.shadow = {
      run: async () => { tries += 1; throw new Error('the pipeline threw'); },
      lost: async ({ id: runId, error }) => { lost.push({ runId, error }); },
    };
    const out = await buildRuns.start({ pool, config, target: 'shadow', id: 77, nonce: 'a1', appId: null, input: {} });
    assert.deepEqual(out, { state: 'failed' });
    assert.equal(tries, 2, 'tried as often as the machine allows');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].runId, 77);
    assert.match(JSON.stringify(lost[0].error), /the pipeline threw/);
    await until(async () => (await instance('run:77@a1'))?.state === 'failed', 'the instance ended failed');
  });

  await t.test('only the platform starts a build: a route\'s Requested is refused', async () => {
    const { botBuild } = require('../src/workflow/bot-build/machine.ts');
    const authorize = botBuild().authorize.get('Requested');
    assert.equal(authorize({ source: { kind: 'system', name: 'bot-build' } }), true);
    assert.equal(authorize({ source: { kind: 'admin' } }), true);
    assert.deepEqual(authorize({ source: { kind: 'route' } }), { reject: 'not_the_platform' });
  });
});
