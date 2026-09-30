'use strict';

const { DELETED_SESSION_ACTION_LOCK } = require('../advisory-locks');

async function readSession(client, sessionId, { lock = false } = {}) {
  const result = lock
    ? await client.query('SELECT * FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId])
    : await client.query('SELECT * FROM chat_sessions WHERE id = $1', [sessionId]);
  const session = result.rows[0] || null;

  if (lock && !session) {
    // Shared fallback for every machine after aggregate deletion. A domain's
    // resource row cannot serialize actions targeting different old resources.
    // Original session IDs must never be recycled. This does not fence I/O.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [DELETED_SESSION_ACTION_LOCK, sessionId]);
  }
  return session;
}

module.exports = { readSession };
