// This app's API: a feed of posts, each a caption and an optional photo,
// with likes and a way to report a post. server.js mounts it after the
// sign-in check: a write always has req.user ({ id, username }); a read may
// come from a guest with no account (req.guest, no req.user).
//
// Photos are uploaded from the browser through Homeroom's file storage
// (usernode.uploadFile() in public/app.js). This server only ever stores the
// URL that comes back, never image bytes.
//
// It came from Homeroom's "Multimedia social" template. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const CAPTION_MAX = 500;
const URL_MAX = 500;
const PAGE_SIZE = 20;
// A post this many different people report is hidden from the feed until
// someone looks at it. Homeroom's content rules ask every app where people
// post to keep a way to report a post.
const HIDE_AT_REPORTS = 3;

// Only https URLs are accepted from people: what usernode.uploadFile()
// returns. No quotes, spaces or angle brackets, so it is safe as an
// attribute value as well as through the DOM.
const IMAGE_URL_RE = /^https:\/\/[^\s"'<>]+$/;

// The staging seed's picture: a small inline SVG, because platform-stored
// files are not copied into staging previews.
const DEMO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f97316"/></linearGradient></defs>'
  + '<rect width="400" height="300" fill="url(#g)"/>'
  + '<circle cx="200" cy="190" r="60" fill="#fff7ed"/>'
  + '<path d="M0 230 Q100 180 200 230 T400 220 V300 H0Z" fill="#65a30d"/>'
  + '</svg>'
);

function cleanCaption(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CAPTION_MAX);
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (post_id, user_id)
    )
  `);
  // Who reported what is nobody else's business: the table is copied to
  // staging previews without its rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reports (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  `);
  await pool.query(`COMMENT ON TABLE post_reports IS 'staging:private'`);

  // A staging preview starts with no rows, so seed two obviously fake posts
  // for the checks in dapp.json to find. Fixed ids keep it idempotent; the
  // author is a fake identity, never whoever opens the preview.
  if (IS_STAGING) {
    await pool.query(
      `INSERT INTO posts (id, user_id, username, caption, image_url, created_at)
       VALUES (900001, 0, 'staging-demo-user', 'Staging demo: sunrise from the hill this morning', $1, NOW() - INTERVAL '2 hours'),
              (900002, 0, 'staging-demo-user', 'Staging demo: a post with words and no photo.', NULL, NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_IMAGE]
    );
  }
}

function routes(app, pool) {
  // Newest first, PAGE_SIZE at a time; `before` is the id of the last post
  // already shown, and the page continues from just after it.
  app.get('/api/posts', async (req, res) => {
    const before = Number(req.query.before);
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.user_id, p.username, p.caption, p.image_url, p.created_at,
                (SELECT COUNT(*)::int FROM post_likes l WHERE l.post_id = p.id) AS likes,
                EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
                EXISTS (SELECT 1 FROM post_reports r WHERE r.post_id = p.id AND r.user_id = $1) AS reported
           FROM posts p
          WHERE ($2::int IS NULL OR (p.created_at, p.id) < (SELECT b.created_at, b.id FROM posts b WHERE b.id = $2))
            AND (SELECT COUNT(*) FROM post_reports r WHERE r.post_id = p.id) < $3
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $4`,
        // A guest (no account) has liked and reported nothing.
        [req.user ? req.user.id : null, Number.isInteger(before) && before > 0 ? before : null, HIDE_AT_REPORTS, PAGE_SIZE]
      );
      res.json({
        posts: rows.map((p) => ({
          id: p.id,
          by: p.username,
          mine: !!req.user && p.user_id === req.user.id,
          caption: p.caption,
          imageUrl: p.image_url,
          at: p.created_at,
          likes: p.likes,
          liked: p.liked,
          reported: p.reported,
        })),
        more: rows.length === PAGE_SIZE,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/posts', async (req, res) => {
    const caption = cleanCaption(req.body && req.body.caption);
    const rawUrl = req.body && req.body.imageUrl;
    let imageUrl = null;
    if (rawUrl != null && rawUrl !== '') {
      if (typeof rawUrl !== 'string' || rawUrl.length > URL_MAX || !IMAGE_URL_RE.test(rawUrl)) {
        return res.status(400).json({ error: 'That photo link is not one this app can show.' });
      }
      imageUrl = rawUrl;
    }
    if (!caption && !imageUrl) return res.status(400).json({ error: 'Write something or add a photo.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO posts (user_id, username, caption, image_url) VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.user.id, req.user.username, caption, imageUrl]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // One like per person: pressing it again takes it back.
  app.post('/api/posts/:id/like', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such post.' });
    try {
      const removed = await pool.query(
        'DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [id, req.user.id]);
      if (!removed.rowCount) {
        const added = await pool.query(
          `INSERT INTO post_likes (post_id, user_id) SELECT id, $2 FROM posts WHERE id = $1
           ON CONFLICT DO NOTHING`,
          [id, req.user.id]
        );
        if (!added.rowCount) return res.status(404).json({ error: 'No such post.' });
      }
      res.json({ liked: !removed.rowCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/posts/:id/report', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such post.' });
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO post_reports (post_id, user_id) SELECT id, $2 FROM posts WHERE id = $1
         ON CONFLICT DO NOTHING`,
        [id, req.user.id]
      );
      res.json({ reported: true, counted: rowCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Authors delete their own posts. The photo stays in storage; delete it
  // from the browser with usernode.deleteFile() if you also keep its id.
  app.delete('/api/posts/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'No such post.' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM posts WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!rowCount) return res.status(403).json({ error: 'Only the author can delete a post.' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { migrate, routes, HIDE_AT_REPORTS };
