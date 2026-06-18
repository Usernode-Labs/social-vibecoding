// Multiplayer obstacle-race — server-side room engine.
//
// Owns the in-memory authoritative state for live races, kept entirely
// separate from chat's room map in src/services/ws.js. The hot path
// (player positions, snapshots) NEVER touches Postgres — only terminal
// results (placements, winner) are persisted, so the DB stays cold while
// 20Hz traffic stays in memory.
//
// Responsibilities:
//   - room lifecycle: create / join validation / WS attach + detach
//   - a per-room 20Hz snapshot broadcaster while racing
//   - inbound message handling (pos / start / finish / rematch)
//   - SERVER-AUTHORITATIVE finish ordering (first into the finish zone
//     wins; the race then ends and everyone else is ranked by proximity)
//   - persistence of the terminal result to game_rooms / game_room_players
//     / game_results
//
// The REST layer (src/routes/game.js) calls createRoom / canJoin /
// getRoomSnapshot; the WS layer (src/services/ws.js) calls handleConnect /
// handleMessage / handleDisconnect.

const log = require('./logger');
const arenas = require('./game-arenas');

const MAX_PLAYERS = 8;
const SNAPSHOT_MS = 50; // 20Hz
const CODE_LEN = 4;
// Unambiguous charset — no O/0, I/1 so codes are easy to read aloud and
// type on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Bright, high-contrast palette assigned in join order so each racer's
// disc is distinguishable on the arena.
const COLORS = [
  '#f43f5e', // rose
  '#3b82f6', // blue
  '#22c55e', // green
  '#eab308', // yellow
  '#a855f7', // purple
  '#f97316', // orange
  '#06b6d4', // cyan
  '#ec4899', // pink
];

// code (uppercase) -> GameRoom
const rooms = new Map();

let _pool = null;

// Wire the shared pg pool once at boot (from ws.attach / server bootstrap).
// Persistence degrades to a no-op if this is never set (e.g. unit tests
// that exercise pure room logic).
function init(pool) {
  _pool = pool;
}

function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    // crypto is overkill for a lobby code; Math.random is fine here and
    // collisions are re-rolled by the caller anyway.
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Build the public lobby roster (no ws handles, no live coordinates).
function roster(room) {
  const players = [];
  let idx = 0;
  for (const p of room.players.values()) {
    players.push({
      userId: p.userId,
      username: p.username,
      color: p.color,
      isHost: p.userId === room.hostUserId,
    });
    idx++;
  }
  return players;
}

function lobbyPayload(room) {
  return {
    type: 'lobby',
    room: {
      code: room.code,
      hostUserId: room.hostUserId,
      arenaId: room.arenaId,
      status: room.status,
      maxPlayers: MAX_PLAYERS,
      players: roster(room),
    },
  };
}

function send(ws, obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (err) {
    log.warn('game', 'send failed', { err: err.message });
  }
}

function broadcast(room, obj, exceptWs = null) {
  const payload = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws && p.ws !== exceptWs && p.ws.readyState === 1) {
      try { p.ws.send(payload); } catch { /* dropped client */ }
    }
  }
}

// ---- Room creation / lookup -------------------------------------------

