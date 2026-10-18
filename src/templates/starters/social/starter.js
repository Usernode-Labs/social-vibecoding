'use strict';

// The Social productivity starter: a shared goals board. Anyone signed in can
// add a goal, cheer one on, and mark their own goal done. Every read hides a
// goal that three different people reported; an owner can reopen a done goal.
// The page is public/index.html; nothing here counts as gameplay.

const MAX_TITLE = 120;
const MAX_NOTE = 140;
const HIDE_AFTER_REPORTS = 3;

function cleanTitle(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function attachStarter(app, pool) {
  // Every goal, with its cheer count and whether this viewer cheered it.
  app.get('/api/goals', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT g.id, g.user_id, g.username, g.title, g.note, g.status,
               g.created_at,
               (SELECT COUNT(*)::int FROM goal_cheers c WHERE c.goal_id = g.id) AS cheers,
               EXISTS (SELECT 1 FROM goal_cheers c WHERE c.goal_id = g.id AND c.user_id = $1) AS cheered
        FROM goals g
        WHERE g.hidden = FALSE
        ORDER BY g.created_at DESC
        LIMIT 200
      `, [req.user.id]);
      res.json({ goals: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/goals', async (req, res) => {
    const title = cleanTitle(req.body && req.body.title);
    const note = cleanTitle(req.body && req.body.note).slice(0, MAX_NOTE);
    if (!title) return res.status(400).json({ error: 'Give the goal a title.' });
    if (title.length > MAX_TITLE) {
      return res.status(400).json({ error: `Keep the title to ${MAX_TITLE} characters.` });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO goals (user_id, username, title, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, username, title, note, status, created_at`,
        [req.user.id, req.user.username, title, note || null]
      );
      res.status(201).json({ goal: { ...rows[0], cheers: 0, cheered: false } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cheer toggles: a second press takes the cheer back.
  app.post('/api/goals/:id/cheer', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown goal.' });
    try {
      const found = await pool.query(
        'SELECT id FROM goals WHERE id = $1 AND hidden = FALSE', [id]);
      if (!found.rows.length) return res.status(404).json({ error: 'That goal is not here any more.' });
      const removed = await pool.query(
        'DELETE FROM goal_cheers WHERE goal_id = $1 AND user_id = $2',
        [id, req.user.id]);
      let cheered = false;
      if (!removed.rowCount) {
        await pool.query(
          'INSERT INTO goal_cheers (goal_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, req.user.id]);
        cheered = true;
      }
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS cheers FROM goal_cheers WHERE goal_id = $1', [id]);
      res.json({ cheered, cheers: rows[0].cheers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Only the goal's owner moves it between In progress and Done.
  app.post('/api/goals/:id/status', async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown goal.' });
    if (status !== 'doing' && status !== 'done') {
      return res.status(400).json({ error: 'status must be "doing" or "done"' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE goals SET status = $1
          WHERE id = $2 AND user_id = $3 AND hidden = FALSE
          RETURNING id, status`,
        [status, id, req.user.id]
      );
      if (!rows.length) return res.status(403).json({ error: 'Only the person who added a goal can move it.' });
      res.json({ goal: rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A report hides the goal for the reporter, and for everyone once three
  // different people have reported it.
  app.post('/api/goals/:id/report', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown goal.' });
    try {
      const found = await pool.query(
        'SELECT id FROM goals WHERE id = $1 AND hidden = FALSE', [id]);
      if (!found.rows.length) return res.status(404).json({ error: 'That goal is not here any more.' });
      await pool.query(
        `INSERT INTO goal_reports (goal_id, user_id) VALUES ($1, $2)
         ON CONFLICT (goal_id, user_id) DO NOTHING`,
        [id, req.user.id]
      );
      await pool.query(
        `UPDATE goals SET hidden = TRUE
          WHERE id = $1
            AND (SELECT COUNT(*) FROM goal_reports WHERE goal_id = $1) >= $2`,
        [id, HIDE_AFTER_REPORTS]
      );
      const { rows } = await pool.query(
        'SELECT hidden FROM goals WHERE id = $1', [id]);
      res.json({ hidden: !!(rows[0] && rows[0].hidden), hiddenForEveryone: rows[0] ? rows[0].hidden : true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

attachStarter.ensureSchema = async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(120) NOT NULL,
      note VARCHAR(140),
      status VARCHAR(8) NOT NULL DEFAULT 'doing'
        CHECK (status IN ('doing', 'done')),
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS goal_cheers (
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (goal_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS goal_reports (
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (goal_id, user_id)
    );
  `);
};

module.exports = attachStarter;
