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
    connectionTimeoutMillis: (config && config.dbPoolWaitMs) || 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    options: Object.entries(settings).map(([k, v]) => `-c ${k}=${v}`).join(' '),
  };
}

module.exports = { connectionName, connectionOptions, IDLE_IN_TRANSACTION_MS };
