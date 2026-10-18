// The example this app starts with, as two fragments server.js splices in.
//
// This file is NOT a runnable module: it is template source read by the
// platform (src/services/template.js), which splits it on the marker lines
// below and pastes the pieces into the scaffolded server.js it generates —
// everything after @@HOMEROOM-ROUTES@@ goes where the example's routes
// belong (before the static middleware), everything after
// @@HOMEROOM-BOOTSTRAP@@ goes inside start(), before the server listens.
// The example's tables and routes are placeholder content: the group's
// first real change replaces them. Keep the platform plumbing around them
// (auth, /health, the asset proxy) unchanged.

// @@HOMEROOM-ROUTES@@
// Button press
app.post('/api/press', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO presses (user_id, username) VALUES ($1, $2)
    `, [req.user.id, req.user.username]);
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

// @@HOMEROOM-BOOTSTRAP@@
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
