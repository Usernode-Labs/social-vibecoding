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

// ── Keeping the lock honest when a machine dies ────────────────────────
//
// The lock is a session lock: Postgres releases it when the session ends.
// When the leader's node died hard (a kernel panic, a lost VM, a cable), no
// FIN or RST ever reached the server, so the session lived on until the
// server's OS keepalive gave up on it — two hours and more with Linux's
// defaults — and for all of that time no Pod could be promoted and every
// sweeper, recovery and reconciler in becomeLeader() stood still.
//
// So the lock connection is told to reap a dead peer within a minute, from
// both ends:
//
//   - The server probes after SERVER_KEEPALIVE.tcp_keepalives_idle seconds
//     of silence, every _interval seconds, and drops the session after
//     _count unanswered probes (20 + 4 x 5 = 40s), so a dead leader's
//     session and its lock are gone within that. tcp_user_timeout bounds
//     the other case, a reply the dead peer never acknowledged, the same.
//     Set on this one session with set_config (each its own query, so a
//     server that refuses one keeps the rest); they are ordinary user
//     settings, and set_config applies them to the socket exactly as SET.
//   - The client asks the OS for keepalive probes on its socket too
//     (keepAlive, after KEEPALIVE_INITIAL_DELAY_MS idle).
//
// Reaping faster opens the opposite failure: a leader that is alive but cut
// off from the database for longer than the server waits loses its lock
// without knowing, and keeps running leader work beside the Pod promoted in
// its place. So while it leads, the lock connection answers a heartbeat
// every HEARTBEAT_MS; one not answered within HEARTBEAT_TIMEOUT_MS (or an
// error) steps the process down exactly as a dropped connection always has
// (exit 1, and the orchestrator restarts it clean). The worst case — a
// partition beginning just after a heartbeat — is noticed after
// HEARTBEAT_MS + HEARTBEAT_TIMEOUT_MS (30s), before the server can have
// reaped the session (40s); tests/leadership-keepalive.test.js pins the
// order.
const KEEPALIVE_INITIAL_DELAY_MS = 10000;
const SERVER_KEEPALIVE = Object.freeze({
  tcp_keepalives_idle: 20, // seconds
  tcp_keepalives_interval: 5, // seconds
  tcp_keepalives_count: 4,
  tcp_user_timeout: 40000, // milliseconds
});
const HEARTBEAT_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 20000;

/** The pg.Client options for the dedicated lock connection. */
function lockClientOptions(databaseUrl) {
  return {
    connectionString: databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
  };
}

/** Seconds after which the server drops a silent, dead peer's session. */
function serverReapSeconds(k = SERVER_KEEPALIVE) {
  return k.tcp_keepalives_idle + k.tcp_keepalives_interval * k.tcp_keepalives_count;
}

async function tuneServerKeepalives(client, identity) {
  for (const [name, value] of Object.entries(SERVER_KEEPALIVE)) {
    try {
      // false: for the session, not just a transaction.
      await client.query('SELECT set_config($1, $2, false)', [name, String(value)]);
    } catch (err) {
      log.warn('leadership', 'Leader-lock keepalive setting refused', { identity, name, err: err.message });
    }
  }
}

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
//
// `clientFactory`, `exit`, `heartbeatMs` and `heartbeatTimeoutMs` are for
// tests; production passes none of them.
function createLeadership({
  databaseUrl,
  clientFactory = (options) => new Client(options),
  exit = (code) => process.exit(code),
  heartbeatMs = HEARTBEAT_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
} = {}) {
  const enabled = leaderLockEnabled();
  const identity = os.hostname(); // container_name in compose (usernode-blue/green)
  let client = null;
  let isLeader = false;
  let stopped = false;
  let pollHandle = null;
  let heartbeatHandle = null;
  let steppedDown = false;
  let onElected = null;

  async function tryAcquire() {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY]);
    return Boolean(rows[0] && rows[0].ok);
  }

  // The lock may be gone. A leader steps down hard so the orchestrator
  // restarts it clean rather than risk two leaders; a follower only says so.
  function lockLost(message, detail) {
    if (stopped || steppedDown) return;
    log.error('leadership', message, { identity, wasLeader: isLeader, ...detail });
    if (!isLeader) return;
    steppedDown = true;
    if (heartbeatHandle) { clearInterval(heartbeatHandle); heartbeatHandle = null; }
    exit(1);
  }

  function startHeartbeat() {
    if (!client || heartbeatHandle || !(heartbeatMs > 0)) return;
    let beating = false;
    heartbeatHandle = setInterval(async () => {
      if (stopped || beating) return;
      beating = true;
      let timer = null;
      try {
        await Promise.race([
          client.query('SELECT 1'),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${heartbeatTimeoutMs}ms`)), heartbeatTimeoutMs);
          }),
        ]);
      } catch (err) {
        lockLost('Leader-lock heartbeat failed; stepping down', { err: err.message });
      } finally {
        if (timer) clearTimeout(timer);
        beating = false;
      }
    }, heartbeatMs);
    if (heartbeatHandle.unref) heartbeatHandle.unref();
  }

  async function elect() {
    isLeader = true;
    startHeartbeat();
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

    client = clientFactory(lockClientOptions(databaseUrl));
    client.on('error', (err) => {
      log.error('leadership', 'Leader-lock client error', { identity, err: err.message });
    });
    client.on('end', () => {
      // The dedicated connection dropped, taking the advisory lock with it.
      // If we believed we were leader we are now running leaderless against a
      // possibly-new leader — step down hard so the orchestrator restarts us
      // clean rather than risk two leaders.
      lockLost('Leader-lock connection ended unexpectedly', {});
    });
    await client.connect();
    await tuneServerKeepalives(client, identity);

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
    if (heartbeatHandle) { clearInterval(heartbeatHandle); heartbeatHandle = null; }
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
  lockClientOptions,
  serverReapSeconds,
  LEADER_LOCK_KEY,
  MIGRATE_LOCK_KEY,
  KEEPALIVE_INITIAL_DELAY_MS,
  SERVER_KEEPALIVE,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
};
