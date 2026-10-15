'use strict';

// A project being set up when its process dies (services/app-creation-owner.js),
// against the REAL schema in a throwaway PostgreSQL database. Creation runs on
// after POST /api/apps, a remix or Retry has answered, so a platform restart
// (60 to 80 a day) used to lose it: the row said "Spinning up..." until the
// leader's boot sweep flipped it to error ten minutes after it was MADE, the
// creator then spent one of their three retries on the platform's restart, and
// a Retry (which keeps created_at) could be flipped by that sweep while its own
// process still ran it. What is pinned here is the durable state: who owns the
// row, what a restart leaves, and what the leader does with it. The build
// itself (createApp / forkApp) is stubbed. Skipped when no server is
// reachable, required when TEST_DATABASE_URL is set.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/app-creation-restart-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(check, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('creation survives a restart, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'creation_restart_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent: the ADD COLUMNs run again

  // The route reads the pool through getPool, and destructures createApp and
  // forkApp at require time: each delegates to whatever the subtest sets.
  require('../src/db/pool').getPool = () => pool;
  let createImpl = async () => {};
  let forkImpl = async () => {};
  require('../src/services/app-creator').createApp = (...args) => createImpl(...args);
  require('../src/services/app-forker').forkApp = (...args) => forkImpl(...args);
  require('../src/services/ws').pushNotificationToUser = () => {};
  require('../src/services/events').record = async () => {};
  const owner = require('../src/services/app-creation-owner');
  const { appRoutes } = require('../src/routes/apps');
  // A new process: the module loaded afresh, with none of the old one's
  // memory (which attempts it was driving), over the same database.
  const restarted = () => {
    delete require.cache[require.resolve('../src/services/app-creation-owner')];
    const fresh = require('../src/services/app-creation-owner');
    require.cache[require.resolve('../src/services/app-creation-owner')].exports = owner;
    return fresh;
  };

  const { rows: [maker] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, app_quota)
     VALUES ('maker', 'x', TRUE, 50) RETURNING id, username`
  );
  const viewer = { id: maker.id, username: maker.username, isAdmin: false, canAdminWrite: false };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(appRoutes({ maxApps: 0 }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  t.after(async () => {
    owner.stop();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  let n = 0;
  // A row as a process left it. Times are relative to now, in seconds.
  async function row({
    status = 'creating', createdAgo = 0, ownedBy = null, heartbeatAgo = null,
    redrives = 0, retries = 0, failure = null, forkedFrom = null, repoUrl = null,
  } = {}) {
    n += 1;
    const { rows: [r] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, created_at, creating_owner,
                         creating_heartbeat_at, creating_redrives, retry_count, last_failure,
                         forked_from, repo_url)
       VALUES ($1, $2, $3, $4, NOW() - make_interval(secs => $5), $6,
               CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $7::int) END,
               $8, $9, $10::jsonb, $11::jsonb, $12)
       RETURNING *`,
      [`Project ${n}`, `project-${n}`, status, maker.id, createdAgo, ownedBy, heartbeatAgo,
       redrives, retries, failure ? JSON.stringify(failure) : null,
       forkedFrom ? JSON.stringify(forkedFrom) : null, repoUrl]
    );
    return r;
  }
  const read = async (id) => (await pool.query('SELECT * FROM apps WHERE id = $1', [id])).rows[0];
  const liveOwners = async (ids) => (await pool.query(
    'SELECT id FROM apps WHERE id = ANY($1::int[]) AND creating_owner IS NOT NULL', [ids])).rows.length;

  await t.test('a new project is driven under an owner whose heartbeat the leader can read', async () => {
    const build = deferred();
    let handed = null;
    createImpl = async (_config, r) => { handed = r; return build.promise; };
    const res = await post('/api/apps', { name: 'Garden Club' });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const id = res.data.app.id;
    assert.equal(handed && handed.id, id, 'createApp is started with the new row');
    const live = await read(id);
    assert.equal(live.status, 'creating');
    assert.ok(live.creating_owner, 'the row names the attempt driving it');
    assert.ok(Date.now() - live.creating_heartbeat_at.getTime() < 60000, 'and when it last said so');
    assert.equal(live.creating_redrives, 0);

    // The build ends (createApp writes its own terminal status): the row is let go.
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [id]);
    build.resolve();
    await until(async () => !(await read(id)).creating_owner, { label: 'the owner to be released' });
  });

  await t.test('RESTART: the dead process\'s creation is resumed by the leader, not failed or charged', async () => {
    // The process serving POST /api/apps is killed mid-build: its createApp
    // never comes back, and the durable state is all that is left of it.
    const dead = deferred();
    createImpl = async () => dead.promise;
    const res = await post('/api/apps', { name: 'Book Swap' });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const id = res.data.app.id;
    const left = await read(id);
    assert.ok(left.creating_owner);
    // Ninety seconds and more of silence, as a process gone since then leaves
    // it; the row is old enough that the boot sweep used to fail it.
    await pool.query(
      `UPDATE apps SET creating_heartbeat_at = NOW() - INTERVAL '5 minutes',
                       created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [id]);

    // The process that ran it still thinks it is driving it: its own sweep
    // never takes it over, whatever the heartbeat says.
    const own = await owner.sweep({}, pool, { deps: { createApp: async () => { throw new Error('beside itself'); } } });
    assert.deepEqual(own.resumed, []);

    const leader = restarted();
    const resumedWith = [];
    const resumedBuild = deferred();
    const result = await leader.sweep({}, pool, {
      deps: { createApp: async (_config, r) => { resumedWith.push(r); return resumedBuild.promise; } },
    });
    assert.deepEqual(result.resumed, [id]);
    assert.deepEqual(result.failed, []);
    assert.equal(resumedWith.length, 1, 'the same create path runs again, once');
    assert.equal(resumedWith[0].id, id);
    const taken = await read(id);
    assert.equal(taken.status, 'creating', 'still setting up: never shown as an error');
    assert.equal(taken.last_failure, null);
    assert.equal(taken.retry_count, 0, 'the creator spent nothing on the platform\'s restart');
    assert.equal(taken.creating_redrives, 1, 'the resume is recorded');
    assert.notEqual(taken.creating_owner, left.creating_owner, 'under a new owner');
    assert.ok(Date.now() - taken.creating_heartbeat_at.getTime() < 60000);

    // A second pass finds it owned and alive: no second build.
    const again = await restarted().sweep({}, pool, { deps: { createApp: async () => { throw new Error('ran twice'); } } });
    assert.deepEqual(again.resumed, []);

    // The dead attempt's late end (were it ever to come back) releases
    // nothing: the row is the resume's now.
    dead.resolve();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await read(id)).creating_owner, taken.creating_owner);

    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [id]);
    resumedBuild.resolve();
    await until(async () => !(await read(id)).creating_owner, { label: 'the resume to let the row go' });
  });

  await t.test('a live owner is never swept, however old its row (a Retry keeps created_at)', async () => {
    const r = await row({ createdAgo: 3600, ownedBy: 'alive', heartbeatAgo: 5, retries: 1 });
    const result = await owner.sweep({}, pool, {
      ownerless: true, deps: { createApp: async () => { throw new Error('must not run'); } },
    });
    assert.ok(!result.resumed.includes(r.id));
    assert.ok(!result.failed.includes(r.id));
    const after = await read(r.id);
    assert.equal(after.status, 'creating');
    assert.equal(after.creating_owner, 'alive');
  });

  await t.test('two leaders\' passes over one stranded row drive it once', async () => {
    const r = await row({ createdAgo: 600, ownedBy: 'gone', heartbeatAgo: 300 });
    const calls = [];
    const hold = deferred();
    const deps = { createApp: async (_c, x) => { calls.push(x.id); return hold.promise; } };
    const [a, b] = await Promise.all([owner.sweep({}, pool, { deps }), owner.sweep({}, pool, { deps })]);
    assert.equal([...a.resumed, ...b.resumed].filter((id) => id === r.id).length, 1);
    assert.deepEqual(calls.filter((id) => id === r.id), [r.id]);
    assert.equal((await read(r.id)).creating_redrives, 1);
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [r.id]);
    hold.resolve();
    await until(async () => !(await liveOwners([r.id])), { label: 'release' });
  });

  await t.test('after three resumes it fails as interrupted, and that failure\'s Retry is free', async () => {
    const r = await row({ createdAgo: 1800, ownedBy: 'third-resume', heartbeatAgo: 300, redrives: 3, retries: 3 });
    const result = await owner.sweep({}, pool, { deps: { createApp: async () => { throw new Error('must not run'); } } });
    assert.deepEqual(result.failed, [r.id]);
    const failed = await read(r.id);
    assert.equal(failed.status, 'error');
    assert.equal(failed.creating_owner, null);
    assert.equal(failed.last_failure.interrupted, true);
    assert.equal(failed.last_failure.stage, 'timeout', 'drawn as the build log always drew it');
    assert.match(failed.last_failure.reason, /interrupted by a platform restart/);

    // At the creator's limit already (3 of 3): an interrupted failure is
    // neither refused by it nor counted.
    const started = deferred();
    createImpl = async () => started.promise;
    const res = await post(`/api/apps/${r.slug}/retry`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const retried = await read(r.id);
    assert.equal(retried.status, 'creating');
    assert.equal(retried.retry_count, 3, 'not counted');
    assert.equal(retried.creating_redrives, 0, 'a new attempt gets its own resumes');
    assert.equal(retried.last_failure, null);
    assert.ok(retried.creating_owner);
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [r.id]);
    started.resolve();
    await until(async () => !(await liveOwners([r.id])), { label: 'release' });
  });

  await t.test('an ordinary failure still counts, and the limit still holds', async () => {
    const real = { stage: 'build', reason: 'npm ERR! missing script: start', log: '', at: new Date().toISOString(), sha: null };
    const r = await row({ status: 'error', retries: 1, failure: real });
    const started = deferred();
    createImpl = async () => started.promise;
    const res = await post(`/api/apps/${r.slug}/retry`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal((await read(r.id)).retry_count, 2);
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [r.id]);
    started.resolve();
    await until(async () => !(await liveOwners([r.id])), { label: 'release' });

    const capped = await row({ status: 'error', retries: 3, failure: real });
    const refused = await post(`/api/apps/${capped.slug}/retry`);
    assert.equal(refused.status, 429);
  });

  await t.test('Retry is refused while the last attempt still runs, and runs once it has gone', async () => {
    // The watchdog flipped it to error at five minutes, but its process is
    // alive and still building: a second Retry must not start a second build.
    const r = await row({ status: 'error', ownedBy: 'still-building', heartbeatAgo: 3,
      failure: { stage: 'timeout', reason: 'App creation timed out after 5 minutes', log: '', at: null, sha: null } });
    let ran = 0;
    createImpl = async () => { ran += 1; };
    const refused = await post(`/api/apps/${r.slug}/retry`);
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /still finishing/);
    assert.equal(ran, 0);
    const untouched = await read(r.id);
    assert.equal(untouched.status, 'error');
    assert.equal(untouched.retry_count, 0, 'a refused retry costs nothing');
    assert.equal(untouched.creating_owner, 'still-building');

    // Its process died (or the attempt settled): the owner went quiet.
    await pool.query(`UPDATE apps SET creating_heartbeat_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [r.id]);
    const ok = await post(`/api/apps/${r.slug}/retry`);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ran, 1);
    assert.equal((await read(r.id)).retry_count, 1);
  });

  await t.test('the watchdog fails a hung attempt but keeps the row until it settles', async () => {
    const r = await row({ status: 'error' });
    const token = await owner.takeForRetry(pool, r.id);
    assert.ok(token);
    const hung = deferred();
    const fresh = await read(r.id);
    const work = owner.drive(pool, fresh, {
      owner: token, provision: () => hung.promise, label: 'Test creation',
      timing: { timeoutMs: 50, heartbeatMs: 30 },
    });
    await until(async () => (await read(r.id)).status === 'error', { label: 'the watchdog' });
    const flipped = await read(r.id);
    assert.equal(flipped.last_failure.stage, 'timeout');
    assert.equal(flipped.creating_owner, token, 'still held: it is still running');
    assert.equal(await owner.takeForRetry(pool, r.id), null, 'so a Retry cannot start beside it');

    // Its late success still lands (createApp writes 'running' itself), and
    // the row is let go.
    await pool.query(`UPDATE apps SET status = 'running', last_failure = NULL WHERE id = $1`, [r.id]);
    hung.resolve();
    await work;
    const done = await read(r.id);
    assert.equal(done.status, 'running');
    assert.equal(done.creating_owner, null);
  });

  await t.test('a rejection fails only its own row, never one another attempt took over', async () => {
    const r = await row({ status: 'error' });
    const token = await owner.takeForRetry(pool, r.id);
    const boom = deferred();
    const work = owner.drive(pool, await read(r.id), { owner: token, provision: () => boom.promise });
    // Taken over by a resume elsewhere (this one's heartbeat was missed).
    await pool.query(`UPDATE apps SET creating_owner = 'resumer', creating_heartbeat_at = NOW() WHERE id = $1`, [r.id]);
    boom.reject(new Error('build exploded'));
    await work;
    const after = await read(r.id);
    assert.equal(after.status, 'creating', 'the resume\'s attempt is left alone');
    assert.equal(after.creating_owner, 'resumer');
  });

  await t.test('rows nobody owns keep the boot rule: at boot, and only once ten minutes old', async () => {
    const legacy = await row({ createdAgo: 20 * 60 });
    const young = await row({ createdAgo: 2 * 60 });
    const seen = [];
    const deps = { createApp: async (_c, x) => { seen.push(x.id); } };
    const interval = await owner.sweep({}, pool, { deps });
    assert.ok(!interval.resumed.includes(legacy.id), 'the minute pass leaves ownerless rows alone');
    const boot = await owner.sweep({}, pool, { ownerless: true, deps });
    assert.ok(boot.resumed.includes(legacy.id), 'the boot pass resumes the old one');
    assert.ok(!boot.resumed.includes(young.id), 'and leaves the young one');
    await until(async () => seen.includes(legacy.id), { label: 'the legacy resume' });
    assert.equal((await read(young.id)).status, 'creating');
  });

  await t.test('a remix is resumed through the forker, with its recorded source', async () => {
    const { rows: [source] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url)
       VALUES ('Original', 'original-src', 'running', $1, 'https://github.com/usernode-bot/original-src') RETURNING *`,
      [maker.id]
    );
    const fork = await row({ createdAgo: 600, ownedBy: 'gone', heartbeatAgo: 300,
      forkedFrom: { appId: source.id, slug: source.slug } });
    const forked = [];
    const forker = require('../src/services/app-forker');
    await owner.sweep({}, pool, {
      deps: {
        forker: { findForkSource: forker.findForkSource, forkApp: async (_c, x, s) => { forked.push([x.id, s && s.id]); } },
        createApp: async () => { throw new Error('a remix must never seed the starter'); },
      },
    });
    await until(() => forked.length > 0, { label: 'the fork resume' });
    assert.deepEqual(forked, [[fork.id, source.id]]);
  });

  await t.test('a staging preview fails stranded rows instead of resuming production\'s', async () => {
    const r = await row({ createdAgo: 600, ownedBy: 'production-pod', heartbeatAgo: 300 });
    const prev = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const result = await owner.sweep({}, pool, { deps: { createApp: async () => { throw new Error('must not run'); } } });
      assert.ok(result.failed.includes(r.id));
      assert.deepEqual(result.resumed, []);
    } finally {
      if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
    }
    const after = await read(r.id);
    assert.equal(after.status, 'error');
    assert.equal(after.last_failure.interrupted, true);
  });
});
