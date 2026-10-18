// The photo feed this app starts with, as two fragments server.js splices in.
//
// This file is NOT a runnable module: it is template source read by the
// platform (src/services/template.js), which splits it on the marker lines
// below and pastes the pieces into the scaffolded server.js it generates:
// everything after @@HOMEROOM-ROUTES@@ goes where the example's routes
// belong (before the static middleware), everything after
// @@HOMEROOM-BOOTSTRAP@@ goes inside start(), before the server listens.
// The photo feed is placeholder content: the group's first real change
// replaces it. Keep the platform plumbing around it (auth, /health, the
// asset proxy) unchanged.
//
// The pictures themselves never touch this server: the screen uploads them
// through the bridge's usernode.uploadFile() (see public/index.html), which
// stores the file on the platform's own file storage and hands back a URL.
// This example persists that URL and the caption in its own table.

// @@HOMEROOM-ROUTES@@
// The feed, newest first. Reported posts are hidden from the feed at once.
app.get('/api/posts', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, username, caption, file_url, file_id, created_at
       FROM posts WHERE reported = FALSE
       ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a picture with a one-line caption. file_url is the bridge's stored
// URL; file_id is its stored-file id, kept so the poster (or a future
// cleanup) can delete the file itself.
app.post('/api/posts', async (req, res) => {
  try {
    const caption = String(req.body?.caption || '').trim().slice(0, 280);
    const fileUrl = String(req.body?.fileUrl || '');
    const fileId = req.body?.fileId ? String(req.body.fileId) : null;
    if (!fileUrl) return res.status(400).json({ error: 'A post needs a picture' });
    const { rows } = await pool.query(
      `INSERT INTO posts (user_id, username, caption, file_url, file_id) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, username, caption, file_url, file_id, created_at`,
      [req.user.id, req.user.username, caption, fileUrl, fileId]
    );
    res.json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Report a post. It disappears from the feed immediately; the platform's
// moderation can then take the file down properly.
app.post('/api/posts/:id/report', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE posts SET reported = TRUE WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such post' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// @@HOMEROOM-BOOTSTRAP@@
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      caption VARCHAR(280) NOT NULL DEFAULT '',
      file_url TEXT NOT NULL,
      file_id TEXT,
      reported BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);