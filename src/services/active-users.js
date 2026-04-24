// Shared definition of "active user" used by both PR and issue votes so the
// majority threshold is consistent across the platform.
//
// Per SPEC.md: a user is "active" for an app if they've spent >= 1 minute on
// it within the last 72h (tracked via `app_activity.seconds_spent`).

async function getActiveUserStats(pool, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT user_id) AS cnt FROM app_activity
     WHERE app_id = $1 AND seconds_spent >= 60 AND date >= CURRENT_DATE - 3`,
    [appId]
  );
  const active = Math.max(parseInt(rows[0].cnt, 10) || 0, 1);
  const majority = Math.floor(active / 2) + 1;
  return { active, majority };
}

module.exports = { getActiveUserStats };
