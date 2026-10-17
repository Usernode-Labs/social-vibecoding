'use strict';

/**
 * The leaderboard behind Star catch. One row per finished round, and each
 * player's best read from that history. Scores are whatever the browser
 * reports: this is a friendly board, not a contest with stakes.
 */

const express = require('express');

let pool = null;
const router = express.Router();
const MAX_SCORE = 100000;

function nameOf(user) {
  return (user && (user.username || user.name)) || 'someone';
}

async function migrate(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS scores_best_idx ON scores(user_id, score DESC);
  `);
}

async function seed(db) {
  await db.query(`
    INSERT INTO scores (id, user_id, username, score) VALUES
      (900001, 900001, 'ada', 18),
      (900002, 900002, 'grace', 12),
      (900003, 900003, 'lin', 9)
    ON CONFLICT (id) DO NOTHING;
  `);
  await db.query(`SELECT setval(pg_get_serial_sequence('scores', 'id'), GREATEST((SELECT MAX(id) FROM scores), 900003));`);
}

async function board(viewerId) {
  const { rows } = await pool.query(
    `SELECT username, MAX(score)::int AS best
       FROM scores
      GROUP BY user_id, username
      ORDER BY best DESC, username ASC
      LIMIT 10`,
  );
  const { rows: mine } = await pool.query(
    'SELECT COALESCE(MAX(score), 0)::int AS best FROM scores WHERE user_id = $1',
    [viewerId],
  );
  return { scores: rows, yourBest: mine[0]?.best || 0 };
}

router.get('/api/scores', async (req, res) => {
  try {
    res.json(await board(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/scores', async (req, res) => {
  const score = Math.round(Number(req.body?.score));
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
    return res.status(400).json({ error: 'That is not a score.' });
  }
  try {
    await pool.query(
      'INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)',
      [req.user.id, nameOf(req.user), score],
    );
    res.status(201).json(await board(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function mount(app, db) {
  pool = db;
  app.use(router);
}

module.exports = { mount, migrate, seed };
