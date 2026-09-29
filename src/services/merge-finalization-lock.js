'use strict';

const { MERGE_FINALIZATION_LOCK } = require('./advisory-locks');

// A session-level advisory lock survives the GitHub and deploy round trips
// without holding a transaction open. A dead process releases it. `tryOnly`
// lets recovery leave a live finalizer alone and revisit it on the next tick.
async function acquire(pool, sessionId, { tryOnly = false } = {}) {
  // Small route tests use query-only pools. Production's pg Pool has connect.
  if (typeof pool.connect !== 'function') return async () => {};
  const client = await pool.connect();
  try {
    const { rows } = tryOnly
      ? await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [MERGE_FINALIZATION_LOCK, sessionId])
      : await client.query('SELECT pg_advisory_lock($1, $2) AS acquired',
        [MERGE_FINALIZATION_LOCK, sessionId]);
    if (tryOnly && !rows[0]?.acquired) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [MERGE_FINALIZATION_LOCK, sessionId]);
      } finally {
        client.release();
      }
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

module.exports = { acquire };
