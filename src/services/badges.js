'use strict';

const log = require('./logger');

const BADGE_DEFS = [
  { key: 'voter_streak_30',   emoji: '📅', label: '30-day voter',   rank: 1 },
  { key: 'kudos_given_10',    emoji: '🌟', label: '10 kudos given', rank: 2 },
  { key: 'merges_10',         emoji: '💎', label: '10 merges',      rank: 3 },
  { key: 'merges_5',          emoji: '🔥', label: '5 merges',       rank: 4 },
  { key: 'first_kudos_given', emoji: '👏', label: 'First kudos',    rank: 5 },
  { key: 'first_vote',        emoji: '🗳️', label: 'First vote',     rank: 6 },
  { key: 'first_merge',       emoji: '🏅', label: 'First merge',    rank: 7 },
];

// CASE expression for consistent badge ordering in SQL queries.
const BADGE_RANK_SQL = `CASE badge_key
  WHEN 'voter_streak_30'   THEN 1
  WHEN 'kudos_given_10'    THEN 2
  WHEN 'merges_10'         THEN 3
  WHEN 'merges_5'          THEN 4
  WHEN 'first_kudos_given' THEN 5
  WHEN 'first_vote'        THEN 6
  WHEN 'first_merge'       THEN 7
  ELSE 8 END`;

async function tryAward(pool, userId, badgeKey) {
  const { rowCount } = await pool.query(
    `INSERT INTO user_badges (user_id, badge_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, badgeKey]
  );
  return rowCount > 0;
}

// Fire-and-forget from merge/kudos/vote hot paths.
// trigger: 'merge' | 'kudos_given' | 'vote'
async function checkAndAwardBadges(pool, userId, trigger) {
  if (!userId) return;
  try {
    if (trigger === 'merge') {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
         WHERE user_id = $1 AND status = 'merged'`,
        [userId]
      );
      const mergeCount = parseInt(rows[0].cnt, 10);
      if (mergeCount >= 1)  await tryAward(pool, userId, 'first_merge');
      if (mergeCount >= 5)  await tryAward(pool, userId, 'merges_5');
      if (mergeCount >= 10) await tryAward(pool, userId, 'merges_10');
    }

    if (trigger === 'kudos_given') {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM pr_kudos WHERE giver_user_id = $1`,
        [userId]
      );
      const givenCount = parseInt(rows[0].cnt, 10);
      if (givenCount >= 1)  await tryAward(pool, userId, 'first_kudos_given');
      if (givenCount >= 10) await tryAward(pool, userId, 'kudos_given_10');
    }

    if (trigger === 'vote') {
      const { rows: voteRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM pr_votes WHERE user_id = $1`,
        [userId]
      );
      if (parseInt(voteRows[0].cnt, 10) >= 1) {
        await tryAward(pool, userId, 'first_vote');
      }
      // 30-day voter streak: distinct calendar days with a vote in the last 30 days
      const { rows: streakRows } = await pool.query(
        `SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'UTC')::date) AS days
         FROM pr_votes
         WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [userId]
      );
      if (parseInt(streakRows[0].days, 10) >= 30) {
        await tryAward(pool, userId, 'voter_streak_30');
      }
    }
  } catch (err) {
    log.warn('badges', 'checkAndAwardBadges failed', { userId, trigger, err: err.message });
  }
}

module.exports = { BADGE_DEFS, BADGE_RANK_SQL, checkAndAwardBadges };
