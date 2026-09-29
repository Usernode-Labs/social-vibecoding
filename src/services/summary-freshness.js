'use strict';

const crypto = require('node:crypto');

// Freshness is metadata about the last summary, not permission to hide it.
// A failed or delayed refresh must leave the last useful explanation visible.
const INVALIDATE_SQL = `pr_summary_input_version = pr_summary_input_version + 1,
            pr_summary_previous_md = COALESCE(pr_summary_md, pr_summary_previous_md),
            pr_summary_stale = pr_summary_stale OR pr_summary_md IS NOT NULL`;

function bodyHash(body) {
  return crypto.createHash('sha256').update(String(body || '')).digest('hex');
}

async function invalidate(pool, sessionId) {
  return pool.query(`UPDATE chat_sessions SET ${INVALIDATE_SQL} WHERE id = $1`, [sessionId]);
}

module.exports = { INVALIDATE_SQL, bodyHash, invalidate };
