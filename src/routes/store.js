const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function storeRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // GET /api/store/games — list all games with owned flag + user's UNT balance
  router.get('/api/store/games', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows: games } = await pool.query(
        `SELECT g.*,
                EXISTS(
                  SELECT 1 FROM game_purchases p
                   WHERE p.game_id = g.id AND p.user_id = $1
                ) AS owned
           FROM store_games g
          ORDER BY g.id ASC`,
        [req.user.id]
      );
      const { rows: balRows } = await pool.query(
        'SELECT balance FROM unt_balances WHERE user_id = $1',
        [req.user.id]
      );
      const untBalance = balRows[0]?.balance ?? 0;
      res.json({ games, untBalance, isStaging: IS_STAGING });
    } catch (err) {
      log.warn('store', 'games list failed', { err: err.message });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /api/store/library — games owned by the current user
  router.get('/api/store/library', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows: games } = await pool.query(
        `SELECT g.*, p.purchased_at, p.price_paid
           FROM game_purchases p
           JOIN store_games g ON g.id = p.game_id
          WHERE p.user_id = $1
          ORDER BY p.purchased_at DESC`,
        [req.user.id]
      );
      res.json({ games });
    } catch (err) {
      log.warn('store', 'library fetch failed', { err: err.message });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /api/store/purchase — buy a game
  router.post('/api/store/purchase', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const gameId = parseInt(req.body?.gameId, 10);
    if (!gameId || isNaN(gameId)) {
      return res.status(400).json({ error: 'gameId required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: gameRows } = await client.query(
        'SELECT id, price_unt, title FROM store_games WHERE id = $1',
        [gameId]
      );
      if (!gameRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Game not found' });
      }
      const game = gameRows[0];

      const { rows: ownRows } = await client.query(
        'SELECT 1 FROM game_purchases WHERE user_id = $1 AND game_id = $2',
        [req.user.id, gameId]
      );
      if (ownRows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already owned' });
      }

      // Upsert balance row so it exists, then check funds
      await client.query(
        `INSERT INTO unt_balances (user_id, balance, updated_at)
         VALUES ($1, 0, NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [req.user.id]
      );
      const { rows: balRows } = await client.query(
        'SELECT balance FROM unt_balances WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );
      const balance = balRows[0]?.balance ?? 0;
      if (balance < game.price_unt) {
        await client.query('ROLLBACK');
        return res.status(402).json({ error: 'Insufficient balance' });
      }

      await client.query(
        `UPDATE unt_balances
            SET balance = balance - $1, updated_at = NOW()
          WHERE user_id = $2`,
        [game.price_unt, req.user.id]
      );
      const { rows: purchaseRows } = await client.query(
        `INSERT INTO game_purchases (user_id, game_id, price_paid)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [req.user.id, gameId, game.price_unt]
      );
      await client.query('COMMIT');

      const newBalance = balance - game.price_unt;
      res.json({ purchase: purchaseRows[0], untBalance: newBalance });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.warn('store', 'purchase failed', { err: err.message });
      res.status(500).json({ error: 'Internal error' });
    } finally {
      client.release();
    }
  });

  // POST /api/store/topup — staging only: add 100 UNT
  router.post('/api/store/topup', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!IS_STAGING) return res.status(403).json({ error: 'Not available' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO unt_balances (user_id, balance, updated_at)
         VALUES ($1, 100, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET balance = unt_balances.balance + 100,
               updated_at = NOW()
         RETURNING balance`,
        [req.user.id]
      );
      res.json({ untBalance: rows[0].balance });
    } catch (err) {
      log.warn('store', 'topup failed', { err: err.message });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

module.exports = { storeRoutes };
