const { Pool } = require('pg');
const log = require('../services/logger');

let pool;

function getPool(config) {
  if (!pool) {
    // `max` defaults to pg's built-in 10; config.dbPoolMax lets prod widen
    // it so many concurrent SSE turns + staging DB work don't queue on a
    // starved pool. idleTimeoutMillis lets the pool shed idle connections
    // back down after a burst.
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax || 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      log.error('db', 'Unexpected pool error', { message: err.message });
    });
  }
  return pool;
}

module.exports = { getPool };
