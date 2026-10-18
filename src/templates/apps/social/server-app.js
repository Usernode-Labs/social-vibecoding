// The shared task board this app starts with, as two fragments server.js
// splices in.
//
// This file is NOT a runnable module: it is template source read by the
// platform (src/services/template.js), which splits it on the marker lines
// below and pastes the pieces into the scaffolded server.js it generates:
// everything after @@HOMEROOM-ROUTES@@ goes where the example's routes
// belong (before the static middleware), everything after
// @@HOMEROOM-BOOTSTRAP@@ goes inside start(), before the server listens.
// The task board is placeholder content: the group's first real change
// replaces it. Keep the platform plumbing around it (auth, /health, the
// asset proxy) unchanged.

// @@HOMEROOM-ROUTES@@
// List the board, oldest first, so it reads in the order it was filled.
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, title, done, created_at FROM tasks ORDER BY created_at ASC'
    );
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a task. req.user is set by the auth middleware above: every /api
// route in this scaffold is for a signed-in user.
app.post('/api/tasks', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 280);
    if (!title) return res.status(400).json({ error: 'A task needs a title' });
    const { rows } = await pool.query(
      `INSERT INTO tasks (user_id, username, title) VALUES ($1, $2, $3)
       RETURNING id, user_id, username, title, done, created_at`,
      [req.user.id, req.user.username, title]
    );
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tick a task done, or back open.
app.post('/api/tasks/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET done = NOT done WHERE id = $1
       RETURNING id, user_id, username, title, done, created_at`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such task' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// @@HOMEROOM-BOOTSTRAP@@
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(280) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);