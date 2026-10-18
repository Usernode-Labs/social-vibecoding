'use strict';

// The 2D game starter's server: Star catch's scores and nothing else. The
// game loop runs in public/index.html; the server validates a finished score
// and lists the top ten. No hazards, no weapons, no wagering.

const MAX_SCORE = 10000;

function attachStarter(app, pool) {
  app.get('/api/scores', async (req, res) => {
    try {
      const top = await pool.query(`
        SELECT username, score
        FROM scores
        ORDER BY score DESC, created_at ASC
        LIMIT 10
      `);
      const best = await pool.query(
        'SELECT MAX(score)::int AS best FROM scores WHERE user_id = $1', [req.user.id]);
      res.json({ top: top.rows, best: best.rows[0] ? best.rows[0].best : null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/scores', async (req, res) => {
    const score = req.body && req.body.score;
    if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ error: `A score must be a whole number from 0 to ${MAX_SCORE}.` });
    }
    try {
      await pool.query(
        'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
        [req.user.id, req.user.username, score]
      );
      const best = await pool.query(
        'SELECT MAX(score)::int AS best FROM scores WHERE user_id = $1', [req.user.id]);
      res.status(201).json({ ok: true, best: best.rows[0] ? best.rows[0].best : score });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

attachStarter.ensureSchema = async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
};

module.exports = attachStarter;
