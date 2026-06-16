const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Shorten a wallet pubkey to first-6 … last-4, safe for display.
function walletShort(pubkey) {
  if (!pubkey || pubkey.length < 10) return pubkey || '';
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
}

function blockBlastRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // POST /api/block-blast/scores
  // Save or update the authenticated user's personal-best score.
  // Server reads wallet_pubkey from the DB — not from the client — so
  // a client cannot submit under a spoofed address.
  router.post('/api/block-blast/scores', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const score = parseInt(req.body?.score, 10);
    if (!Number.isInteger(score) || score < 0) {
      return res.status(400).json({ error: 'Invalid score' });
    }

    try {
      const { rows: userRows } = await pool.query(
        'SELECT usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      const walletPubkey = userRows[0]?.usernode_pubkey || null;
      if (!walletPubkey) {
        return res.status(403).json({ error: 'Wallet not linked' });
      }

      // Upsert keeping only the higher score.
      const { rows } = await pool.query(
        `INSERT INTO block_blast_scores (user_id, wallet_pubkey, score, achieved_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET wallet_pubkey = EXCLUDED.wallet_pubkey,
               score = GREATEST(block_blast_scores.score, EXCLUDED.score),
               achieved_at = CASE
                 WHEN EXCLUDED.score > block_blast_scores.score THEN NOW()
                 ELSE block_blast_scores.achieved_at
               END
         RETURNING score AS personal_best`,
        [req.user.id, walletPubkey, score]
      );

      res.json({ ok: true, personalBest: rows[0].personal_best });
    } catch (err) {
      log.error('block-blast', 'score submit failed', { err: err.message });
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/block-blast/leaderboard
  // Top 20 all-time scores. Listed in PUBLIC_PATHS in auth middleware so it
  // is accessible without a session (e.g. for future embedding).
  router.get('/api/block-blast/leaderboard', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.score, u.username, u.usernode_pubkey
           FROM block_blast_scores b
           JOIN users u ON u.id = b.user_id
          ORDER BY b.score DESC
          LIMIT 20`
      );

      const result = rows.map((r, i) => ({
        rank: i + 1,
        username: r.username,
        score: r.score,
        walletShort: walletShort(r.usernode_pubkey),
      }));

      res.json({ rows: result });
    } catch (err) {
      log.error('block-blast', 'leaderboard fetch failed', { err: err.message });
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { blockBlastRoutes, walletShort };
