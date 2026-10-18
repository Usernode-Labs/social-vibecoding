'use strict';

// The Empty starter: the Press! example every new Homeroom app shipped before
// templates were offered. Its markup is public/index.html; its two routes and
// its one table live here, unchanged, so a project created from scratch keeps
// exactly the demo it always got.

function attachStarter(app, pool) {
  // Button press
  app.post('/api/press', async (req, res) => {
    try {
      await pool.query(
        'INSERT INTO presses (user_id, username) VALUES ($1, $2)',
        [req.user.id, req.user.username]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Leaderboard
  app.get('/api/leaderboard', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT username, COUNT(*) as presses
        FROM presses
        GROUP BY username
        ORDER BY presses DESC
        LIMIT 50
      `);
      res.json({ leaderboard: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

attachStarter.ensureSchema = async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
};

module.exports = attachStarter;
