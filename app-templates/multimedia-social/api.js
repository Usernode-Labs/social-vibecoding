'use strict';

/**
 * A feed of posts. Anyone writes a caption and may add a photo, each person
 * can like a post once, and any post can be reported. A post reported by
 * three different people is hidden from every read. Authors delete their
 * own posts. Photos are stored by the platform; this app remembers only the
 * returned address and file id.
 */

const express = require('express');

let pool = null;
const router = express.Router();

const HIDDEN_AT = 3;

function nameOf(user) {
  return (user && (user.username || user.name)) || 'someone';
}

async function migrate(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      caption TEXT,
      photo_url TEXT,
      photo_id TEXT,
      author_id INTEGER NOT NULL,
      author_username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS post_reports (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC);
  `);
  // A staging clone never carries reports; the platform reads this tag.
  await db.query(`COMMENT ON TABLE post_reports IS 'staging:private';`);
}

/** Obviously fake rows so a staging preview is not blank. */
async function seed(db) {
  await db.query(`
    INSERT INTO posts (id, caption, author_id, author_username) VALUES
      (900001, 'The community garden is open on Saturday morning. Bring gloves.', 900001, 'ada'),
      (900002, 'Found this view on the way home.', 900002, 'grace'),
      (900003, 'Any recommendations for a good book this month?', 900003, 'lin')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO post_likes (post_id, user_id) VALUES
      (900001, 900002), (900001, 900003), (900002, 900001)
    ON CONFLICT DO NOTHING;
  `);
  await db.query(`SELECT setval(pg_get_serial_sequence('posts', 'id'), GREATEST((SELECT MAX(id) FROM posts), 900003));`);
}

async function feed(viewerId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.caption, p.photo_url AS "photoUrl", p.author_id AS "authorId",
            p.author_username AS "author", p.created_at AS "createdAt",
            (SELECT COUNT(*)::int FROM post_likes l WHERE l.post_id = p.id) AS likes,
            EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS "likedByMe",
            (SELECT COUNT(*)::int FROM post_reports r WHERE r.post_id = p.id) AS reports
       FROM posts p
      WHERE (SELECT COUNT(*) FROM post_reports r WHERE r.post_id = p.id) < $2
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 100`,
    [viewerId, HIDDEN_AT],
  );
  return rows;
}

router.get('/api/posts', async (req, res) => {
  try {
    res.json({ posts: await feed(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/posts', async (req, res) => {
  const caption = String(req.body?.caption || '').replace(/\s+/g, ' ').trim();
  const photoUrl = String(req.body?.photoUrl || '').trim();
  const photoId = String(req.body?.photoId || '').trim();
  if (!caption && !photoUrl) return res.status(400).json({ error: 'Write a caption or add a photo.' });
  if (caption.length > 500) return res.status(400).json({ error: 'Keep the caption under 500 characters.' });
  // Only a platform-stored address is accepted, and this app keeps only the
  // address and the id: never image bytes, never another origin's URL.
  if (photoUrl && !/^https?:\/\/[^\s]+\/app-files\/[a-f0-9]+$/.test(photoUrl)) {
    return res.status(400).json({ error: 'That photo was not stored by Homeroom.' });
  }
  try {
    await pool.query(
      `INSERT INTO posts (caption, photo_url, photo_id, author_id, author_username)
       VALUES ($1, $2, $3, $4, $5)`,
      [caption || null, photoUrl || null, photoId || null, req.user.id, nameOf(req.user)],
    );
    res.status(201).json({ posts: await feed(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/posts/:id/like', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [Number(req.params.id), req.user.id],
    );
    res.json({ posts: await feed(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/posts/:id/report', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO post_reports (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [Number(req.params.id), req.user.id],
    );
    res.json({ posts: await feed(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/posts/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND author_id = $2',
      [Number(req.params.id), req.user.id],
    );
    if (!rowCount) return res.status(403).json({ error: 'Only the author can delete this post.' });
    res.json({ posts: await feed(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function mount(app, db) {
  pool = db;
  app.use(router);
}

module.exports = { mount, migrate, seed, HIDDEN_AT };
