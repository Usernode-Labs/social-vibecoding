const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { storePurchaseLimiter, storePromoValidateLimiter } = require('../middleware/rate-limits');
const { checkAndAwardAchievements } = require('../services/store-achievements');

function storeRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);

  // ── Browse ──────────────────────────────────────────────────────────────
  router.get('/api/store/games', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, name, description, genre, price_unt, cover_color, active
           FROM store_games WHERE active = TRUE ORDER BY name`
      );
      res.json({ games: rows });
    } catch (err) {
      log.error('store', 'Failed to list games', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Library ─────────────────────────────────────────────────────────────
  router.get('/api/store/library', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows: balRows } = await pool.query(
        `SELECT balance FROM unt_balances WHERE user_id = $1`, [req.user.id]
      );
      const balance = balRows[0]?.balance ?? 0;

      const { rows: purchases } = await pool.query(
        `SELECT gp.id, gp.game_id, gp.price_paid, gp.purchased_at, gp.last_played_at,
                sg.slug, sg.name, sg.description, sg.genre, sg.price_unt, sg.cover_color
           FROM game_purchases gp
           JOIN store_games sg ON sg.id = gp.game_id
          WHERE gp.user_id = $1
          ORDER BY gp.purchased_at DESC`,
        [req.user.id]
      );
      res.json({ balance, library: purchases });
    } catch (err) {
      log.error('store', 'Failed to load library', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Achievements ─────────────────────────────────────────────────────────
  router.get('/api/store/achievements', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows: catalog } = await pool.query(
        `SELECT sa.id, sa.slug, sa.name, sa.description, sa.icon,
                sua.earned_at
           FROM store_achievements sa
           LEFT JOIN store_user_achievements sua
             ON sua.achievement_id = sa.id AND sua.user_id = $1
          ORDER BY sa.id`,
        [req.user.id]
      );
      res.json({ achievements: catalog });
    } catch (err) {
      log.error('store', 'Failed to load achievements', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Validate promo code ──────────────────────────────────────────────────
  router.get('/api/store/promo/validate', storePromoValidateLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const code = (req.query.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Missing code' });
    try {
      const { rows } = await pool.query(
        `SELECT id, code, discount_pct, max_uses, used_count, active, expires_at
           FROM store_promo_codes
          WHERE code = $1 AND active = TRUE
            AND (expires_at IS NULL OR expires_at > NOW())
            AND (max_uses IS NULL OR used_count < max_uses)`,
        [code]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Invalid or expired promo code' });
      res.json({ promo: { id: rows[0].id, code: rows[0].code, discount_pct: rows[0].discount_pct } });
    } catch (err) {
      log.error('store', 'Promo validate failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Purchase ─────────────────────────────────────────────────────────────
  router.post('/api/store/purchase', storePurchaseLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { game_id, promo_code } = req.body;
    if (!game_id) return res.status(400).json({ error: 'Missing game_id' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch game
      const { rows: gameRows } = await client.query(
        `SELECT id, name, price_unt, active FROM store_games WHERE id = $1`, [game_id]
      );
      if (!gameRows[0] || !gameRows[0].active) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Game not found' });
      }
      const game = gameRows[0];

      // Check not already owned
      const { rows: owned } = await client.query(
        `SELECT id FROM game_purchases WHERE user_id = $1 AND game_id = $2`,
        [req.user.id, game_id]
      );
      if (owned.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already owned' });
      }

      // Wallet gate — must have linked usernode_pubkey
      const { rows: userRows } = await client.query(
        `SELECT usernode_pubkey FROM users WHERE id = $1`, [req.user.id]
      );
      if (!userRows[0]?.usernode_pubkey) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Wallet required to make purchases' });
      }

      // Resolve promo code inside the transaction
      let promoId = null;
      let discountPct = 0;
      if (promo_code) {
        const trimmedCode = promo_code.trim().toUpperCase();
        const { rows: promoRows } = await client.query(
          `SELECT id, discount_pct, max_uses, used_count, active, expires_at
             FROM store_promo_codes
            WHERE code = $1 AND active = TRUE
              AND (expires_at IS NULL OR expires_at > NOW())
              AND (max_uses IS NULL OR used_count < max_uses)
            FOR UPDATE`,
          [trimmedCode]
        );
        if (!promoRows[0]) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Invalid or expired promo code' });
        }
        promoId = promoRows[0].id;
        discountPct = promoRows[0].discount_pct;
      }

      // Calculate final price
      const finalPrice = Math.max(0, Math.round(game.price_unt * (1 - discountPct / 100)));

      // Check balance
      const { rows: balRows } = await client.query(
        `SELECT balance FROM unt_balances WHERE user_id = $1 FOR UPDATE`, [req.user.id]
      );
      const balance = balRows[0]?.balance ?? 0;
      if (balance < finalPrice) {
        await client.query('ROLLBACK');
        return res.status(402).json({ error: 'Insufficient UNT balance' });
      }

      // Deduct balance
      await client.query(
        `UPDATE unt_balances SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2`,
        [finalPrice, req.user.id]
      );

      // Record purchase
      const { rows: purchaseRows } = await client.query(
        `INSERT INTO game_purchases (user_id, game_id, price_paid)
         VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, game_id, finalPrice]
      );
      const purchaseId = purchaseRows[0].id;

      // Apply promo redemption
      if (promoId) {
        await client.query(
          `INSERT INTO store_promo_redemptions (promo_id, user_id, purchase_id)
           VALUES ($1, $2, $3)`,
          [promoId, req.user.id, purchaseId]
        );
        await client.query(
          `UPDATE store_promo_codes SET used_count = used_count + 1 WHERE id = $1`,
          [promoId]
        );
      }

      // Audit log
      await client.query(
        `INSERT INTO store_audit_log (user_id, action, details)
         VALUES ($1, 'purchase', $2)`,
        [req.user.id, JSON.stringify({ game_id, game_name: game.name, price_paid: finalPrice, promo_id: promoId })]
      );

      await client.query('COMMIT');

      // Check achievements (non-blocking, after commit)
      const newAchievements = await checkAndAwardAchievements(pool, req.user.id).catch(() => []);

      const { rows: newBalRows } = await pool.query(
        `SELECT balance FROM unt_balances WHERE user_id = $1`, [req.user.id]
      );

      res.json({
        ok: true,
        purchase_id: purchaseId,
        price_paid: finalPrice,
        new_balance: newBalRows[0]?.balance ?? 0,
        new_achievements: newAchievements,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('store', 'Purchase failed', { userId: req.user.id, game_id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // ── Top-up balance ───────────────────────────────────────────────────────
  router.post('/api/store/topup', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { user_id, amount } = req.body;
    if (!user_id || !amount || amount <= 0) return res.status(400).json({ error: 'Missing user_id or amount' });
    try {
      await pool.query(
        `INSERT INTO unt_balances (user_id, balance, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET balance = unt_balances.balance + $2, updated_at = NOW()`,
        [user_id, amount]
      );
      await pool.query(
        `INSERT INTO store_audit_log (user_id, action, details)
         VALUES ($1, 'topup', $2)`,
        [user_id, JSON.stringify({ amount, by: req.user.id })]
      );
      const { rows } = await pool.query(
        `SELECT balance FROM unt_balances WHERE user_id = $1`, [user_id]
      );
      res.json({ ok: true, new_balance: rows[0]?.balance ?? 0 });
    } catch (err) {
      log.error('store', 'Top-up failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Record a play session ─────────────────────────────────────────────────
  router.post('/api/store/games/:id/play', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const gameId = parseInt(req.params.id);
    if (!gameId) return res.status(400).json({ error: 'Invalid game id' });
    try {
      // Verify ownership
      const { rows } = await pool.query(
        `SELECT id FROM game_purchases WHERE user_id = $1 AND game_id = $2`,
        [req.user.id, gameId]
      );
      if (!rows.length) return res.status(403).json({ error: 'Game not owned' });

      await pool.query(
        `UPDATE game_purchases SET last_played_at = NOW()
          WHERE user_id = $1 AND game_id = $2`,
        [req.user.id, gameId]
      );
      await pool.query(
        `INSERT INTO game_downloads (user_id, game_id, action) VALUES ($1, $2, 'play')`,
        [req.user.id, gameId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('store', 'Play record failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { storeRoutes };
