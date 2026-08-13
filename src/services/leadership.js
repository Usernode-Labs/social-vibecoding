// Cross-instance leader election for zero-downtime (blue-green) deploys.
//
// During a blue-green rollout two platform containers run at once: the live
// color (still serving) and the new color (warming up). Both serve HTTP fine
// — request handling is stateless against the shared Postgres — but the
// platform also runs a pile of SINGLETON background work that must NOT run in
// two processes at once:
//
//   - orphan worker-container adoption (recoverActiveWorkers)
//   - headless-run resume (resumeHeadlessRuns)
//   - stuck-merge / session / issue-close recovery
//   - the idle-eviction / auto-pause / stale-PR sweepers
//   - the main-drift poller
//
// Running those twice causes exactly the double-adoption / double-resume /
// double-merge races we already fight on restarts. This module elects a
// single leader across the colors via a Postgres session-level advisory lock
// so only one instance runs that work at a time. The follower serves HTTP
// immediately (so the deploy can cut traffic over to it) and PROMOTES itself
// — running the singleton work — only once the old leader exits and releases
// the lock.
//
// Backward compatible: when PLATFORM_LEADER_LOCK is unset (local dev, tests,
// any single-instance deploy) the instance is leader immediately at boot, so
// behavior is identical to the pre-blue-green world.

const { Client } = require('pg');
const os = require('os');
const log = require('./logger');

// Database-global advisory-lock keys. Both colors connect to the same
// platform DB, so these elect/serialize across the two processes.
//   LEADER: held for the whole process lifetime by the leader.
//   MIGRATE: held only around schema migration so two booting colors don't
//            run DDL concurrently.
const LEADER_LOCK_KEY = 0x53564c44; // "SVLD"
const MIGRATE_LOCK_KEY = 0x53564d47; // "SVMG"

function leaderLockEnabled() {
  const v = process.env.PLATFORM_LEADER_LOCK;
  return v === '1' || v === 'true';
}

// Run `fn` while holding the migration advisory lock (when enabled) so only
// one color migrates the schema at a time; the other waits, then runs the
// (idempotent) migration as a no-op. Uses a dedicated pooled connection held
// for the duration. No-op wrapper when leader-lock mode is off.
async function withMigrationLock(pool, fn) {
  if (!leaderLockEnabled()) {
    return fn();
  }
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Create a leadership coordinator. `databaseUrl` is the platform DB the
// advisory lock lives in. `onElected` is invoked exactly once, the moment
// this instance becomes leader (immediately at boot for the leader / the
// single-instance case, or later for a follower that gets promoted).
function createLeadership({ databaseUrl }) {
  const enabled = leaderLockEnabled();
  const identity = os.hostname(); // container_name in compose (usernode-blue/green)
  let client = null;
  let isLeader = false;
  let stopped = false;
  let pollHandle = null;
  let onElected = null;

  async function tryAcquire() {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY]);
    return Boolean(rows[0] && rows[0].ok);
  }

  async function elect() {
    isLeader = true;
    try {
      await onElected();
    } catch (err) {
      log.error('leadership', 'onElected handler threw', { identity, err: err.message });
    }
  }

  async function start(onElectedFn) {
    onElected = onElectedFn;

    // Single-instance / dev / tests: leader immediately, no lock needed.
    if (!enabled) {
      isLeader = true;
      await onElected();
      return;
    }

    client = new Client({ connectionString: databaseUrl });
    client.on('error', (err) => {
      log.error('leadership', 'Leader-lock client error', { identity, err: err.message });
    });
    client.on('end', () => {
      if (stopped) return;
      // The dedicated connection dropped, taking the advisory lock with it.
      // If we believed we were leader we are now running leaderless against a
      // possibly-new leader — step down hard so the orchestrator restarts us
      // clean rather than risk two leaders.
      log.error('leadership', 'Leader-lock connection ended unexpectedly', {
        identity, wasLeader: isLeader,
      });
      if (isLeader) process.exit(1);
    });
    await client.connect();

    if (await tryAcquire()) {
      log.info('leadership', 'Acquired leadership at boot', { identity });
      await elect();
      return;
    }

    log.info('leadership', 'Standing by as follower (another color holds leadership)', { identity });
    pollHandle = setInterval(async () => {
      if (isLeader || stopped) return;
      try {
        if (await tryAcquire()) {
          if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
          log.info('leadership', 'Promoted to leader', { identity });
          await elect();
        }
      } catch (err) {
        log.warn('leadership', 'Leadership poll failed', { identity, err: err.message });
      }
    }, 1500);
    // Don't keep the event loop alive just for the poll.
    if (pollHandle.unref) pollHandle.unref();
  }

  // Release the lock promptly on shutdown so the standby color promotes fast.
  // (Process exit would release the session lock anyway; this just avoids
  // waiting on the OS to tear the connection down.)
  async function stop() {
    stopped = true;
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    if (client) {
      try {
        if (isLeader) await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
      } catch (_) { /* best effort */ }
      try { await client.end(); } catch (_) { /* best effort */ }
    }
  }

  return {
    start,
    stop,
    get isLeader() { return isLeader; },
    get enabled() { return enabled; },
    get identity() { return identity; },
  };
}

module.exports = {
  createLeadership,
  withMigrationLock,
  leaderLockEnabled,
  LEADER_LOCK_KEY,
  MIGRATE_LOCK_KEY,
};
