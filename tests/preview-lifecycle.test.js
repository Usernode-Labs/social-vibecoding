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
    await db.query(schemaSql.slice(schemaSql.indexOf('CREATE TABLE IF NOT EXISTS preview_operations')));
    const make = (checks = async () => {}) => {
      const guard = createGuard({ retryMs: 5 });
      return createLifecycle({ poolFor: () => db, lock: guard.withResourceUse,
        checks: () => ({ cancelPreviewChecks: checks }), pollMs: 5 });
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
