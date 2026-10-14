'use strict';

// The platform's processes and what each one holds (services/processes.js,
// docs/plans/draining-releases.md), against the REAL schema in a throwaway
// PostgreSQL database. Another process is played by the rows it would write:
// what this module must see of it, and what it must not.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/processes-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function until(check, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('processes and their holds, against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'processes_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const processes = require('../src/services/processes');
  t.after(async () => {
    processes._reset();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  // Another process: its row, beaten `ageSeconds` ago, and what it holds.
  async function other(id, { ageSeconds = 0, state = 'serving', holds = [], drainStartedAt = null, role = 'all' } = {}) {
    await pool.query(
      `INSERT INTO platform_processes (id, role, state, heartbeat_at, drain_started_at)
       VALUES ($1, $2, $3, NOW() - make_interval(secs => $4), $5)`,
      [id, role, state, ageSeconds, drainStartedAt]);
    for (const [kind, ref] of holds) {
      await pool.query('INSERT INTO process_holds (process_id, kind, ref) VALUES ($1, $2, $3)', [id, kind, String(ref)]);
    }
  }

  await t.test('before it starts, a hold is this process\'s alone, and nothing elsewhere is seen', async () => {
    const release = processes.hold('session', 7);
    assert.equal(processes.heldHere('session', 7), true);
    assert.equal(processes.heldElsewhere('session', 7), false);
    assert.equal(processes.localCount(), 1);
    assert.deepEqual(await processes.holders('session', 7, null), [processes.ID]);
    release();
    assert.equal(processes.heldHere('session', 7), false);
    assert.throws(() => processes.hold('not-a-kind', 1), /unknown hold kind/);
    assert.throws(() => processes.hold('session', null), /needs a ref/);
  });

  await t.test('registered: the row, the holds taken before, and those after, all reach the database', async () => {
    // In a Kubernetes Pod, this container's dead predecessor (same Pod name)
    // is removed as it starts, its holds with it.
    await other('predecessor', { holds: [['session', 99]] });
    await pool.query(`UPDATE platform_processes SET host = $1 WHERE id = 'predecessor'`, [require('node:os').hostname()]);
    const kube = process.env.KUBERNETES_SERVICE_HOST;
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    const early = processes.hold('staging_build', 11);
    try {
      await processes.start({ pool, role: 'all' });
    } finally {
      if (kube === undefined) delete process.env.KUBERNETES_SERVICE_HOST; else process.env.KUBERNETES_SERVICE_HOST = kube;
    }
    assert.equal((await pool.query(`SELECT 1 FROM platform_processes WHERE id = 'predecessor'`)).rows.length, 0);
    assert.equal((await pool.query(`SELECT 1 FROM process_holds WHERE process_id = 'predecessor'`)).rows.length, 0);
    const { rows: [me] } = await pool.query('SELECT * FROM platform_processes WHERE id = $1', [processes.ID]);
    assert.equal(me.state, 'serving');
    const late = processes.hold('session', 12);
    await processes.flush();
    const { rows } = await pool.query('SELECT kind, ref FROM process_holds WHERE process_id = $1 ORDER BY kind', [processes.ID]);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.ref}`), ['session:12', 'staging_build:11']);
    early(); late();
    await processes.flush();
    const { rows: none } = await pool.query('SELECT 1 FROM process_holds WHERE process_id = $1', [processes.ID]);
    assert.equal(none.length, 0, 'the last release removes the row');
  });

  await t.test('counted: a second hold of the same thing keeps it until both are released', async () => {
    const a = processes.hold('session', 20);
    const b = processes.hold('session', 20);
    a(); a();
    await processes.flush();
    assert.equal(processes.heldHere('session', 20), true, 'a release called twice counts once');
    assert.equal((await pool.query(`SELECT 1 FROM process_holds WHERE process_id = $1 AND ref = '20'`, [processes.ID])).rows.length, 1);
    b();
    await processes.flush();
    assert.equal(processes.heldHere('session', 20), false);
    assert.equal(processes.localCount(), 0);
  });

  await t.test('another live process\'s holds are seen; a gone one\'s are not', async () => {
    await other('pod-old', { state: 'draining', holds: [['session', 30], ['shots', 31]], drainStartedAt: new Date() });
    await other('pod-dead', { ageSeconds: processes.LIVE_SECONDS + 30, holds: [['session', 32]] });
    await processes.refreshMirror();
    assert.equal(processes.heldElsewhere('session', 30), true);
    assert.equal(processes.heldAnywhere('shots', 31), true);
    assert.equal(processes.heldElsewhere('session', 32), false, 'a process that stopped beating holds nothing');
    assert.deepEqual(processes.refsElsewhere('session'), ['30']);
    assert.deepEqual(await processes.holders('session', 30), ['pod-old']);
    assert.deepEqual(await processes.holders('session', 32), []);
    // A copy that could not be refreshed for longer than a process lives
    // vouches for nobody.
    const realNow = Date.now;
    Date.now = () => realNow() + (processes.LIVE_SECONDS + 5) * 1000;
    try {
      assert.equal(processes.heldElsewhere('session', 30), false);
      assert.deepEqual(processes.refsElsewhere('session'), []);
    } finally { Date.now = realNow; }
    // Its release reaches this process at the next refresh.
    await pool.query(`DELETE FROM process_holds WHERE process_id = 'pod-old' AND ref = '30'`);
    await processes.refreshMirror();
    assert.equal(processes.heldElsewhere('session', 30), false);
  });

  await t.test('the beat writes every hold again: a write the database lost comes back', async () => {
    const release = processes.hold('capture', 40);
    await processes.flush();
    await pool.query('DELETE FROM process_holds WHERE process_id = $1', [processes.ID]);
    await pool.query(`INSERT INTO process_holds (process_id, kind, ref) VALUES ($1, 'session', '41')`, [processes.ID]);
    await processes.beat();
    const { rows } = await pool.query('SELECT kind, ref FROM process_holds WHERE process_id = $1', [processes.ID]);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.ref}`), ['capture:40'], 'what this process holds, and only that');
    // A row the leader reaped while this process stalled comes back too.
    await pool.query('DELETE FROM platform_processes WHERE id = $1', [processes.ID]);
    await processes.beat();
    assert.equal((await pool.query('SELECT 1 FROM process_holds WHERE process_id = $1', [processes.ID])).rows.length, 1);
    release();
    await processes.flush();
  });

  await t.test('draining: the row says so, and newer draining processes of the role are counted', async () => {
    await processes.markDraining(new Date(Date.now() + 60_000));
    const { rows: [me] } = await pool.query('SELECT state, drain_deadline_at FROM platform_processes WHERE id = $1', [processes.ID]);
    assert.equal(me.state, 'draining');
    assert.ok(me.drain_deadline_at);
    assert.equal(await processes.newerDraining(), 0, 'pod-old began before this one');
    await other('pod-newer', { state: 'draining', drainStartedAt: new Date(Date.now() + 1000) });
    await other('pod-newer-web', { state: 'draining', role: 'web', drainStartedAt: new Date(Date.now() + 1000) });
    await other('pod-newer-dead', { state: 'draining', ageSeconds: 600, drainStartedAt: new Date(Date.now() + 1000) });
    assert.equal(await processes.newerDraining(), 1, 'live, of this role, and newer');
    // A successor: a live process of this role, serving.
    assert.equal(await processes.servingOthers(), 0, 'every other one here is draining, dead or of another role');
    await other('pod-successor', { state: 'serving' });
    await other('pod-web', { state: 'serving', role: 'web' });
    await other('pod-successor-dead', { state: 'serving', ageSeconds: 600 });
    // One serving that started before this one is no successor (a replica
    // stopping beside it would be marked draining; an older one serving is
    // the one this replaced, or a peer).
    await pool.query(`INSERT INTO platform_processes (id, state, started_at) VALUES ('pod-older', 'serving', NOW() - interval '1 hour')`);
    assert.equal(await processes.servingOthers(), 1);
    // A conductor leads in an 'all' process's place (process-role.js
    // successorRoles): it is a successor, and a fellow drainer.
    await other('pod-conductor', { state: 'serving', role: 'conductor' });
    assert.equal(await processes.servingOthers(), 2, 'the conductor takes over leading');
    await other('pod-newer-conductor', { state: 'draining', role: 'conductor', drainStartedAt: new Date(Date.now() + 1000) });
    assert.equal(await processes.newerDraining(), 2, 'and drains beside it');
    // A beat keeps the drain: it does not put the row back to serving.
    await processes.beat();
    assert.equal((await pool.query('SELECT state FROM platform_processes WHERE id = $1', [processes.ID])).rows[0].state, 'draining');
  });

  await t.test('the leader reaps long-gone rows and their holds; live ones are listed', async () => {
    await other('pod-ancient', { ageSeconds: processes.REAP_AFTER_SECONDS + 60, holds: [['session', 50]] });
    assert.ok(await processes.reap() >= 1);
    assert.equal((await pool.query(`SELECT 1 FROM process_holds WHERE process_id = 'pod-ancient'`)).rows.length, 0);
    const live = await processes.list();
    assert.ok(live.some((p) => p.id === processes.ID));
    assert.ok(!live.some((p) => p.id === 'pod-dead'));
  });

  await t.test('stopping deletes this process\'s row and holds, so what it leaves is free at once', async () => {
    processes.hold('session', 60);
    await processes.flush();
    await processes.stop();
    assert.equal((await pool.query('SELECT 1 FROM platform_processes WHERE id = $1', [processes.ID])).rows.length, 0);
    assert.equal((await pool.query('SELECT 1 FROM process_holds WHERE process_id = $1', [processes.ID])).rows.length, 0);
    assert.equal(processes.heldElsewhere('session', 30), false, 'a stopped registry sees nothing elsewhere');
    await until(() => true);
  });
});