// Create a fresh room owned by `user`. Generates a unique code (checked
// against the in-memory map and, when a pool is available, the DB), then
// inserts the durable game_rooms row and registers the in-memory room.
// The host is NOT added as a live player here — they join over the WS like
// everyone else. Returns { code, arenaId }.
async function createRoom(user) {
  const arenaId = arenas.DEFAULT_ARENA_ID;
  let code = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = genCode();
    if (rooms.has(candidate)) continue;
    if (_pool) {
      const { rows } = await _pool.query(
        'SELECT 1 FROM game_rooms WHERE code = $1', [candidate]
      );
      if (rows.length) continue;
    }
    code = candidate;
    break;
  }
  if (!code) throw new Error('could not allocate a unique room code');

  let roomId = null;
  if (_pool) {
    const { rows } = await _pool.query(
      `INSERT INTO game_rooms (code, host_user_id, status, arena_id)
       VALUES ($1, $2, 'lobby', $3)
       RETURNING id`,
      [code, user.id, arenaId]
    );
    roomId = rows[0].id;
    // Host is recorded as a participant immediately so results/rosters
    // have their row even if they only ever sit in the lobby.
    await _pool.query(
      `INSERT INTO game_room_players (room_id, user_id, username, color)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [roomId, user.id, user.username, COLORS[0]]
    );
  }

  const room = {
    id: roomId,
    code,
    hostUserId: user.id,
    arenaId,
    status: 'lobby',
    players: new Map(),
    raceStartedAt: null,
    finished: false,
    tickHandle: null,
  };
  rooms.set(code, room);
  log.info('game', 'Room created', { code, hostUserId: user.id });
  return { code, arenaId };
}

function getRoom(code) {
  return rooms.get(normalizeCode(code)) || null;
}

// Validation used by the REST join endpoint. Returns { ok } or
// { ok:false, status, error } so the route can map straight to an HTTP
// response. A room that exists in the DB but not in memory is treated as
// gone (its process-local live state was torn down).
function canJoin(code, user) {
  const room = getRoom(code);
  if (!room) return { ok: false, status: 404, error: 'That race has already ended or never existed.' };
  if (room.status !== 'lobby') {
    return { ok: false, status: 409, error: 'That race has already started.' };
  }
  // Already in the room (e.g. re-join from another tab) is fine.
  if (room.players.has(user.id)) return { ok: true, room };
  if (room.players.size >= MAX_PLAYERS) {
    return { ok: false, status: 409, error: 'That race room is full.' };
  }
  return { ok: true, room };
}

// Persist a player row on REST join (so DB rosters/results are complete
// regardless of WS timing). Color is finalized at WS attach.
async function recordJoin(code, user) {
  const room = getRoom(code);
  if (!room || !_pool || !room.id) return;
  await _pool.query(
    `INSERT INTO game_room_players (room_id, user_id, username, color)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [room.id, user.id, user.username, COLORS[room.players.size % COLORS.length]]
  );
}

// A lightweight snapshot for the REST GET /rooms/:code (waiting-room
// render before the socket opens). null when the room is gone.
function getRoomSnapshot(code) {
  const room = getRoom(code);
  if (!room) return null;
  return {
    code: room.code,
    hostUserId: room.hostUserId,
    arenaId: room.arenaId,
    status: room.status,
    maxPlayers: MAX_PLAYERS,
    players: roster(room),
  };
}

// ---- WS lifecycle ------------------------------------------------------

function spawnPosition(arena, index) {
  // Spread spawn points across the start band so discs don't stack.
  const lanes = MAX_PLAYERS;
  const slot = (index % lanes + 0.5) / lanes;
  const x = arena.start.x + slot * arena.start.w;
  const y = arena.start.y + arena.start.h / 2;
  return { x, y };
}

// Attach an authenticated socket to a room. Called from ws.js after the
// upgrade + auth. Returns the room on success, or null after closing the
// socket when the room is gone.
function handleConnect(ws, user, code) {
  const room = getRoom(code);
  if (!room) {
    send(ws, { type: 'room_closed', reason: 'gone' });
    try { ws.close(4004, 'Room not found'); } catch { /* already closed */ }
    return null;
  }

  const arena = arenas.getArena(room.arenaId) || arenas.getDefaultArena();

  let player = room.players.get(user.id);
  if (player) {
    // Reconnect / second tab — replace the stale socket.
    if (player.ws && player.ws !== ws) {
      try { player.ws.close(4000, 'Replaced by newer connection'); } catch { /* noop */ }
    }
    player.ws = ws;
  } else {
    if (room.status === 'lobby' && room.players.size >= MAX_PLAYERS) {
      send(ws, { type: 'error', message: 'Room is full.' });
      try { ws.close(4009, 'Room full'); } catch { /* noop */ }
      return null;
    }
    const index = room.players.size;
    const spawn = spawnPosition(arena, index);
    player = {
      userId: user.id,
      username: user.username,
      color: COLORS[index % COLORS.length],
      ws,
      x: spawn.x,
      y: spawn.y,
      angle: 0,
      finishedAt: null,
      placement: null,
    };
    room.players.set(user.id, player);
  }

  // Tell the newcomer the full state; if a race is already running they
  // get the start timestamp so their clock + obstacle motion line up.
  send(ws, lobbyPayload(room));
  if (room.status === 'racing') {
    send(ws, { type: 'race_start', startAt: room.raceStartedAt, arenaId: room.arenaId });
  }
  // Refresh everyone's roster.
  broadcast(room, lobbyPayload(room), ws);
  log.info('game', 'Player connected', { code: room.code, userId: user.id });
  return room;
}

