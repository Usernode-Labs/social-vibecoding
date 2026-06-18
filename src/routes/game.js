// REST surface for the multiplayer obstacle-race feature.
//
// Create / join / read a room, list recent results, and serve the arena
// definitions. Live race traffic runs over the WebSocket channel
// (/ws/game/:code, handled by src/services/game.js via src/services/ws.js);
// these endpoints are only for lobby setup and the recent-races list.
//
// All routes assume `req.user` from the platform auth middleware (cookie
// session, or staging iframe-JWT). Nothing here is public.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const game = require('../services/game');
const arenas = require('../services/game-arenas');

function gameRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  // Make sure the engine can persist results (idempotent if already set).
  game.init(pool);

  // Arena definitions — single source of truth shared with the client.
  // Read-only and static; safe to serve to any authenticated user.
  router.get('/api/game/arenas', (req, res) => {
    res.json({ arenas: arenas.ARENAS, defaultArenaId: arenas.DEFAULT_ARENA_ID });
  });

  // Create a room — caller becomes host.
  router.post('/api/game/rooms', async (req, res) => {
    try {
      const { code, arenaId } = await game.createRoom(req.user);
      res.status(201).json({ code, arenaId, hostUserId: req.user.id });
    } catch (err) {
      log.error('game', 'create room failed', { err: err.message });
      res.status(500).json({ error: 'Could not create a race room. Try again.' });
    }
  });

  // Read a room's lobby snapshot (waiting-room render before the WS opens).
  router.get('/api/game/rooms/:code', (req, res) => {
    const snapshot = game.getRoomSnapshot(req.params.code);
    if (!snapshot) {
      return res.status(404).json({ error: 'That race has already ended or never existed.' });
    }
    res.json({ room: snapshot });
  });

  // Join a room by code.
  router.post('/api/game/rooms/:code/join', async (req, res) => {
    const check = game.canJoin(req.params.code, req.user);
    if (!check.ok) {
      return res.status(check.status).json({ error: check.error });
    }
    try {
      await game.recordJoin(req.params.code, req.user);
    } catch (err) {
      log.warn('game', 'record join failed', { err: err.message });
    }
    res.json({ room: game.getRoomSnapshot(req.params.code) });
  });

  // Recent completed races for the lobby's "recent races" list.
  router.get('/api/game/results', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
      const { rows } = await pool.query(
        `SELECT gr.id,
                gr.player_count,
                gr.finished_at,
                rm.code AS room_code,
                u.username AS winner_username
         FROM game_results gr
         JOIN game_rooms rm ON rm.id = gr.room_id
         LEFT JOIN users u ON u.id = gr.winner_user_id
         ORDER BY gr.finished_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json({
        results: rows.map((r) => ({
          id: r.id,
          roomCode: r.room_code,
          winner: r.winner_username,
          playerCount: r.player_count,
          finishedAt: r.finished_at,
        })),
      });
    } catch (err) {
      log.error('game', 'list results failed', { err: err.message });
      res.status(500).json({ error: 'Could not load recent races.' });
    }
  });

  return router;
}

module.exports = { gameRoutes };
