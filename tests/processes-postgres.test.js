'use strict';

// The platform's processes (services/processes.js, docs/plans/
// draining-releases.md), against the REAL schema in a throwaway PostgreSQL
// database: the roster, and this process's holds, which stay in its memory
// for its own drain and are written nowhere. Another process is played by
// the rows it would write.
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

test('processes and the roster, against the full schema', { timeout: 120000 }, async (t) => {
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
  async function other(id, { ageSeconds = 0, state = 'serving', holds = [], drainStartedAt = null, role = 'all', release = null } = {}) {
    await pool.query(
      `INSERT INTO platform_processes (id, role, state, heartbeat_at, drain_started_at, release)
       VALUES ($1, $2, $3, NOW() - make_interval(secs => $4), $5, $6)`,
      [id, role, state, ageSeconds, drainStartedAt, release]);
    for (const [kind, ref] of holds) {
      await pool.query('INSERT INTO process_holds (process_id, kind, ref) VALUES ($1, $2, $3)', [id, kind, String(ref)]);
    }
  }

  await t.test('a hold is this process\'s alone, in memory, counted for its drain', async () => {
    const release = processes.hold('session', 7);
    const again = processes.hold('session', 7);
    assert.equal(processes.heldHere('session', 7), true);
    assert.equal(processes.localCount(), 1);
    release(); release();
    assert.equal(processes.heldHere('session', 7), true, 'a release called twice counts once');
    again();
    assert.equal(processes.heldHere('session', 7), false);
    assert.equal(processes.localCount(), 0);
    assert.throws(() => processes.hold('not-a-kind', 1), /unknown hold kind/);
    assert.throws(() => processes.hold('session', null), /needs a ref/);
    for (const gone of ['heldElsewhere', 'heldAnywhere', 'holders', 'refreshMirror', 'refsElsewhere', 'whenReleasedElsewhere']) {
      assert.equal(processes[gone], undefined, `no process reads another's holds (${gone})`);
    }
  });

  await t.test('registered: the row, and no hold written anywhere', async () => {
    // In a Kubernetes Pod, this container's dead predecessor (same Pod name)
    // is removed as it starts.
    await other('predecessor');
    await pool.query(`UPDATE platform_processes SET host = $1 WHERE id = 'predecessor'`, [require('node:os').hostname()]);
    const kube = process.env.KUBERNETES_SERVICE_HOST;
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    const early = processes.hold('session', 11);
    try {
      await processes.start({ pool, role: 'all' });
    } finally {
      if (kube === undefined) delete process.env.KUBERNETES_SERVICE_HOST; else process.env.KUBERNETES_SERVICE_HOST = kube;
    }
    assert.equal((await pool.query(`SELECT 1 FROM platform_processes WHERE id = 'predecessor'`)).rows.length, 0);
    const { rows: [me] } = await pool.query('SELECT * FROM platform_processes WHERE id = $1', [processes.ID]);
    assert.equal(me.state, 'serving');
    const late = processes.hold('session', 12);
    await processes.beat();
    assert.equal((await pool.query('SELECT 1 FROM process_holds')).rows.length, 0, 'nothing written');
    early(); late();
    // A row the process-reap clock reaped while this process stalled comes
    // back with the next beat.
    await pool.query('DELETE FROM platform_processes WHERE id = $1', [processes.ID]);
    await processes.beat();
    assert.equal((await pool.query('SELECT 1 FROM platform_processes WHERE id = $1', [processes.ID])).rows.length, 1);
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
    // Counted by release, not by process: the replicas of one newer release
    // count once (a release replaces every conductor), and a replica of
    // this process's own release draining beside it is no newer release.
    await pool.query(`DELETE FROM platform_processes WHERE id IN ('pod-newer', 'pod-newer-conductor')`);
    const own = process.env.GIT_SHA;
    process.env.GIT_SHA = 'release-a';
    try {
      const later = new Date(Date.now() + 1000);
      await other('pod-b1', { state: 'draining', role: 'conductor', drainStartedAt: later, release: 'release-b' });
      await other('pod-b2', { state: 'draining', role: 'conductor', drainStartedAt: later, release: 'release-b' });
      await other('pod-a2', { state: 'draining', role: 'conductor', drainStartedAt: later, release: 'release-a' });
      assert.equal(await processes.newerDraining(), 1, 'one newer release, whatever its replicas');
      await other('pod-c1', { state: 'draining', drainStartedAt: later, release: 'release-c' });
      assert.equal(await processes.newerDraining(), 2);
    } finally {
      if (own === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = own;
    }
    // A beat keeps the drain: it does not put the row back to serving.
    await processes.beat();
    assert.equal((await pool.query('SELECT state FROM platform_processes WHERE id = $1', [processes.ID])).rows[0].state, 'draining');
  });

  await t.test('the process-reap clock deletes long-gone rows; live ones are listed', async () => {
    await other('pod-ancient', { ageSeconds: processes.REAP_AFTER_SECONDS + 60 });
    await other('pod-dead', { ageSeconds: processes.LIVE_SECONDS + 30 });
    assert.ok(await processes.reap() >= 1);
    assert.equal((await pool.query(`SELECT 1 FROM platform_processes WHERE id = 'pod-ancient'`)).rows.length, 0);
    const live = await processes.list();
    assert.ok(live.some((p) => p.id === processes.ID));
    assert.ok(!live.some((p) => p.id === 'pod-dead'));
  });

  await t.test('stopping deletes this process\'s row, so it is not counted as live after it', async () => {
    await processes.stop();
    assert.equal((await pool.query('SELECT 1 FROM platform_processes WHERE id = $1', [processes.ID])).rows.length, 0);
    await until(() => true);
  });
});
