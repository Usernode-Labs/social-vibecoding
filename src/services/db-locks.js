'use strict';

// What is left of the leader election (services/leadership.js, gone with
// the leader): the lock two booting releases take around the schema
// migration, and how a long-lived connection reaps a dead peer.
//
// ── Reaping a dead peer ─────────────────────────────────────────────────
//
// A connection's server-side session lives until the server's OS keepalive
// gives up on a peer that died hard (a kernel panic, a lost VM, a cable):
// two hours and more with Linux's defaults. The workflow runtime's sessions
// hold locks and leases on behalf of their process (src/workflow/platform.ts
// deadPeerOptions), so they are told to reap a dead peer within a minute,
// from both ends:
//
//   - The server probes after SERVER_KEEPALIVE.tcp_keepalives_idle seconds
//     of silence, every _interval seconds, and drops the session after
//     _count unanswered probes (20 + 4 x 5 = 40s). tcp_user_timeout bounds
//     the other case, a reply the dead peer never acknowledged, the same.
//   - The client asks the OS for keepalive probes on its socket too
//     (keepAlive, after KEEPALIVE_INITIAL_DELAY_MS idle).

const KEEPALIVE_INITIAL_DELAY_MS = 10000;
const SERVER_KEEPALIVE = Object.freeze({
  tcp_keepalives_idle: 20, // seconds
  tcp_keepalives_interval: 5, // seconds
  tcp_keepalives_count: 4,
  tcp_user_timeout: 40000, // milliseconds
});

/** Seconds after which the server drops a silent, dead peer's session. */
function serverReapSeconds(k = SERVER_KEEPALIVE) {
  return k.tcp_keepalives_idle + k.tcp_keepalives_interval * k.tcp_keepalives_count;
}

// ── The migration lock ──────────────────────────────────────────────────
//
// Two releases boot at once during a rollout; the schema migration runs in
// one at a time, and the other runs it after as the no-op it then is. A
// database-global advisory lock, held on a dedicated pooled connection for
// the migration's duration. Taken where the platform runs more than one
// process at a time (PLATFORM_LEADER_LOCK, the infrastructure's name for
// it); a single process (local dev, tests) migrates without it.
const MIGRATE_LOCK_KEY = 0x53564d47; // "SVMG"

function migrationLockEnabled() {
  const v = process.env.PLATFORM_LEADER_LOCK;
  return v === '1' || v === 'true';
}

async function withMigrationLock(pool, fn) {
  if (!migrationLockEnabled()) return fn();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = {
  KEEPALIVE_INITIAL_DELAY_MS,
  SERVER_KEEPALIVE,
  MIGRATE_LOCK_KEY,
  serverReapSeconds,
  migrationLockEnabled,
  withMigrationLock,
};
