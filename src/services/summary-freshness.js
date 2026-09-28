'use strict';

const crypto = require('node:crypto');

// Keep the voter-facing text visible only while it describes the current
// proposal inputs. The previous copy is retained for provenance and author
// recovery, but ordinary proposal reads use pr_summary_md alone.
const INVALIDATE_SQL = `pr_summary_input_version = pr_summary_input_version + 1,
            pr_summary_previous_md = COALESCE(pr_summary_md, pr_summary_previous_md),
            pr_summary_stale = pr_summary_stale OR pr_summary_md IS NOT NULL,
            pr_summary_md = NULL`;

function bodyHash(body) {
  return crypto.createHash('sha256').update(String(body || '')).digest('hex');
}

async function invalidate(pool, sessionId) {
  return pool.query(`UPDATE chat_sessions SET ${INVALIDATE_SQL} WHERE id = $1`, [sessionId]);
}

module.exports = { INVALIDATE_SQL, bodyHash, invalidate };
