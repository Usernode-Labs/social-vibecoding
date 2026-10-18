'use strict';

// The Multimedia social starter: a photo wall. Members upload a photo through
// Homeroom's file storage (the bridge), add a short caption, and report a
// photo they should not see. Three different reporters hide it for everyone.
// Only images are accepted: Homeroom's storage holds no video.

const MAX_CAPTION = 140;
const HIDE_AFTER_REPORTS = 3;
// Homeroom's file URLs end in /app-files/<32 hex characters>; the id in the
// path is the only kind of URL this starter stores.
const FILE_PATH_RE = /^\/app-files\/([0-9a-f]{32})$/;

function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

/** The stored file id when `url` really is a Homeroom file URL, else null. */
function fileIdOf(url, claimedId) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const match = parsed.pathname.match(FILE_PATH_RE);
  if (!match) return null;
  // The id in the path and the id the page says it uploaded must be the same
  // file; a bare URL alone is not enough to claim one.
  if (typeof claimedId !== 'string' || claimedId !== match[1]) return null;
  return match[1];
}

function attachStarter(app, pool) {
  app.get('/api/photos', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, user_id, username, url, file_id, caption, created_at
        FROM photos
        WHERE hidden = FALSE
        ORDER BY created_at DESC
        LIMIT 200
      `);
      res.json({ photos: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/photos', async (req, res) => {
    const body = req.body || {};
    const fileId = fileIdOf(body.url, body.fileId);
    if (!fileId) {
      return res.status(400).json({ error: 'Photos must be uploaded through Homeroom.' });
    }
    const caption = cleanText(body.caption);
    if (caption.length > MAX_CAPTION) {
      return res.status(400).json({ error: `Keep the caption to ${MAX_CAPTION} characters.` });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO photos (user_id, username, url, file_id, caption)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, username, url, file_id, caption, created_at`,
        [req.user.id, req.user.username, String(body.url), fileId, caption || null]
      );
      res.status(201).json({ photo: rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/photos/:id/report', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown photo.' });
    try {
      const found = await pool.query(
        'SELECT id FROM photos WHERE id = $1 AND hidden = FALSE', [id]);
      if (!found.rows.length) return res.status(404).json({ error: 'That photo is not here any more.' });
      await pool.query(
        `INSERT INTO photo_reports (photo_id, user_id) VALUES ($1, $2)
         ON CONFLICT (photo_id, user_id) DO NOTHING`,
        [id, req.user.id]
      );
      await pool.query(
        `UPDATE photos SET hidden = TRUE
          WHERE id = $1
            AND (SELECT COUNT(*) FROM photo_reports WHERE photo_id = $1) >= $2`,
        [id, HIDE_AFTER_REPORTS]
      );
      const { rows } = await pool.query('SELECT hidden FROM photos WHERE id = $1', [id]);
      res.json({ hiddenForEveryone: rows[0] ? rows[0].hidden : true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

attachStarter.ensureSchema = async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      file_id VARCHAR(32) NOT NULL,
      caption VARCHAR(140),
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS photo_reports (
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (photo_id, user_id)
    );
  `);
};

attachStarter.fileIdOf = fileIdOf;

module.exports = attachStarter;
