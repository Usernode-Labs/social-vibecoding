'use strict';

/**
 * Shared lists: anyone here starts a list, anyone adds tasks, "I'll do it"
 * claims one, and ticking it off records who did it.
 *
 * The platform's server.js verifies the viewer before mounting this router,
 * so `req.user` is always the signed-in person here.
 */

const express = require('express');

let pool = null;
const router = express.Router();

function nameOf(user) {
  return (user && (user.username || user.name)) || 'someone';
}

async function migrate(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_username TEXT NOT NULL,
      claimed_by INTEGER,
      claimed_by_username TEXT,
      done_by INTEGER,
      done_by_username TEXT,
      done_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS tasks_list_idx ON tasks(list_id);
  `);
}

/** A few obviously fake rows so a staging preview is not blank. */
async function seed(db) {
  await db.query(`
    INSERT INTO lists (id, title, created_by, created_by_username) VALUES
      (900001, 'Weekend chores', 900001, 'ada'),
      (900002, 'Trip packing', 900002, 'grace')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO tasks (id, list_id, title, created_by, created_by_username, claimed_by, claimed_by_username, done_by, done_by_username, done_at) VALUES
      (900001, 900001, 'Water the plants', 900001, 'ada', NULL, NULL, 900001, 'ada', NOW()),
      (900002, 900001, 'Pick up groceries', 900001, 'ada', 900002, 'grace', NULL, NULL, NULL),
      (900003, 900001, 'Book the community room', 900001, 'ada', NULL, NULL, NULL, NULL, NULL),
      (900004, 900002, 'Pack a raincoat', 900002, 'grace', NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT (id) DO NOTHING;
  `);
  await db.query(`SELECT setval(pg_get_serial_sequence('lists', 'id'), GREATEST((SELECT MAX(id) FROM lists), 900002));`);
  await db.query(`SELECT setval(pg_get_serial_sequence('tasks', 'id'), GREATEST((SELECT MAX(id) FROM tasks), 900004));`);
}

async function board() {
  const { rows } = await pool.query(`
    SELECT l.id, l.title,
           l.created_by AS "createdBy", l.created_by_username AS "createdByUsername",
           COALESCE(json_agg(json_build_object(
             'id', t.id,
             'title', t.title,
             'createdBy', t.created_by,
             'createdByUsername', t.created_by_username,
             'claimedBy', t.claimed_by,
             'claimedByUsername', t.claimed_by_username,
             'doneBy', t.done_by,
             'doneByUsername', t.done_by_username,
             'done', t.done_at IS NOT NULL
           ) ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS tasks
      FROM lists l
      LEFT JOIN tasks t ON t.list_id = l.id
     GROUP BY l.id
     ORDER BY l.created_at DESC, l.id DESC
  `);
  return rows;
}

router.get('/api/state', async (_req, res) => {
  try {
    res.json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/lists', async (req, res) => {
  const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return res.status(400).json({ error: 'Give the list a name.' });
  if (title.length > 120) return res.status(400).json({ error: 'Keep the list name under 120 characters.' });
  try {
    await pool.query(
      'INSERT INTO lists (title, created_by, created_by_username) VALUES ($1, $2, $3)',
      [title, req.user.id, nameOf(req.user)],
    );
    res.status(201).json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/lists/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM lists WHERE id = $1 AND created_by = $2',
      [Number(req.params.id), req.user.id],
    );
    if (!rowCount) return res.status(403).json({ error: 'Only the person who started this list can remove it.' });
    res.json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/lists/:id/tasks', async (req, res) => {
  const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return res.status(400).json({ error: 'Give the task a name.' });
  if (title.length > 160) return res.status(400).json({ error: 'Keep the task under 160 characters.' });
  try {
    const { rows } = await pool.query('SELECT id FROM lists WHERE id = $1', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'That list is gone.' });
    await pool.query(
      'INSERT INTO tasks (list_id, title, created_by, created_by_username) VALUES ($1, $2, $3, $4)',
      [rows[0].id, title, req.user.id, nameOf(req.user)],
    );
    res.status(201).json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/claim', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tasks
          SET claimed_by = $2, claimed_by_username = $3
        WHERE id = $1 AND done_at IS NULL AND (claimed_by IS NULL OR claimed_by = $2)
        RETURNING id`,
      [Number(req.params.id), req.user.id, nameOf(req.user)],
    );
    if (!rows.length) return res.status(409).json({ error: 'Someone else is already on it.' });
    res.json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/done', async (req, res) => {
  const done = req.body?.done !== false;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks
          SET done_by = CASE WHEN $2::boolean THEN $3::integer ELSE NULL END,
              done_by_username = CASE WHEN $2::boolean THEN $4::text ELSE NULL END,
              done_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
        WHERE id = $1
        RETURNING id`,
      [Number(req.params.id), done, req.user.id, nameOf(req.user)],
    );
    if (!rows.length) return res.status(404).json({ error: 'That task is gone.' });
    res.json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tasks t
        USING lists l
        WHERE t.id = $1 AND t.list_id = l.id
          AND (t.created_by = $2 OR l.created_by = $2)`,
      [Number(req.params.id), req.user.id],
    );
    if (!rowCount) return res.status(403).json({ error: 'Only the list’s starter or the task’s author can remove it.' });
    res.json({ lists: await board() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function mount(app, db) {
  pool = db;
  app.use(router);
}

module.exports = { mount, migrate, seed };
