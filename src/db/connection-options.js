'use strict';

// What every connection this process opens says about itself, and how long
// it waits (item 4: workflow-foundation design-item4-connections.md).
//   - A name per role and pool (`homeroom-web`, `homeroom-conductor`, …), so
//     pg_stat_activity and the server's connection metric say whose each
//     connection is.
//   - A bounded wait: a caller that finds the pool full (or the server
//     slow to accept) waits DB_POOL_WAIT_MS and fails that one request or
//     attempt, instead of queueing forever.
//   - A transaction left open by a client that stopped talking ends after a
//     minute, and a peer that died is reaped within about 40 s (the
//     workflow runtime's settings, services/db-locks.js), so a session
//     advisory lock or a row lock does not outlive its process.
const IDLE_IN_TRANSACTION_MS = 60000;
function connectionName(pool = 'main', env = process.env) {
  if (env.DB_APPLICATION_NAME) return `${env.DB_APPLICATION_NAME}${pool === 'main' ? '' : `-${pool}`}`;
  const role = require('../services/process-role').processRole(env);
  return pool === 'main' ? `homeroom-${role}` : `homeroom-${role}-${pool}`;
}

function connectionOptions(config, { name, idleInTransactionMs = IDLE_IN_TRANSACTION_MS, extra = {} } = {}) {
  const { KEEPALIVE_INITIAL_DELAY_MS, SERVER_KEEPALIVE } = require('../services/db-locks');
  const settings = { ...SERVER_KEEPALIVE, idle_in_transaction_session_timeout: idleInTransactionMs, ...extra };
  return {
    application_name: name,
    connectionTimeoutMillis: (config && config.dbPoolWaitMs) || parseInt(process.env.DB_POOL_WAIT_MS || '10000', 10) || 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    options: Object.entries(settings).map(([k, v]) => `-c ${k}=${v}`).join(' '),
  };
}

// Shrinks a pg Pool to `max` connections at most (a draining process, item 4).
// pg-pool reads options.max only before it opens a connection, so the ones
// above it are closed here: idle ones now, busy ones when they are given back
// (pg-pool's own expiry, the one maxLifetimeSeconds uses). Pinned by
// tests/connection-budget-postgres.test.js against the locked pg-pool.
function shrinkPool(pool, max) {
  if (!pool || !pool.options) return null;
  pool.options.max = Math.max(1, Math.min(pool.options.max, max));
  if (!Array.isArray(pool._clients) || !Array.isArray(pool._idle) || !pool._expired) return pool.options.max;
  let over = pool._clients.length - pool.options.max;
  for (const item of pool._idle.slice()) {
    if (over <= 0) break;
    pool._remove(item.client);
    over -= 1;
  }
  const idle = new Set(pool._idle.map((item) => item.client));
  for (const client of pool._clients) {
    if (over <= 0) break;
    if (idle.has(client) || pool._expired.has(client)) continue;
    pool._expired.add(client);
    over -= 1;
  }
  return pool.options.max;
}

// Connections a shrunk pool still holds above its size: the ones that were
// checked out when it shrank, until they are given back.
function poolExcess(pool) {
  if (!pool || !pool.options) return 0;
  return Math.max(0, (pool.totalCount || 0) - pool.options.max);
}

module.exports = { connectionName, connectionOptions, shrinkPool, poolExcess, IDLE_IN_TRANSACTION_MS };
