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

// #3344: the head-move form is the proposal machine's, which moves a
// proposal's head (src/workflow/rules/summary-freshness.ts); re-exported here
// for the code that reads the rule.
const { invalidateHeadMoveSql } = require('../workflow/rules/summary-freshness.ts');

async function invalidate(pool, sessionId) {
  return pool.query(`UPDATE chat_sessions SET ${INVALIDATE_SQL} WHERE id = $1`, [sessionId]);
}

module.exports = { INVALIDATE_SQL, invalidateHeadMoveSql, bodyHash, invalidate };
