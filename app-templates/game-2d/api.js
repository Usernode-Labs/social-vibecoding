// This app's API: the game's scores and its leaderboard. server.js mounts it
// after the sign-in check, so every route here has req.user
// ({ id, username }). The game itself runs in the browser (public/app.js).
//
// A score is whatever the browser reports at the end of a round, so a
// determined player could send a made-up one. That is fine for a friendly
// leaderboard; check rounds on the server if the stakes ever grow.
//
// It came from a Homeroom game template. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const MAX_SCORE = 100000;
const BOARD_SIZE = 10;

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS scores_user_id_idx ON scores (user_id)');

  // A staging preview starts with no rows, so seed two obviously fake
  // players for the leaderboard check in dapp.json. Fixed ids keep it
  // idempotent; never whoever opens the preview, and never production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO scores (id, user_id, username, score)
      VALUES (900001, 0, 'staging-demo-player', 12),
             (900002, -1, 'staging-demo-friend', 7)
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

/** Each player's best score, highest first, and the viewer's own best. */
async function leaderboard(pool, userId) {
  const { rows } = await pool.query(
    `SELECT username, MAX(score)::int AS best
       FROM scores GROUP BY user_id, username
      ORDER BY best DESC, username
      LIMIT $1`,
    [BOARD_SIZE]
  );
  const mine = await pool.query('SELECT MAX(score)::int AS best FROM scores WHERE user_id = $1', [userId]);
  return { leaderboard: rows, best: mine.rows[0].best };
}

function routes(app, pool) {
  app.get('/api/leaderboard', async (req, res) => {
    try {
      res.json(await leaderboard(pool, req.user.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/scores', async (req, res) => {
    const score = req.body && req.body.score;
    if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ error: `A score is a whole number from 0 to ${MAX_SCORE}.` });
    }
    try {
      await pool.query(
        'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
        [req.user.id, req.user.username, score]
      );
      res.status(201).json(await leaderboard(pool, req.user.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { migrate, routes, MAX_SCORE };
