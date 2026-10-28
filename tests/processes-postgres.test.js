'use strict';

// The platform's processes (services/processes.js, docs/plans/
// draining-releases.md), against the REAL schema in a throwaway PostgreSQL
// database: the roster, and this process's holds, which are its own drain's,
// in its memory, and which no other process reads. Another process is played
// by the row it would write.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/processes-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool, Client } = require('pg');

const { waitFor, within } = require('./lib/wait-for');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

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
  // How often the process would have exited for a capacity claim it lost.
  let claimLost = 0;
  t.after(async () => {
    processes._reset();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  // Another process: its row, beaten `ageSeconds` ago.
  async function other(id, { ageSeconds = 0, state = 'serving', drainStartedAt = null, role = 'all', release = null } = {}) {
    await pool.query(
      `INSERT INTO platform_processes (id, role, state, heartbeat_at, drain_started_at, release)
       VALUES ($1, $2, $3, NOW() - make_interval(secs => $4), $5, $6)`,
      [id, role, state, ageSeconds, drainStartedAt, release]);
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
    for (const gone of ['heldElsewhere', 'heldAnywhere', 'holders', 'refreshMirror', 'refsElsewhere', 'whenReleasedElsewhere', 'writeHolds']) {
      assert.equal(processes[gone], undefined, `no process reads another's holds (${gone})`);
    }
  });

  await t.test('registered: the row, and nothing of its holds: they stay in its memory', async () => {
    // In a Kubernetes Pod, this container's dead predecessor (same Pod name)
    // is removed as it starts.
    await other('predecessor');
    await pool.query(`UPDATE platform_processes SET host = $1 WHERE id = 'predecessor'`, [require('node:os').hostname()]);
    const kube = process.env.KUBERNETES_SERVICE_HOST;
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    const early = processes.hold('session', 11);
    try {
      await processes.start({ pool, role: 'all', onClaimLost: () => { claimLost += 1; } });
    } finally {
      if (kube === undefined) delete process.env.KUBERNETES_SERVICE_HOST; else process.env.KUBERNETES_SERVICE_HOST = kube;
    }
    assert.equal((await pool.query(`SELECT 1 FROM platform_processes WHERE id = 'predecessor'`)).rows.length, 0);
    const { rows: [me] } = await pool.query('SELECT * FROM platform_processes WHERE id = $1', [processes.ID]);
    assert.equal(me.state, 'serving');

    const late = processes.hold('handoff', 12);
    await processes.beat();
    assert.equal((await pool.query(`SELECT to_regclass('process_holds') AS t`)).rows[0].t, null,
      'holds are this process\'s own: no table for them');
    assert.equal((await pool.query(`SELECT to_regclass('leader_sweeps') AS t`)).rows[0].t, null, 'the leader\'s sweep times are gone');
    assert.equal(require('../src/services/turn-leftovers').olderProcessHolding, undefined, 'and nothing reads another process\'s');
    late(); early();
    await other('pod-old');
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
    // Started since this drain began (item 4: a draining process still
    // above its drain sizes hands over when one does): live, of a role that
    // could replace this one, in any state; not one older than the drain.
    await pool.query('DELETE FROM platform_processes WHERE id <> $1', [processes.ID]);
    assert.equal(await processes.startedSinceDrain(), 0);
    await pool.query(`INSERT INTO platform_processes (id, state, started_at) VALUES ('pod-before', 'serving', NOW() - interval '1 hour')`);
    await other('pod-web-new', { role: 'web' });
    await other('pod-dead-new', { ageSeconds: 600 });
    assert.equal(await processes.startedSinceDrain(), 0, 'older, another role, or gone');
    await other('pod-conductor-new', { role: 'conductor' });
    await other('pod-all-new-draining', { state: 'draining', drainStartedAt: new Date() });
    assert.equal(await processes.startedSinceDrain(), 2);
    // The roster never waits on the main pool: a draining process whose pool
    // is all checked out (the connections it kept when it shrank) still
    // beats and still sees the Pod that should make it hand over.
    const taken = await Promise.all(Array.from({ length: 6 }, () => pool.connect()));
    try {
      assert.equal(await within(processes.startedSinceDrain(), 3000, 'startedSinceDrain with the pool checked out'), 2);
      assert.equal(await within(processes.newerDraining(), 3000, 'newerDraining with the pool checked out'), 1, 'pod-all-new-draining');
      assert.equal(await within(processes.beat().then(() => 'beat'), 3000, 'a beat with the pool checked out'), 'beat');
    } finally {
      for (const c of taken) c.release();
    }
    // A beat keeps the drain: it does not put the row back to serving.
    await processes.beat();
    assert.equal((await pool.query('SELECT state FROM platform_processes WHERE id = $1', [processes.ID])).rows[0].state, 'draining');
  });

  await t.test('a draining process holds a capacity claim until it holds nothing above its drain sizes; a starting one waits on claims', async () => {
    const claims = async (classid) => (await pool.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND classid = $1::oid`, [classid])).rows[0].n;
    // Marked draining (above), it took its claim: role 'all', 991021.
    assert.equal(await claims(991021), 1);
    processes.setAboveDrain(3);
    assert.equal(await claims(991021), 1, 'still above its drain sizes');
    processes.setAboveDrain(0);
    await waitFor(async () => (await claims(991021)) === 0, { label: 'the claim given back' });

    // This process starting: no claim of a role it replaces, no wait.
    assert.ok((await processes.waitForRoom({ pollMs: 20 })).waitedMs < 1000);
    // Another process's claim, with no roster row at all (its row went
    // first, its connections have not closed yet): it waits.
    const other = new Client({ connectionString: String(url) });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock(990001, 7)');
      assert.ok((await processes.waitForRoom({ pollMs: 20 })).waitedMs < 1000, 'another lock is no claim');
      await other.query('SELECT pg_advisory_lock(991022, 7)');
      let done = false;
      // A counting read stands in for the claim probe: two reads that found
      // the claim prove it is still waiting, without a fixed sleep.
      let refused = 0;
      const waiting = processes.waitForRoom({
        pollMs: 20,
        read: async () => { refused += 1; return { rows: [{ processes: await claims(991022) }] }; },
      }).then((r) => { done = true; return r; });
      await waitFor(() => refused >= 2, { label: 'two reads that found the claim' });
      assert.equal(done, false, 'waits while a process it replaces holds a claim');
      await other.query('SELECT pg_advisory_unlock(991022, 7)');
      const waited = await waiting;
      assert.ok(waited.waitedMs > 0, 'it waited for the claim to go');
      assert.ok(refused >= 2, 'it read the claim again rather than taking one look');
      // The claim goes when that process's connection closes, whatever it did.
      await other.query('SELECT pg_advisory_lock(991023, 8)');
      done = false;
      let refusedAgain = 0;
      const again = processes.waitForRoom({
        pollMs: 20,
        read: async () => { refusedAgain += 1; return { rows: [{ processes: await claims(991023) }] }; },
      }).then(() => { done = true; });
      await waitFor(() => refusedAgain >= 2, { label: 'two reads that found the claim before its connection closed' });
      assert.equal(done, false);
      await other.end();
      await again;
    } finally {
      await other.end().catch(() => {});
    }

    // A claim in another database is an app's, not a process's.
    const elsewhere = new Client({ connectionString: DSN });
    await elsewhere.connect();
    try {
      await elsewhere.query('SELECT pg_advisory_lock(991022, 9)');
      assert.ok((await processes.waitForRoom({ pollMs: 20 })).waitedMs < 1000, 'another database\'s lock is no claim');
    } finally {
      await elsewhere.end();
    }

    // Fails closed: a claim that goes with its connection while it still
    // stands for connections above the drain sizes ends the process.
    const claimBackend = `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted
      AND classid = 991021::oid AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    await processes.markDraining(new Date(Date.now() + 60_000));
    assert.equal(await claims(991021), 1);
    processes.setAboveDrain(2);
    await pool.query(claimBackend);
    await waitFor(() => claimLost === 1, { label: 'the claim lost' });
    // A claim already given back is nothing to lose.
    await waitFor(async () => (await claims(991021)) === 0, { label: 'the old claim gone' });
    await processes.markDraining(new Date(Date.now() + 60_000));
    await waitFor(async () => (await claims(991021)) === 1, { label: 'a new claim' });
    processes.setAboveDrain(0);
    await waitFor(async () => (await claims(991021)) === 0, { label: 'given back' });
    await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'homeroom-%-locks'
      AND datname = current_database() AND pid <> pg_backend_pid()`);
    // The connection's loss is handled once session-locks has marked it dead
    // (and run any onLost); nothing held means nothing was reported lost.
    const locks = require('../src/db/session-locks');
    await waitFor(() => locks.openConnections() === 0, { label: 'the process lock connection gone' });
    assert.equal(claimLost, 1, 'nothing held, nothing lost');

    // A read that fails is tried again, never taken for room.
    let reads = 0;
    const out = await processes.waitForRoom({
      pollMs: 5,
      read: async () => { reads += 1; if (reads < 3) throw new Error('connection reset'); return { rows: [{ processes: 0 }] }; },
    });
    assert.equal(reads, 3);
    assert.ok(out.waitedMs >= 0);
    // A claim taken again for the stop below.
    await processes.markDraining(new Date(Date.now() + 60_000));
    assert.equal(await claims(991021), 1);
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
    const held = processes.hold('session', 21);
    await processes.stop();
    held();
    assert.equal((await pool.query('SELECT 1 FROM platform_processes WHERE id = $1', [processes.ID])).rows.length, 0);
    // The row is gone; the capacity claim is not: it goes with the
    // connection, which closes after the pool's own end.
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 991021::oid`)).rows[0].n, 1);
  });
});

test('a claim that cannot be taken ends the process rather than drain unclaimed', { timeout: 30000 }, async () => {
  delete require.cache[require.resolve('../src/services/processes')];
  const processes = require('../src/services/processes');
  let lost = 0;
  const nowhere = new Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
  try {
    await processes.start({ pool: nowhere, role: 'web', onClaimLost: () => { lost += 1; } });
    await processes.markDraining(new Date(Date.now() + 60_000)).catch(() => {});
    await waitFor(() => lost > 0, { label: 'the claim loss that ends the process' });
    assert.equal(lost, 1);
  } finally {
    processes._reset();
    await nowhere.end().catch(() => {});
    delete require.cache[require.resolve('../src/services/processes')];
  }
});
