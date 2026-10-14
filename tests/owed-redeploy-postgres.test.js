'use strict';

// A production redeploy a vote owes an app (services/owed-redeploy.js),
// against the REAL schema in a throwaway PostgreSQL database. A secret a
// group voted in reaches the running app only by a rebuild, which the legacy
// vote path (routes/issues.js maybeApplySecretChangeProposal, used while
// WF_GOVERNANCE_ENABLED is off) ran fire-and-forget after its commit: a
// restart in between lost it for good, since main_sha does not move for a
// secret and the heal sees a healthy container. Pinned here: the mark commits
// with the change, the rebuild clears exactly its own mark, and the leader's
// sweep runs again one whose process died. The rebuild itself is stubbed.
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/owed-redeploy-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DATA_KEY = 'synthetic-owed-redeploy-test-key';

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

test('an owed redeploy survives a restart, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'owed_redeploy_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  require('../src/db/pool').getPool = () => pool;
  // issues.js destructures these at require time; the rebuild is read off
  // the staging module at call time.
  const ws = require('../src/services/ws');
  ws.sendSystemMessage = async () => {};
  ws.pushIssueUpdate = () => {};
  let rebuildImpl = async () => { throw new Error('no rebuild expected'); };
  require('../src/services/staging').rebuildProduction = (...args) => rebuildImpl(...args);
  const owed = require('../src/services/owed-redeploy');
  const { maybeApplySecretChangeProposal } = require('../src/routes/issues');
  const { encrypt, decrypt } = require('../src/services/secrets');
  const config = { dataEncryptionKey: DATA_KEY };

  const { rows: [author] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('author', 'x', TRUE) RETURNING id, username`);
  let n = 0;
  async function app({ selfHosted = false } = {}) {
    n += 1;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, main_sha, self_hosted)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING *`,
      [`App ${n}`, `app-${n}`, author.id, `https://github.com/usernode-bot/app-${n}`, 'a'.repeat(40), selfHosted]);
    return a;
  }
  const read = async (id) => (await pool.query(
    `SELECT *, redeploy_owed_at::text AS mark FROM apps WHERE id = $1`, [id])).rows[0];

  await t.test('RESTART: the vote owes the rebuild in its own commit, and the leader gives it after the process died', async () => {
    const a = await app();
    const { rows: [issue] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by)
       VALUES ($1, 'Set API_KEY', 'secret_change', $2, $3) RETURNING *`,
      [a.id, JSON.stringify({ key: 'API_KEY', action: 'set', valueEnc: encrypt('new-value', DATA_KEY), valueLast4: 'alue' }), author.id]);

    // The process that applies the vote dies mid-rebuild: its rebuild never
    // comes back.
    const dead = deferred();
    const handed = [];
    rebuildImpl = async (_config, row) => { handed.push(row.id); return dead.promise; };
    const applied = await maybeApplySecretChangeProposal(config, pool,
      { ...issue, app_slug: a.slug }, { force: true, forceBy: { id: author.id, username: 'author' } });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    await until(() => handed.length === 1, { label: 'the kick' });

    // What the dead process leaves: the change committed, and the redeploy
    // owed beside it, held by the rebuild that died.
    const { rows: [closed] } = await pool.query('SELECT status FROM issues WHERE id = $1', [issue.id]);
    assert.equal(closed.status, 'closed');
    const { rows: [secret] } = await pool.query(
      `SELECT value_enc FROM app_secrets WHERE app_id = $1 AND key = 'API_KEY'`, [a.id]);
    assert.equal(decrypt(secret.value_enc, DATA_KEY), 'new-value');
    const left = await read(a.id);
    assert.ok(left.redeploy_owed_at, 'the redeploy is owed durably');
    assert.equal(left.redeploy_owed_reason, 'secret_change');
    assert.ok(left.redeploy_owner, 'held by the rebuild under way');
    assert.equal(left.redeploy_kicks, 1);
    assert.equal(left.main_sha, 'a'.repeat(40), 'main_sha has not moved: no poller would ever see this');

    // A live rebuild is not run twice.
    const early = await owed.sweep(config, pool, { rebuild: async () => { throw new Error('ran twice'); } });
    assert.deepEqual(early.kicked, []);

    // The process is gone: its heartbeat stopped long ago. Its own sweep
    // would still know its rebuild is running; the next leader is a new
    // process, the module loaded afresh over the same database.
    await pool.query(`UPDATE apps SET redeploy_heartbeat_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [a.id]);
    const own = await owed.sweep(config, pool, { rebuild: async () => { throw new Error('beside itself'); } });
    assert.deepEqual(own.kicked, [], 'never beside its own process\'s rebuild');
    delete require.cache[require.resolve('../src/services/owed-redeploy')];
    const leader = require('../src/services/owed-redeploy');
    require.cache[require.resolve('../src/services/owed-redeploy')].exports = owed;
    const again = deferred();
    const rebuilt = [];
    const swept = await leader.sweep(config, pool, { rebuild: async (row) => { rebuilt.push(row.id); return again.promise; } });
    assert.deepEqual(swept.kicked, [a.id]);
    await until(() => rebuilt.length === 1, { label: 'the sweep\'s rebuild' });
    const running = await read(a.id);
    assert.notEqual(running.redeploy_owner, left.redeploy_owner, 'under a new owner');
    assert.equal(running.redeploy_kicks, 2);
    assert.equal(running.mark, left.mark, 'still owed until it lands');

    again.resolve({ containerId: 'c-new', sha: 'b'.repeat(40) });
    const done = await until(async () => { const r = await read(a.id); return r.redeploy_owed_at ? null : r; },
      { label: 'the mark to clear' });
    assert.equal(done.redeploy_owner, null);
    assert.equal(done.redeploy_owed_reason, null);
    assert.equal(done.container_id, 'c-new');
    assert.equal(done.main_sha, 'b'.repeat(40));
    assert.equal(done.status, 'running');

    // The dead rebuild, were it ever to come back, clears nothing it does not own.
    dead.reject(new Error('process gone'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await read(a.id)).redeploy_owed_at, null);
  });

  await t.test('with app delivery on, the vote asks the machine and owes nothing the sweep would deploy beside it', async () => {
    const a = await app();
    const { rows: [issue] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by)
       VALUES ($1, 'Set API_KEY', 'secret_change', $2, $3) RETURNING *`,
      [a.id, JSON.stringify({ key: 'API_KEY', action: 'set', valueEnc: encrypt('delivered', DATA_KEY), valueLast4: 'ered' }), author.id]);
    // issues.js reads the workflow module at call time.
    const id = require.resolve('../src/workflow/platform.ts');
    const real = require.cache[id];
    const requested = [];
    require.cache[id] = { id, filename: id, loaded: true, paths: [], exports: {
      deliveryEnabled: () => true,
      requestDeploy: async (appId, reason) => { requested.push([appId, reason]); return 1; },
    } };
    rebuildImpl = async () => { throw new Error('deployed beside the machine'); };
    try {
      const applied = await maybeApplySecretChangeProposal(config, pool,
        { ...issue, app_slug: a.slug }, { force: true, forceBy: { id: author.id, username: 'author' } });
      assert.equal(applied.applied, true, JSON.stringify(applied));
      await until(() => requested.length === 1, { label: 'the request' });
    } finally {
      if (real) require.cache[id] = real; else delete require.cache[id];
    }
    assert.deepEqual(requested, [[a.id, 'secret_change']]);
    const after = await read(a.id);
    assert.equal(after.redeploy_owed_at, null, 'nothing owed: the machine keeps the request');
    assert.equal(after.redeploy_owner, null);
    // However long the leader waits, there is nothing for its sweep.
    const swept = await owed.sweep(config, pool, { rebuild: async () => { throw new Error('a second deploy'); } });
    assert.ok(!swept.kicked.includes(a.id));
  });

  await t.test('a change applied while a rebuild runs stays owed until its own rebuild lands', async () => {
    const a = await app();
    await owed.owe(pool, a.id, 'secret_change');
    const first = deferred();
    const one = owed.kick(config, pool, a.id, { takeover: true, rebuild: () => first.promise });
    const firstRun = await until(async () => {
      const r = await read(a.id);
      return r.redeploy_owner ? r : null;
    }, { label: 'the first kick' });
    // A second vote commits while the first rebuild (which may have read the
    // secrets before it) is still running.
    await new Promise((r) => setTimeout(r, 5));
    await owed.owe(pool, a.id, 'secret_change');
    const second = deferred();
    const two = owed.kick(config, pool, a.id, { takeover: true, rebuild: () => second.promise });
    const secondRun = await until(async () => {
      const r = await read(a.id);
      return r.redeploy_owner && r.redeploy_owner !== firstRun.redeploy_owner ? r : null;
    }, { label: 'the second kick' });
    assert.notEqual(secondRun.mark, firstRun.mark);
    const secondMark = secondRun.mark;

    first.resolve({ containerId: 'c1', sha: 'c'.repeat(40) });
    assert.deepEqual(await one, { taken: true, deployed: true });
    const between = await read(a.id);
    assert.equal(between.mark, secondMark, 'the newer change is still owed');
    assert.ok(between.redeploy_owner, 'and still held by its own rebuild');

    second.resolve({ containerId: 'c2', sha: 'c'.repeat(40) });
    await two;
    const after = await read(a.id);
    assert.equal(after.redeploy_owed_at, null);
    assert.equal(after.redeploy_owner, null);
  });

  await t.test('owed but never taken (died between commit and kick): run after the grace', async () => {
    const a = await app();
    await owed.owe(pool, a.id, 'secret_change');
    const fresh = await owed.sweep(config, pool, { rebuild: async () => { throw new Error('too early'); } });
    assert.ok(!fresh.kicked.includes(a.id), 'the request that owed it is still about to take it');
    await pool.query(`UPDATE apps SET redeploy_owed_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`, [a.id]);
    const ran = deferred();
    const swept = await owed.sweep(config, pool, { rebuild: async () => { ran.resolve(); return null; } });
    assert.deepEqual(swept.kicked, [a.id]);
    await ran.promise;
    await until(async () => !(await read(a.id)).redeploy_owed_at, { label: 'the mark to clear' });
  });

  await t.test('a rebuild that fails settles the mark: only one that died is run again', async () => {
    const a = await app();
    await owed.owe(pool, a.id, 'secret_change');
    const out = await owed.kick(config, pool, a.id, {
      takeover: true, rebuild: async () => { throw new Error('build failed: npm ERR!'); },
    });
    assert.deepEqual(out, { taken: true, deployed: false });
    const after = await read(a.id);
    assert.equal(after.redeploy_owed_at, null);
    assert.equal(after.redeploy_owner, null);
  });

  await t.test('every run died: let go after the last, loudly, not retried forever', async () => {
    const a = await app();
    await owed.owe(pool, a.id, 'secret_change');
    await pool.query(
      `UPDATE apps SET redeploy_kicks = $2, redeploy_owner = 'third-run',
                       redeploy_heartbeat_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
      [a.id, owed.MAX_KICKS]);
    const swept = await owed.sweep(config, pool, { rebuild: async () => { throw new Error('must not run'); } });
    assert.deepEqual(swept.abandoned, [a.id]);
    assert.ok(!swept.kicked.includes(a.id));
    const after = await read(a.id);
    assert.equal(after.redeploy_owed_at, null);
    assert.equal(after.redeploy_owner, null);
  });

  await t.test('the platform\'s own row is never owed one, nor swept in a staging preview', async () => {
    const platform = await app({ selfHosted: true });
    await owed.owe(pool, platform.id, 'secret_change');
    assert.equal((await read(platform.id)).redeploy_owed_at, null);

    const a = await app();
    await owed.owe(pool, a.id, 'secret_change');
    await pool.query(`UPDATE apps SET redeploy_owed_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`, [a.id]);
    const prev = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const swept = await owed.sweep(config, pool, { rebuild: async () => { throw new Error('must not run'); } });
      assert.deepEqual(swept, { kicked: [], abandoned: [] });
    } finally {
      if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
    }
    assert.ok((await read(a.id)).redeploy_owed_at, 'left for production to give');
  });
});
