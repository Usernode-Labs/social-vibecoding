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

// #3344. The head-move form. An author's summary sent WITH a revision is
// stored fresh for that revision's head, but the platform may only learn of
// the head later (a pr-import sweep that had not seen the push yet). When it
// does, the move it is reconciling is the one the author already described,
// so that summary stays fresh. Scoped narrowly: source 'author', not already
// stale, and recorded against exactly the incoming head. Everything else is
// invalidated exactly as INVALIDATE_SQL does. `headParam` is the SQL
// placeholder holding the incoming head.
function invalidateHeadMoveSql(headParam) {
  const keep = `(pr_summary_source = 'author' AND pr_summary_stale = FALSE
              AND pr_summary_source_head_sha IS NOT NULL
              AND pr_summary_source_head_sha = ${headParam}::varchar)`;
  return `pr_summary_input_version = pr_summary_input_version + CASE WHEN ${keep} THEN 0 ELSE 1 END,
            pr_summary_previous_md = COALESCE(CASE WHEN ${keep} THEN NULL ELSE pr_summary_md END,
              pr_summary_previous_md),
            pr_summary_stale = CASE WHEN ${keep} THEN FALSE
              ELSE (pr_summary_stale OR pr_summary_md IS NOT NULL) END`;
}

async function invalidate(pool, sessionId) {
  return pool.query(`UPDATE chat_sessions SET ${INVALIDATE_SQL} WHERE id = $1`, [sessionId]);
}

module.exports = { INVALIDATE_SQL, invalidateHeadMoveSql, bodyHash, invalidate };
