const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

function profileRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);

  // ── Own profile ──────────────────────────────────────────────────────────
  router.get('/api/me/profile', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        `SELECT username, display_name, bio, avatar_color, library_public
           FROM users WHERE id = $1`,
        [req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json({ profile: rows[0] });
    } catch (err) {
      log.error('profile', 'GET /api/me/profile failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/me/profile', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { display_name, bio, avatar_color, library_public } = req.body;

    // Validate
    if (display_name !== undefined && (typeof display_name !== 'string' || display_name.length > 100)) {
      return res.status(400).json({ error: 'display_name too long (max 100)' });
    }
    if (bio !== undefined && (typeof bio !== 'string' || bio.length > 160)) {
      return res.status(400).json({ error: 'bio too long (max 160)' });
    }
    if (avatar_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(avatar_color)) {
      return res.status(400).json({ error: 'avatar_color must be a hex color' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE users SET
           display_name  = COALESCE($1, display_name),
           bio           = COALESCE($2, bio),
           avatar_color  = COALESCE($3, avatar_color),
           library_public = COALESCE($4, library_public)
         WHERE id = $5
         RETURNING username, display_name, bio, avatar_color, library_public`,
        [
          display_name !== undefined ? display_name : null,
          bio !== undefined ? bio : null,
          avatar_color !== undefined ? avatar_color : null,
          library_public !== undefined ? Boolean(library_public) : null,
          req.user.id,
        ]
      );
      res.json({ profile: rows[0] });
    } catch (err) {
      log.error('profile', 'PUT /api/me/profile failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Public user profile ──────────────────────────────────────────────────
  router.get('/api/users/:username/profile', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { username } = req.params;
    try {
      const { rows: userRows } = await pool.query(
        `SELECT id, username, display_name, bio, avatar_color, library_public
           FROM users WHERE username = $1`,
        [username]
      );
      if (!userRows[0]) return res.status(404).json({ error: 'User not found' });
      const user = userRows[0];

      // Game count (if library is public or viewing own profile)
      const isOwnProfile = req.user.id === user.id;
      let gameCount = null;
      let recentGames = [];
      if (user.library_public || isOwnProfile) {
        const { rows: gcRows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM game_purchases WHERE user_id = $1`, [user.id]
        );
        gameCount = parseInt(gcRows[0].cnt);
        const { rows: rgRows } = await pool.query(
          `SELECT sg.slug, sg.name, sg.cover_color, gp.last_played_at
             FROM game_purchases gp
             JOIN store_games sg ON sg.id = gp.game_id
            WHERE gp.user_id = $1
            ORDER BY gp.purchased_at DESC
            LIMIT 4`,
          [user.id]
        );
        recentGames = rgRows;
      }

      // Earned achievements (always public)
      const { rows: achievRows } = await pool.query(
        `SELECT sa.slug, sa.name, sa.icon, sa.description, sua.earned_at
           FROM store_user_achievements sua
           JOIN store_achievements sa ON sa.id = sua.achievement_id
          WHERE sua.user_id = $1
          ORDER BY sua.earned_at DESC`,
        [user.id]
      );

      res.json({
        profile: {
          username: user.username,
          display_name: user.display_name,
          bio: user.bio,
          avatar_color: user.avatar_color,
          library_public: user.library_public,
          game_count: gameCount,
          recent_games: recentGames,
          achievements: achievRows,
        },
      });
    } catch (err) {
      log.error('profile', 'GET /api/users/:username/profile failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { profileRoutes };
