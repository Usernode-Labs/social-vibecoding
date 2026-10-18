// The ball-and-orbs collection game this app starts with, as two fragments
// server.js splices in.
//
// This file is NOT a runnable module: it is template source read by the
// platform (src/services/template.js), which splits it on the marker lines
// below and pastes the pieces into the scaffolded server.js it generates:
// everything after @@HOMEROOM-ROUTES@@ goes where the example's routes
// belong (before the static middleware), everything after
// @@HOMEROOM-BOOTSTRAP@@ goes inside start(), before the server listens.
// The game and its scoreboard are placeholder content: the group's first
// real change replaces them. Keep the platform plumbing around them (auth,
// /health, the asset proxy) unchanged.

// @@HOMEROOM-ROUTES@@
// The shared scoreboard: the best times, quickest first. A score here is
// the run's elapsed time in milliseconds.
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, score, created_at FROM scores ORDER BY score ASC, created_at ASC LIMIT 10'
    );
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a finished run. The time is clamped server-side and only ever tied
// to the signed-in user, like every route in this scaffold.
app.post('/api/scores', async (req, res) => {
  try {
    const score = Math.max(0, Math.min(3600000, Math.round(Number(req.body?.score) || 0)));
    const { rows } = await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3) RETURNING id, username, score, created_at',
      [req.user.id, req.user.username, score]
    );
    res.json({ score: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// @@HOMEROOM-BOOTSTRAP@@
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);