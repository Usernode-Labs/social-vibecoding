'use strict';

// Shared across conductors and restarts. Write before releasing the turn;
// a late teardown must not replace a newer turn's record. This table is
// staging:private and its row lives until the worker is removed.
async function record(pool, sessionId, commit, turnId = null) {
  if (!pool) {
    if (commit) throw new Error('Cannot record unpushed worker changes without the database');
    return;
  }
  const written = await pool.query(
    `INSERT INTO session_workers (session_id, unpushed_sha, unpushed_branch_name)
     SELECT id, $2::text, $3::text FROM chat_sessions
      WHERE id = $1 AND ($4::text IS NULL OR active_turn->>'turnId' = $4) FOR UPDATE
     ON CONFLICT (session_id) DO UPDATE
       SET unpushed_sha = EXCLUDED.unpushed_sha, unpushed_branch_name = EXCLUDED.unpushed_branch_name`,
    [sessionId, commit?.sha ?? null, commit?.branchName ?? null, turnId]);
  return (written.rowCount ?? written.rows?.length ?? 0) === 1;
}

async function read(pool, sessionId, { turnId = null, includeActive = false } = {}) {
  if (!pool) throw new Error('Cannot check unpushed worker changes without the database');
  const { rows: [row] } = await pool.query(
    `SELECT sw.unpushed_sha AS sha, sw.unpushed_branch_name AS "branchName", cs.active_turn IS NOT NULL AS active,
            cs.active_turn->>'turnId' AS turn_id, cs.active_turn->>'phase' AS phase
       FROM session_workers sw JOIN chat_sessions cs ON cs.id = sw.session_id
      WHERE sw.session_id = $1 AND sw.unpushed_sha IS NOT NULL`, [sessionId]);
  // Only the caller's own not-yet-dispatched attempt may look past an
  // active record. A different (or already executing) turn stays untouched.
  if (row?.sha == null) return null;
  const blocked = !!row.active && !(turnId != null && row.turn_id === turnId && row.phase === 'dispatch_pending');
  return blocked && !includeActive ? null : { ...row, blocked };
}

// Clear only what this push observed. A later turn may have recorded a
// different commit while the trusted pusher was finishing.
async function clear(pool, sessionId, sha, branchName) {
  if (!sha || !branchName) return;
  await pool.query(
    `UPDATE session_workers SET unpushed_sha = NULL, unpushed_branch_name = NULL
      WHERE session_id = $1 AND unpushed_sha = $2 AND unpushed_branch_name = $3`,
    [sessionId, sha, branchName]);
}

module.exports = { record, read, clear };
