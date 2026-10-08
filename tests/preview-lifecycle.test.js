'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createGuard } = require('../src/services/build-retention-guard');
const { createLifecycle } = require('../src/services/preview-lifecycle');
const url = process.env.PREVIEW_LIFECYCLE_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// Use a disposable database, never the application's DATABASE_URL. Two guard
// instances use independent PostgreSQL sessions, as two platform Pods do.
test('preview lifecycle across independent owners', { skip: !url }, async t => {
  const pool = new Pool({ connectionString: url });
  const oldFlag = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  const schema = `preview_test_${process.pid}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.end();
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = new Pool({ connectionString: scopedUrl.toString() });
  const config = { appRuntime: 'kubernetes', databaseUrl: scopedUrl.toString(), kubernetes: {} };
  try {
    await db.query(`CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, status TEXT,
      checks_commit_sha TEXT, staging_commit_sha TEXT, imported_pr_head_sha TEXT);
      CREATE TABLE artifacts (value TEXT); INSERT INTO artifacts VALUES ('new');`);
    const schemaSql = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    // This fixture needs only its own table. Later migrations may reference
    // production tables deliberately absent from this isolated schema.
    const previewSchema = schemaSql.match(/CREATE TABLE IF NOT EXISTS preview_operations \([\s\S]*?\n\);/);
    assert.ok(previewSchema, 'preview_operations must exist in the schema');
    await db.query(previewSchema[0]);
    const make = (checks = async () => {}, harvest = null) => {
      const guard = createGuard({ retryMs: 5 });
      return createLifecycle({ poolFor: () => db, lock: guard.withResourceUse,
        checks: () => ({ cancelPreviewChecks: checks }), pollMs: 5,
        ...(harvest ? { harvest: () => harvest } : {}) });
    };
    const reset = async (id, sha = 'old') => {
      await db.query('INSERT INTO chat_sessions VALUES ($1, $2, $3, $3, NULL)', [id, 'active', sha]);
      return { id, status: 'active', checks_commit_sha: sha };
    };

    await t.test('new head fences old writes and waits for consumers to stop', async () => {
      const session = await reset(1);
      const entered = deferred(); const stopped = deferred(); const aborted = deferred();
      let successorStarted = false;
      const first = make(); const second = make();
      const oldRun = first.run(config, session, 'old', 'capture', async op => {
        const consumer = new Promise(resolve => op.signal.addEventListener('abort', async () => {
          aborted.resolve(); await stopped.promise; resolve();
        }, { once: true }));
        op.track(consumer);
        entered.resolve(op);
        await aborted.promise;
        throw op.signal.reason;
      }).catch(e => e);
      const op = await entered.promise;
      await db.query("UPDATE chat_sessions SET checks_commit_sha = 'new' WHERE id = 1");
      const next = second.run(config, session, 'new', 'build', async () => { successorStarted = true; return { image: 'new' }; });
      await aborted.promise;
      await assert.rejects(op.pool.query("UPDATE artifacts SET value = 'old'"), { code: 'PREVIEW_SUPERSEDED' });
      assert.equal(successorStarted, false);
      stopped.resolve();
      assert.equal((await oldRun).code, 'PREVIEW_SUPERSEDED');
      assert.deepEqual(await next, { image: 'new' });
      assert.equal((await db.query('SELECT value FROM artifacts')).rows[0].value, 'new');
    });

    await t.test('conflict repair cancels a live run and waits for its consumers', async () => {
      const session = await reset(12);
      const entered = deferred(); const aborted = deferred(); const stopped = deferred();
      const first = make(); const cancelledJobs = [];
      const repair = make(async (_config, _sessionId, runId) => { cancelledJobs.push(runId); });
      const oldRun = first.run(config, session, 'old', 'capture', async op => {
        op.track(new Promise(resolve => op.signal.addEventListener('abort', async () => {
          aborted.resolve(); await stopped.promise; resolve();
        }, { once: true })));
        entered.resolve(op);
        await aborted.promise;
        throw op.signal.reason;
      }).catch(err => err);
      const oldOperation = await entered.promise;
      let repairReady = false;
      const cancellation = repair.supersede(config, session.id, 'old')
        .then(result => { repairReady = true; return result; });
      await aborted.promise;
      assert.equal(repairReady, false, 'repair must wait for the old consumer');
      await assert.rejects(repair.run(config, session, 'old', 'capture', async () => assert.fail()),
        { code: 'PREVIEW_SUPERSEDED' });
      await assert.rejects(repair.run(config, session, 'old', 'capture', async () => assert.fail(),
        { force: true }), { code: 'PREVIEW_SUPERSEDED' });
      stopped.resolve();
      assert.equal((await oldRun).code, 'PREVIEW_SUPERSEDED');
      assert.equal((await cancellation).runId, oldOperation.runId);
      assert.deepEqual(cancelledJobs, [oldOperation.runId]);
      assert.equal((await db.query('SELECT state FROM preview_operations WHERE session_id = 12')).rows[0].state,
        'superseded');

      await db.query("UPDATE chat_sessions SET checks_commit_sha = 'new' WHERE id = 12");
      assert.equal(await repair.run(config, session, 'new', 'capture', async () => 'new result'), 'new result');
    });

    await t.test('restart cancellation stops orphan Jobs without touching a successor', async () => {
      const session = await reset(13);
      const oldRunId = '11111111-1111-4111-8111-111111111111';
      await db.query(`INSERT INTO preview_operations
        (session_id, desired_revision, run_id, revision, phase, state)
        VALUES (13, 'old', $1, 'old', 'capture', 'running')`, [oldRunId]);
      const cancelledJobs = [];
      const repair = make(async (_config, _sessionId, runId) => { cancelledJobs.push(runId); });
      assert.equal((await repair.supersede(config, session.id, 'old')).runId, oldRunId);
      assert.deepEqual(cancelledJobs, [oldRunId]);
      assert.equal((await db.query('SELECT state FROM preview_operations WHERE session_id = 13')).rows[0].state,
        'superseded');
      await assert.rejects(repair.run(config, session, 'old', 'capture', async () => assert.fail()),
        { code: 'PREVIEW_SUPERSEDED' });
      await db.query("UPDATE chat_sessions SET checks_commit_sha = 'new' WHERE id = 13");
      assert.equal(await repair.run(config, session, 'new', 'capture', async () => 'new result'), 'new result');
      assert.equal(await repair.settleAdopted(config, { sessionId: 13, runId: oldRunId },
        { error: repair.cancelled() }), false);
      assert.equal((await db.query('SELECT state FROM preview_operations WHERE session_id = 13')).rows[0].state,
        'completed');
    });

    // A capture asked for again while the harvest collects a run of the same
    // revision (its owner died with the Jobs on the cluster) leaves that run
    // alone: its Jobs are spared, the row still names it, and the harvest's
    // ownership check still passes. Only other commits' Jobs are cancelled.
    const HARVESTED = '22222222-2222-4222-8222-222222222222';
    const harvestHook = (asked) => ({
      runToCollect: async (_config, _pool, sessionId, revision) => {
        asked.push([sessionId, revision]);
        return { runId: HARVESTED, owner: 'old-pod:1:exited', capture: 'running', unitSuite: 'succeeded' };
      },
      runsOfCommit: async () => new Set([HARVESTED]),
    });
    const recordCancels = (cancels) => async (_config, _sessionId, runId, opts) => {
      cancels.push({ runId: runId ?? null, spared: [HARVESTED, 'other-commit-run'].filter(id => opts?.spare?.(id)) });
    };

    await t.test('a capture leaves a run of its revision to the harvest and cancels only other commits\' Jobs', async () => {
      const session = await reset(16);
      await db.query(`INSERT INTO preview_operations
        (session_id, desired_revision, run_id, revision, phase, state)
        VALUES (16, 'old', $1, 'old', 'capture', 'running')`, [HARVESTED]);
      const asked = []; const cancels = [];
      const owner = make(recordCancels(cancels), harvestHook(asked));
      let started = false;
      await assert.rejects(owner.run(config, session, 'old', 'capture', async () => { started = true; }),
        { code: 'PREVIEW_SUPERSEDED' });
      assert.equal(started, false, 'nothing is started over');
      assert.deepEqual(asked, [[16, 'old']], 'asked under the lock, for this revision');
      assert.deepEqual(cancels, [{ runId: null, spared: [HARVESTED] }],
        'one cancel-all that spares the harvested run and nothing else');
      assert.deepEqual((await db.query('SELECT run_id, state FROM preview_operations WHERE session_id = 16')).rows,
        [{ run_id: HARVESTED, state: 'running' }], 'the row still names the run being collected');
      const adopted = await owner.adopt(config, { sessionId: 16, runId: HARVESTED, revision: 'old' });
      assert.ok(adopted, 'the harvest can still adopt it');
      try { await adopted.check(); } finally { adopted.release(); }
    });

    await t.test('a forced capture and a build still cancel every Job of the session', async () => {
      const session = await reset(17);
      await db.query(`INSERT INTO preview_operations
        (session_id, desired_revision, run_id, revision, phase, state)
        VALUES (17, 'old', $1, 'old', 'capture', 'running')`, [HARVESTED]);
      const asked = []; const cancels = [];
      const owner = make(recordCancels(cancels), harvestHook(asked));
      assert.equal(await owner.run(config, session, 'old', 'capture', async () => 'fresh', { force: true }), 'fresh');
      assert.equal(await owner.run(config, session, 'old', 'build', async () => 'built'), 'built');
      assert.deepEqual(asked, [], 'neither asks: a forced run wants a fresh verdict, a build replaces the preview');
      assert.ok(cancels.length >= 2 && cancels.every(c => c.runId === null && c.spared.length === 0), JSON.stringify(cancels));
    });

    await t.test('cancellation fences a queued revision before its owner starts', async () => {
      const session = await reset(14);
      const repair = make();
      const result = await repair.supersede(config, session.id, 'old');
      assert.equal(result.runId, null);
      await assert.rejects(repair.run(config, session, 'old', 'build', async () => assert.fail()),
        { code: 'PREVIEW_SUPERSEDED' });
      await db.query("UPDATE chat_sessions SET checks_commit_sha = 'new' WHERE id = 14");
      assert.equal(await repair.run(config, session, 'new', 'build', async () => 'new result'), 'new result');
    });

    await t.test('cancellation during startup prevents the old owner from starting', async () => {
      const session = await reset(15);
      const cleaning = deferred(); const allowCleanup = deferred();
      const owner = make(async () => { cleaning.resolve(); await allowCleanup.promise; });
      const repair = make();
      let started = false;
      const run = owner.run(config, session, 'old', 'capture', async () => { started = true; })
        .catch(err => err);
      await cleaning.promise;
      const cancellation = repair.supersede(config, session.id, 'old');
      // The cancellation row is written before the repair waits for the lock.
      for (;;) {
        const { rows } = await db.query('SELECT state FROM preview_operations WHERE session_id = 15');
        if (rows[0]?.state === 'superseded') break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      allowCleanup.resolve();
      assert.equal((await run).code, 'PREVIEW_SUPERSEDED');
      await cancellation;
      assert.equal(started, false);
    });

    await t.test('same-revision duplicate joins completion across owners', async () => {
      const session = await reset(2);
      const entered = deferred(); const release = deferred();
      let calls = 0;
      const a = make().run(config, session, 'old', 'capture', async () => {
        calls++; entered.resolve(); await release.promise; return { state: 'passing' };
      });
      await entered.promise;
      const b = make().run(config, session, 'old', 'capture', async () => { calls++; return { state: 'unexpected' }; });
      await new Promise(r => setTimeout(r, 30));
      release.resolve();
      assert.deepEqual(await a, { state: 'passing' });
      assert.deepEqual(await b, { state: 'passing' });
      assert.equal(calls, 1);
    });

    await t.test('a delayed old trigger cannot supersede the current head', async () => {
      const session = await reset(3, 'new');
      let calls = 0;
      await assert.rejects(make().run(config, session, 'old', 'build', async () => calls++), { code: 'PREVIEW_SUPERSEDED' });
      assert.equal(calls, 0);
    });

    await t.test('forced same-head recovery runs again', async () => {
      const session = await reset(4);
      const owner = make(); let calls = 0;
      await owner.run(config, session, 'old', 'capture', async () => { calls++; return { state: 'error' }; });
      await owner.run(config, session, 'old', 'capture', async () => { calls++; return { state: 'passing' }; }, { force: true });
      assert.equal(calls, 2);
    });

    await t.test('cleanup waits for orphan consumers before starting work', async () => {
      const session = await reset(5); const cleanup = deferred(); const entered = deferred();
      let started = false;
      const run = make(async () => { entered.resolve(); await cleanup.promise; })
        .run(config, session, 'old', 'build', async () => { started = true; });
      await entered.promise; assert.equal(started, false); cleanup.resolve(); await run;
      assert.equal(started, true);
    });

    await t.test('artifact replacement is atomic with respect to a head change', async () => {
      const session = await reset(6);
      const entered = deferred(); const release = deferred(); let changed = false;
      const run = make().run(config, session, 'old', 'capture', async op => {
        const client = await op.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM artifacts');
          entered.resolve(); await release.promise;
          await client.query("INSERT INTO artifacts VALUES ('complete')");
          await client.query('COMMIT');
        } finally { client.release(); }
      }).catch(e => e);
      await entered.promise;
      const update = db.query("UPDATE chat_sessions SET checks_commit_sha = 'new' WHERE id = 6")
        .then(() => { changed = true; });
      await new Promise(r => setTimeout(r, 20));
      assert.equal(changed, false, 'the new head waits for the entire artifact transaction');
      release.resolve(); await update; await run;
      assert.deepEqual((await db.query('SELECT value FROM artifacts')).rows, [{ value: 'complete' }]);
    });

    await t.test('failure publication is fenced even after consumers were aborted', async () => {
      const session = await reset(7); let published = 0;
      const owner = make();
      await assert.rejects(owner.run(config, session, 'old', 'capture', async () => {
        throw new Error('capture broke');
      }, { onError: async (_err, pool) => {
        await pool.query("UPDATE artifacts SET value = 'error'"); published++;
      } }), /capture broke/);
      assert.equal(published, 1);
      await assert.rejects(owner.run(config, session, 'old', 'capture', async () => {
        await db.query("UPDATE chat_sessions SET checks_commit_sha = 'new' WHERE id = 7");
        throw new Error('late failure');
      }, { onError: async (_err, pool) => {
        await pool.query("UPDATE artifacts SET value = 'stale'"); published++;
      } }), /late failure/);
      assert.equal(published, 1);
      assert.equal((await db.query('SELECT value FROM artifacts')).rows[0].value, 'error');
    });

    await t.test('an imported head change cancels before the checks pin catches up', async () => {
      const session = await reset(8);
      await db.query("UPDATE chat_sessions SET imported_pr_head_sha = 'new' WHERE id = 8");
      await assert.rejects(make().run(config, session, 'old', 'build', async () => assert.fail()),
        { code: 'PREVIEW_SUPERSEDED' });
    });

    await t.test('idle teardown skips a capture and terminal teardown cancels it', async () => {
      const session = { ...await reset(9), staging_commit_sha: 'old' };
      const entered = deferred(); let removed = 0;
      const owner = make();
      const run = owner.run(config, session, 'old', 'capture', async op => {
        entered.resolve();
        await new Promise(resolve => op.signal.addEventListener('abort', resolve, { once: true }));
        op.signal.throwIfAborted();
      }).catch(e => e);
      await entered.promise;
      assert.equal((await make().teardown(config, session, async () => removed++)).busy, true);
      assert.equal(removed, 0);
      await db.query("UPDATE chat_sessions SET status = 'archived' WHERE id = 9");
      await owner.teardown(config, { ...session, status: 'archived' }, async () => removed++);
      assert.equal((await run).code, 'PREVIEW_SUPERSEDED');
      assert.equal(removed, 1);
    });

    await t.test('a new session can resolve an exact revision before ownership', async () => {
      const session = await reset(10, null);
      assert.equal(await make().run(config, session, 'latest', 'build', async op => op.revision,
        { resolveRevision: async () => 'resolved' }), 'resolved');
    });

    await t.test('a writer waiting for the session lock rechecks the run after acquiring it', async () => {
      const session = await reset(11); const entered = deferred(); const release = deferred();
      const run = make().run(config, session, 'old', 'capture', async op => {
        entered.resolve(op); await release.promise;
      }).catch(e => e);
      const op = await entered.promise;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM chat_sessions WHERE id = 11 FOR UPDATE');
        const write = assert.rejects(op.pool.query("UPDATE artifacts SET value = 'stale'"),
          { code: 'PREVIEW_SUPERSEDED' });
        await new Promise(r => setTimeout(r, 20));
        await client.query("UPDATE preview_operations SET state = 'completed' WHERE session_id = 11");
        await client.query('COMMIT');
        await write;
      } finally { client.release(); release.resolve(); }
      assert.equal((await run).code, 'PREVIEW_SUPERSEDED');
      assert.notEqual((await db.query('SELECT value FROM artifacts')).rows[0].value, 'stale');
    });
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
    if (oldFlag === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = oldFlag;
  }
});
