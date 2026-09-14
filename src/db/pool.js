const { Pool } = require('pg');
const log = require('../services/logger');
const { isConnectionLimitError } = require('./connection-census');

let pool;

function getPool(config) {
  // Lifecycle work uses the same pool with transaction-level ownership checks.
  // Resolve lazily to avoid a module initialization cycle.
  const operation = require('../services/preview-lifecycle').current?.();
  if (operation?.pool) return operation.pool;
  if (!pool) {
    // `max` defaults to pg's built-in 10; config.dbPoolMax lets prod widen
    // it so many concurrent SSE turns + staging DB work don't queue on a
    // starved pool, and narrows it in a staging preview, which shares one
    // Postgres server with the whole fleet (#1771). idleTimeoutMillis lets
    // the pool shed idle connections back down after a burst — but only for
    // a connection nothing reuses, which is why a preview running the fleet
    // sweepers on a timer never shed any.
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax || 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      // #1771: name the one failure that is not this process's fault. A
      // server-side refusal means the shared Postgres is out of backends,
      // and reporting it as "unexpected" is how it gets read as an app bug
      // — which is exactly what happened to a proposal's declared checks.
      if (isConnectionLimitError(err)) {
        log.error('db', 'Postgres refused a connection: the server is at max_connections', {
          message: err.message,
          code: err.code,
          poolMax: config.dbPoolMax || 10,
        });
        return;
      }
      log.error('db', 'Unexpected pool error', { message: err.message });
    });
  }
  return pool;
}

module.exports = { getPool };
