const log = require('./logger');

// Achievement conditions keyed by slug. Each checker receives
// { gameCount, untSpent, purchaseCount } and returns true if earned.
const CONDITIONS = {
  'first-purchase': ({ purchaseCount }) => purchaseCount >= 1,
  'three-games':    ({ purchaseCount }) => purchaseCount >= 3,
  'collector':      ({ purchaseCount }) => purchaseCount >= 5,
  'high-roller':    ({ untSpent })      => untSpent >= 50,
  'big-spender':    ({ untSpent })      => untSpent >= 100,
};

async function checkAndAwardAchievements(pool, userId) {
  try {
    // Gather stats
    const { rows: statsRows } = await pool.query(
      `SELECT
         COUNT(*)            AS purchase_count,
         COALESCE(SUM(price_paid), 0) AS unt_spent
         FROM game_purchases WHERE user_id = $1`,
      [userId]
    );
    const purchaseCount = parseInt(statsRows[0].purchase_count);
    const untSpent = parseInt(statsRows[0].unt_spent);

    // Fetch catalog + already-earned
    const { rows: catalog } = await pool.query(
      `SELECT sa.id, sa.slug FROM store_achievements sa
       WHERE NOT EXISTS (
         SELECT 1 FROM store_user_achievements
          WHERE user_id = $1 AND achievement_id = sa.id
       )`,
      [userId]
    );

    const stats = { purchaseCount, untSpent, gameCount: purchaseCount };
    const toAward = catalog.filter((a) => {
      const checker = CONDITIONS[a.slug];
      return checker && checker(stats);
    });

    if (!toAward.length) return [];

    // Bulk-insert new awards (ON CONFLICT DO NOTHING for safety)
    const values = toAward.map((a, i) => `($1, $${i + 2})`).join(', ');
    const params = [userId, ...toAward.map((a) => a.id)];
    await pool.query(
      `INSERT INTO store_user_achievements (user_id, achievement_id)
       VALUES ${values} ON CONFLICT DO NOTHING`,
      params
    );

    // Return newly awarded achievement details
    const { rows: awarded } = await pool.query(
      `SELECT sa.slug, sa.name, sa.icon, sa.description, sua.earned_at
         FROM store_user_achievements sua
         JOIN store_achievements sa ON sa.id = sua.achievement_id
        WHERE sua.user_id = $1 AND sua.achievement_id = ANY($2)`,
      [userId, toAward.map((a) => a.id)]
    );
    return awarded;
  } catch (err) {
    log.warn('store-achievements', 'checkAndAwardAchievements failed', { userId, message: err.message });
    return [];
  }
}

module.exports = { checkAndAwardAchievements };
