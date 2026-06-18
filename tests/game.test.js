// Tests for the multiplayer obstacle-race feature.
//
// Two layers:
//   1. Unit tests against the pure engine logic in src/services/game.js
//      and the arena geometry in src/services/game-arenas.js. These run
//      WITHOUT a pg pool — game.init() is never called, so every DB write
//      is a guarded no-op and we exercise the in-memory room state
//      directly (room codes, join validation, server-authoritative finish
//      ordering, the duplicate-finish guard, host-leaves-lobby and
//      empty-room teardown).
//   2. Source guards pinning the wiring across schema / ws / server so a
//      refactor can't silently drop a link in the chain.
//
// Run with: node --test tests/game.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const game = require('../src/services/game.js');
const arenas = require('../src/services/game-arenas.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Minimal fake WebSocket capturing sent frames.
function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type); },
  };
}

function cleanup() {
  for (const room of [...game.rooms.values()]) {
    // Stop any running ticker by forcing teardown via host disconnect path.
    for (const p of [...room.players.values()]) {
      game.handleDisconnect(p.ws, { id: p.userId }, room.code);
    }
    game.rooms.delete(room.code);
  }
}

// ── 1a. Arena geometry ──────────────────────────────────────────────────

test('arena: default arena exists and has finish + start zones', () => {
  const a = arenas.getDefaultArena();
  assert.ok(a, 'default arena resolves');
  assert.ok(a.finish && a.start, 'has finish + start rects');
  assert.equal(a.id, arenas.DEFAULT_ARENA_ID);
});

test('arena: finish-zone geometry is consistent with the served arena data', () => {
  // The same module backs GET /api/game/arenas (route returns arenas.ARENAS)
  // and the server-side finish check, so a point at the finish centre must
  // register as a finish and a point at the start must not.
  const a = arenas.ARENAS[0];
  const fcx = a.finish.x + a.finish.w / 2;
  const fcy = a.finish.y + a.finish.h / 2;
  assert.equal(arenas.isInFinishZone(a.id, fcx, fcy), true);
  const scx = a.start.x + a.start.w / 2;
  const scy = a.start.y + a.start.h / 2;
  assert.equal(arenas.isInFinishZone(a.id, scx, scy), false);
});

test('arena: isInFinishZone rejects unknown arena + non-finite input', () => {
  assert.equal(arenas.isInFinishZone('nope', 0, 0), false);
  assert.equal(arenas.isInFinishZone(arenas.DEFAULT_ARENA_ID, NaN, 10), false);
});

test('arena: distanceToFinish ranks a closer point lower', () => {
  const a = arenas.ARENAS[0];
  const near = arenas.distanceToFinish(a.id, a.finish.x + a.finish.w / 2, a.finish.y);
  const far = arenas.distanceToFinish(a.id, a.start.x, a.start.y);
  assert.ok(near < far);
});

test('arena: clampToBounds keeps coordinates inside the world', () => {
  const a = arenas.ARENAS[0];
  const c = arenas.clampToBounds(a.id, -999, 999999);
  assert.ok(c.x >= a.playerRadius && c.x <= a.width - a.playerRadius);
  assert.ok(c.y >= a.playerRadius && c.y <= a.height - a.playerRadius);
});

// ── 1b. Room codes ──────────────────────────────────────────────────────

test('genCode: returns 4 chars from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const c = game.genCode();
    assert.equal(c.length, 4);
    for (const ch of c) assert.ok(game.CODE_ALPHABET.includes(ch), `'${ch}' in alphabet`);
  }
  // No ambiguous glyphs.
  assert.ok(!game.CODE_ALPHABET.includes('O'));
  assert.ok(!game.CODE_ALPHABET.includes('0'));
  assert.ok(!game.CODE_ALPHABET.includes('I'));
  assert.ok(!game.CODE_ALPHABET.includes('1'));
});

test('createRoom + canJoin: happy path and rejections', async (t) => {
  t.after(cleanup);
  const host = { id: 1, username: 'host' };
  const { code } = await game.createRoom(host);
  assert.ok(game.getRoom(code), 'room registered in memory');

  // Unknown code → 404.
  const miss = game.canJoin('ZZZZ', { id: 2, username: 'b' });
  assert.equal(miss.ok, false);
  assert.equal(miss.status, 404);

  // Valid lobby join → ok.
  const ok = game.canJoin(code, { id: 2, username: 'b' });
  assert.equal(ok.ok, true);
});