function handleDisconnect(ws, user, code) {
  const room = getRoom(code);
  if (!room) return;
  const player = room.players.get(user.id);
  // Only remove if this exact socket is the current one (guards against a
  // stale close arriving after a reconnect replaced the socket).
  if (!player || player.ws !== ws) return;
  room.players.delete(user.id);
  log.info('game', 'Player disconnected', { code: room.code, userId: user.id });

  // Host leaving the LOBBY closes the room for everyone.
  if (user.id === room.hostUserId && room.status === 'lobby') {
    closeRoom(room, 'host_left');
    return;
  }

  // Empty room — tear down (stop the tick, drop from memory).
  if (room.players.size === 0) {
    teardown(room);
    return;
  }

  // Otherwise the race / lobby continues; refresh the roster.
  broadcast(room, lobbyPayload(room));
}

// ---- Inbound messages --------------------------------------------------

function handleMessage(ws, user, code, msg) {
  const room = getRoom(code);
  if (!room) return;
  const player = room.players.get(user.id);
  if (!player || player.ws !== ws) return;

  switch (msg && msg.type) {
    case 'pos': {
      if (room.status !== 'racing') return;
      const { x, y, angle } = msg;
      if (!arenas.isPlausiblePosition(room.arenaId, x, y)) return;
      const c = arenas.clampToBounds(room.arenaId, x, y);
      player.x = c.x;
      player.y = c.y;
      player.angle = Number.isFinite(angle) ? angle : player.angle;
      maybeFinish(room, player);
      break;
    }
    case 'finish': {
      // Client claims it crossed — re-validate against the authoritative
      // finish zone using the last-known (or supplied) coordinates.
      if (room.status !== 'racing') return;
      if (arenas.isPlausiblePosition(room.arenaId, msg.x, msg.y)) {
        const c = arenas.clampToBounds(room.arenaId, msg.x, msg.y);
        player.x = c.x;
        player.y = c.y;
      }
      maybeFinish(room, player);
      break;
    }
    case 'start': {
      if (user.id !== room.hostUserId) return;
      startRace(room);
      break;
    }
    case 'rematch': {
      if (user.id !== room.hostUserId) return;
      rematch(room);
      break;
    }
    default:
      break;
  }
}

// ---- Race flow ---------------------------------------------------------

function startRace(room) {
  if (room.status !== 'lobby') return;
  room.status = 'racing';
  room.finished = false;
  room.raceStartedAt = Date.now();
  // Reset positions to the spawn band so the countdown starts fair.
  const arena = arenas.getArena(room.arenaId) || arenas.getDefaultArena();
  let i = 0;
  for (const p of room.players.values()) {
    const spawn = spawnPosition(arena, i++);
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = 0;
    p.finishedAt = null;
    p.placement = null;
  }
  broadcast(room, { type: 'race_start', startAt: room.raceStartedAt, arenaId: room.arenaId });
  startTicker(room);
  if (_pool && room.id) {
    _pool.query('UPDATE game_rooms SET status = $1 WHERE id = $2', ['racing', room.id])
      .catch((err) => log.warn('game', 'persist race start failed', { err: err.message }));
  }
  log.info('game', 'Race started', { code: room.code, players: room.players.size });
}

function startTicker(room) {
  if (room.tickHandle) return;
  room.tickHandle = setInterval(() => {
    if (room.status !== 'racing') return;
    const players = [];
    for (const p of room.players.values()) {
      players.push({ userId: p.userId, x: Math.round(p.x), y: Math.round(p.y), angle: p.angle });
    }
    broadcast(room, { type: 'snapshot', t: Date.now() - room.raceStartedAt, players });
  }, SNAPSHOT_MS);
}

function stopTicker(room) {
  if (room.tickHandle) {
    clearInterval(room.tickHandle);
    room.tickHandle = null;
  }
}

// Server-authoritative finish: the FIRST player whose centre enters the
// finish zone wins and ends the race instantly (spec: "the instant a
// player crosses the finish line, the race ends for the room"). The
// duplicate-finish guard is the `room.finished` flag — any later finish
// for an already-ended race is ignored.
function maybeFinish(room, player) {
  if (room.status !== 'racing' || room.finished) return;
  if (!arenas.isInFinishZone(room.arenaId, player.x, player.y)) return;
  finishRace(room, player.userId);
}