test('canJoin: rejects a full room and a started room', async (t) => {
  t.after(cleanup);
  const host = { id: 1, username: 'host' };
  const { code } = await game.createRoom(host);
  const room = game.getRoom(code);

  // Fill to MAX_PLAYERS with live connections.
  for (let i = 0; i < game.MAX_PLAYERS; i++) {
    game.handleConnect(fakeWs(), { id: 100 + i, username: `p${i}` }, code);
  }
  const full = game.canJoin(code, { id: 999, username: 'late' });
  assert.equal(full.ok, false);
  assert.equal(full.status, 409);
  assert.match(full.error, /full/i);

  // Start → a new joiner is rejected as already-started.
  room.status = 'racing';
  const started = game.canJoin(code, { id: 998, username: 'late2' });
  assert.equal(started.ok, false);
  assert.equal(started.status, 409);
});

// ── 1c. Race flow: server-authoritative finish ──────────────────────────

test('finish ordering: first into the finish zone wins; others ranked by distance', async (t) => {
  t.after(cleanup);
  const { code } = await game.createRoom({ id: 1, username: 'host' });
  const a = arenas.ARENAS[0];

  const wsHost = fakeWs(); game.handleConnect(wsHost, { id: 1, username: 'host' }, code);
  const wsB = fakeWs(); game.handleConnect(wsB, { id: 2, username: 'b' }, code);
  const wsC = fakeWs(); game.handleConnect(wsC, { id: 3, username: 'c' }, code);

  // Host starts the race.
  game.handleMessage(wsHost, { id: 1, username: 'host' }, code, { type: 'start' });
  assert.equal(game.getRoom(code).status, 'racing');
  assert.ok(wsB.last('race_start'), 'race_start broadcast to players');

  // Position B near the finish but not in it; C far away; then drive B in.
  const fcx = a.finish.x + a.finish.w / 2;
  const fcy = a.finish.y + a.finish.h / 2;
  game.handleMessage(wsC, { id: 3, username: 'c' }, code,
    { type: 'pos', x: a.start.x + 10, y: a.start.y });   // far from finish
  game.handleMessage(wsHost, { id: 1, username: 'host' }, code,
    { type: 'pos', x: a.finish.x + a.finish.w / 2, y: a.finish.y + a.finish.h + 60 }); // mid-ish
  // B crosses the line.
  game.handleMessage(wsB, { id: 2, username: 'b' }, code,
    { type: 'pos', x: fcx, y: fcy });

  const fin = wsB.last('race_finished');
  assert.ok(fin, 'race_finished broadcast');
  assert.equal(fin.winnerId, 2, 'B is the winner');
  assert.equal(game.getRoom(code).status, 'finished');

  // Winner is placement 1; everyone has a placement; order is by distance.
  const byUser = Object.fromEntries(fin.results.map((r) => [r.userId, r.placement]));
  assert.equal(byUser[2], 1);
  // Host was closer to the finish than C, so host outranks C.
  assert.ok(byUser[1] < byUser[3], 'closer racer (host) ranks above far racer (C)');
});

test('duplicate-finish guard: a later crossing does not change the winner', async (t) => {
  t.after(cleanup);
  const { code } = await game.createRoom({ id: 1, username: 'host' });
  const a = arenas.ARENAS[0];
  const wsHost = fakeWs(); game.handleConnect(wsHost, { id: 1, username: 'host' }, code);
  const wsB = fakeWs(); game.handleConnect(wsB, { id: 2, username: 'b' }, code);
  game.handleMessage(wsHost, { id: 1, username: 'host' }, code, { type: 'start' });

  const fcx = a.finish.x + a.finish.w / 2;
  const fcy = a.finish.y + a.finish.h / 2;
  game.handleMessage(wsB, { id: 2, username: 'b' }, code, { type: 'pos', x: fcx, y: fcy });
  const firstWinner = wsB.last('race_finished').winnerId;
  assert.equal(firstWinner, 2);

  const before = wsHost.sent.length;
  // Host now tries to "finish" too — must be ignored (status is finished).
  game.handleMessage(wsHost, { id: 1, username: 'host' }, code, { type: 'finish', x: fcx, y: fcy });
  const after = wsHost.sent.filter((m) => m.type === 'race_finished').length;
  assert.equal(after, 1, 'only one race_finished was ever emitted to host');
  assert.equal(before <= wsHost.sent.length, true);
});

// ── 1d. Edge cases ───────────────────────────────────────────────────────

test('host leaves lobby: room closes and remaining players are notified', async (t) => {
  t.after(cleanup);
  const { code } = await game.createRoom({ id: 1, username: 'host' });
  const wsHost = fakeWs(); game.handleConnect(wsHost, { id: 1, username: 'host' }, code);
  const wsB = fakeWs(); game.handleConnect(wsB, { id: 2, username: 'b' }, code);

  game.handleDisconnect(wsHost, { id: 1, username: 'host' }, code);

  assert.ok(wsB.last('room_closed'), 'remaining player got room_closed');
  assert.equal(wsB.last('room_closed').reason, 'host_left');
  assert.equal(game.getRoom(code), null, 'room torn down');
});

test('empty room teardown: last disconnect removes the room from memory', async (t) => {
  t.after(cleanup);
  const { code } = await game.createRoom({ id: 1, username: 'host' });
  const wsHost = fakeWs(); game.handleConnect(wsHost, { id: 1, username: 'host' }, code);
  const wsB = fakeWs(); game.handleConnect(wsB, { id: 2, username: 'b' }, code);
  // A non-host player leaving keeps the room alive...
  game.handleDisconnect(wsB, { id: 2, username: 'b' }, code);
  assert.ok(game.getRoom(code), 'room still alive with host present');
  // ...host leaving an empty-after lobby closes it (host_left path), so use a
  // mid-race scenario to exercise the pure empty-room branch instead.
  const room = game.getRoom(code);
  room.status = 'racing'; // so host-leave doesn't take the lobby-close branch
  game.handleDisconnect(wsHost, { id: 1, username: 'host' }, code);
  assert.equal(game.getRoom(code), null, 'empty room torn down');
});

test('mid-race disconnect: race continues for the others', async (t) => {
  t.after(cleanup);
  const { code } = await game.createRoom({ id: 1, username: 'host' });
  const wsHost = fakeWs(); game.handleConnect(wsHost, { id: 1, username: 'host' }, code);
  const wsB = fakeWs(); game.handleConnect(wsB, { id: 2, username: 'b' }, code);
  game.handleMessage(wsHost, { id: 1, username: 'host' }, code, { type: 'start' });

  // B drops mid-race.
  game.handleDisconnect(wsB, { id: 2, username: 'b' }, code);
  const room = game.getRoom(code);
  assert.ok(room, 'room still alive');
  assert.equal(room.status, 'racing', 'race continues');
  assert.equal(room.players.has(2), false, 'B removed');
  // Clean up the running ticker.
  game.handleDisconnect(wsHost, { id: 1, username: 'host' }, code);
});

test('connecting to a missing room closes the socket', () => {
  const ws = fakeWs();
  const room = game.handleConnect(ws, { id: 1, username: 'x' }, 'NOPE');
  assert.equal(room, null);
  assert.equal(ws.readyState, 3, 'socket closed');
  assert.ok(ws.last('room_closed'));
});

// ── 2. Source guards ─────────────────────────────────────────────────────

test('guard: ws.js routes /ws/game/ upgrades to the game engine', () => {
  const src = read('src/services/ws.js');
  assert.match(src, /\/ws\/game\//, 'has the /ws/game/ branch');
  assert.match(src, /game\.handleConnect/, 'delegates connect to game.js');
  assert.match(src, /game\.handleMessage/, 'delegates messages to game.js');
  assert.match(src, /game\.handleDisconnect/, 'delegates disconnect to game.js');
});

test('guard: server.js mounts gameRoutes', () => {
  const src = read('server.js');
  assert.match(src, /gameRoutes/, 'imports + mounts gameRoutes');
});

test('guard: schema declares the three public game tables (no staging:private)', () => {
  const sql = read('src/db/schema.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS game_rooms/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS game_room_players/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS game_results/);
  assert.doesNotMatch(sql, /COMMENT ON TABLE game_rooms\s+IS\s+'staging:private'/);
  assert.doesNotMatch(sql, /COMMENT ON TABLE game_room_players\s+IS\s+'staging:private'/);
  assert.doesNotMatch(sql, /COMMENT ON TABLE game_results\s+IS\s+'staging:private'/);
});

test('guard: migrate.js seeds staging game fixtures', () => {
  const src = read('src/db/migrate.js');
  assert.match(src, /seedStagingGameFixtures/);
  assert.match(src, /game_results/);
});

test('guard: routes/game.js exposes the documented endpoints', () => {
  const src = read('src/routes/game.js');
  assert.match(src, /\/api\/game\/arenas/);
  assert.match(src, /\/api\/game\/rooms/);
  assert.match(src, /\/api\/game\/rooms\/:code\/join/);
  assert.match(src, /\/api\/game\/results/);
});