function finishRace(room, winnerId) {
  if (room.finished) return;
  room.finished = true;
  room.status = 'finished';
  stopTicker(room);

  const finishMs = Date.now() - (room.raceStartedAt || Date.now());

  // Build placements: winner first, then everyone else ordered by how
  // close they were to the finish zone when the race ended.
  const winner = room.players.get(winnerId);
  if (winner) {
    winner.placement = 1;
    winner.finishedAt = Date.now();
  }
  const others = [];
  for (const p of room.players.values()) {
    if (p.userId === winnerId) continue;
    others.push(p);
  }
  others.sort((a, b) =>
    arenas.distanceToFinish(room.arenaId, a.x, a.y) -
    arenas.distanceToFinish(room.arenaId, b.x, b.y)
  );
  let place = 2;
  for (const p of others) p.placement = place++;

  const results = [];
  if (winner) {
    results.push({ userId: winner.userId, username: winner.username, color: winner.color, placement: 1, finishMs });
  }
  for (const p of others) {
    results.push({ userId: p.userId, username: p.username, color: p.color, placement: p.placement, finishMs: null });
  }
  results.sort((a, b) => a.placement - b.placement);

  broadcast(room, { type: 'race_finished', winnerId, results });
  persistResult(room, winnerId, finishMs, results)
    .catch((err) => log.warn('game', 'persist result failed', { err: err.message }));
  log.info('game', 'Race finished', { code: room.code, winnerId });
}

async function persistResult(room, winnerId, finishMs, results) {
  if (!_pool || !room.id) return;
  await _pool.query(
    'UPDATE game_rooms SET status = $1, finished_at = NOW() WHERE id = $2',
    ['finished', room.id]
  );
  for (const r of results) {
    await _pool.query(
      `UPDATE game_room_players
         SET placement = $1,
             finished_at = CASE WHEN $1 = 1 THEN NOW() ELSE finished_at END
       WHERE room_id = $2 AND user_id = $3`,
      [r.placement, room.id, r.userId]
    );
  }
  await _pool.query(
    `INSERT INTO game_results (room_id, winner_user_id, player_count, finished_at)
     VALUES ($1, $2, $3, NOW())`,
    [room.id, winnerId, results.length]
  );
}

// "Race again" — reset the same room (and code) back to the lobby so the
// existing invite link keeps working.
function rematch(room) {
  if (room.status === 'racing') return;
  stopTicker(room);
  room.status = 'lobby';
  room.finished = false;
  room.raceStartedAt = null;
  const arena = arenas.getArena(room.arenaId) || arenas.getDefaultArena();
  let i = 0;
  for (const p of room.players.values()) {
    const spawn = spawnPosition(arena, i++);
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = 0;
    p.finishedAt = null;
    p.placement = null;
  }
  broadcast(room, lobbyPayload(room));
  if (_pool && room.id) {
    _pool.query(
      `UPDATE game_rooms SET status = 'lobby', finished_at = NULL WHERE id = $1`,
      [room.id]
    ).catch((err) => log.warn('game', 'persist rematch failed', { err: err.message }));
    _pool.query(
      `UPDATE game_room_players SET placement = NULL, finished_at = NULL WHERE room_id = $1`,
      [room.id]
    ).catch((err) => log.warn('game', 'persist rematch players failed', { err: err.message }));
  }
}

function closeRoom(room, reason) {
  broadcast(room, { type: 'room_closed', reason });
  if (_pool && room.id) {
    _pool.query('UPDATE game_rooms SET status = $1 WHERE id = $2', ['closed', room.id])
      .catch((err) => log.warn('game', 'persist close failed', { err: err.message }));
  }
  teardown(room);
}

function teardown(room) {
  stopTicker(room);
  // Close any lingering sockets.
  for (const p of room.players.values()) {
    try { if (p.ws && p.ws.readyState === 1) p.ws.close(4000, 'Room closed'); } catch { /* noop */ }
  }
  room.players.clear();
  rooms.delete(room.code);
  log.debug('game', 'Room torn down', { code: room.code });
}

module.exports = {
  init,
  createRoom,
  getRoom,
  canJoin,
  recordJoin,
  getRoomSnapshot,
  handleConnect,
  handleMessage,
  handleDisconnect,
  // exported for tests
  genCode,
  normalizeCode,
  finishRace,
  startRace,
  rooms,
  MAX_PLAYERS,
  CODE_ALPHABET,
  COLORS,
};
