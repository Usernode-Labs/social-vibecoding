// Arena definitions for the multiplayer obstacle-race feature.
//
// This module is the SINGLE SOURCE OF TRUTH for arena geometry. It is
// `require`d server-side (src/services/game.js reads the finish-zone
// rectangle for server-authoritative finish ordering) AND served to the
// client read-only via `GET /api/game/arenas` (public/js/game.js renders
// walls / obstacles / zones and runs the local physics from the very same
// data). Keeping one definition means the client never disagrees with the
// server about where the finish line is.
//
// Coordinate system: a fixed world rectangle, origin top-left, +y points
// DOWN (canvas convention). Players spawn in the `start` zone near the
// bottom and race UP toward the `finish` zone at the top. All rects are
// `{ x, y, w, h }` in world units with (x, y) the TOP-LEFT corner.
//
// Moving obstacles are intentionally serializable DATA, not functions:
// each carries the parameters of a deterministic motion the client
// evaluates as `base + amplitude * sin(elapsedSeconds * speed + phase)`.
// Because the only thing transmitted at race start is the shared
// `startAt` timestamp, every client computes identical hazard positions
// with zero per-frame network sync. The server never needs to evaluate
// obstacle motion — hazard collisions are client-side and cosmetic; only
// the finish line is authoritative.

const PLAYER_RADIUS = 14;

// One arena ships in v1 (arena rotation is deferred work in the spec).
const ARENAS = [
  {
    id: 'classic',
    name: 'Tumble Tower',
    width: 720,
    height: 2200,
    playerRadius: PLAYER_RADIUS,
    // Spawn band along the bottom. Players are spread across its width.
    start: { x: 40, y: 2060, w: 640, h: 110 },
    // Finish band across the top. Crossing into this rect wins.
    finish: { x: 40, y: 30, w: 640, h: 90 },
    // Static walls — staggered barriers with gaps to weave through, plus
    // the four outer borders so nobody can slip off the world edge.
    walls: [
      // Outer border.
      { x: 0, y: 0, w: 720, h: 16 },
      { x: 0, y: 2184, w: 720, h: 16 },
      { x: 0, y: 0, w: 16, h: 2200 },
      { x: 704, y: 0, w: 16, h: 2200 },
      // Barrier 1 — gap on the right.
      { x: 16, y: 1760, w: 470, h: 26 },
      // Barrier 2 — gap on the left.
      { x: 234, y: 1480, w: 470, h: 26 },
      // Barrier 3 — central pillar, two gaps.
      { x: 300, y: 1200, w: 120, h: 200 },
      // Barrier 4 — gap on the right.
      { x: 16, y: 940, w: 470, h: 26 },
      // Barrier 5 — gap on the left.
      { x: 234, y: 660, w: 470, h: 26 },
      // Barrier 6 — two short stubs framing a centre lane.
      { x: 16, y: 380, w: 250, h: 26 },
      { x: 454, y: 380, w: 250, h: 26 },
    ],
    // Moving hazards — horizontal sweepers at several heights. `x` is the
    // centre of travel; the bar oscillates ±amplitude along the x axis.
    obstacles: [
      { kind: 'sweeper', axis: 'x', x: 360, y: 1900, w: 150, h: 22, amplitude: 230, speed: 1.1, phase: 0 },
      { kind: 'sweeper', axis: 'x', x: 360, y: 1620, w: 150, h: 22, amplitude: 230, speed: 1.4, phase: 1.6 },
      { kind: 'sweeper', axis: 'x', x: 360, y: 1080, w: 150, h: 22, amplitude: 240, speed: 1.25, phase: 0.8 },
      { kind: 'sweeper', axis: 'x', x: 360, y: 800, w: 150, h: 22, amplitude: 230, speed: 1.5, phase: 2.2 },
      { kind: 'sweeper', axis: 'x', x: 360, y: 240, w: 150, h: 22, amplitude: 250, speed: 1.2, phase: 0.4 },
    ],
  },
];

const DEFAULT_ARENA_ID = 'classic';

function getArena(id) {
  return ARENAS.find((a) => a.id === id) || null;
}

function getDefaultArena() {
  return getArena(DEFAULT_ARENA_ID);
}

// Point-in-rect test (inclusive). Shared by finish detection and any
// other zone checks. `r` is `{ x, y, w, h }` top-left.
function pointInRect(px, py, r) {
  return (
    typeof px === 'number' && typeof py === 'number' &&
    px >= r.x && px <= r.x + r.w &&
    py >= r.y && py <= r.y + r.h
  );
}

// Server-authoritative finish test: is the player's centre inside the
// arena's finish rectangle? Returns false for unknown arenas or
// non-finite coordinates (defensive — inbound positions are untrusted).
function isInFinishZone(arenaId, x, y) {
  const arena = getArena(arenaId);
  if (!arena) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return pointInRect(x, y, arena.finish);
}

// Distance from a point to the centre of the finish zone. Used to rank
// the racers who hadn't finished yet when the race ended (closest =
// better placement). Returns Infinity for unknown arenas / bad input so
// such players sort to the back.
function distanceToFinish(arenaId, x, y) {
  const arena = getArena(arenaId);
  if (!arena || !Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
  const cx = arena.finish.x + arena.finish.w / 2;
  const cy = arena.finish.y + arena.finish.h / 2;
  return Math.hypot(x - cx, y - cy);
}

// Clamp a coordinate to the playable interior (inside the outer border),
// accounting for the player radius. Used to sanitise inbound positions.
function clampToBounds(arenaId, x, y) {
  const arena = getArena(arenaId);
  if (!arena) return { x, y };
  const r = arena.playerRadius;
  const cx = Math.min(Math.max(x, r), arena.width - r);
  const cy = Math.min(Math.max(y, r), arena.height - r);
  return { x: cx, y: cy };
}

// Whether a coordinate pair is finite and within the world rectangle
// (with a small slack). Inbound positions that fail this are dropped.
function isPlausiblePosition(arenaId, x, y) {
  const arena = getArena(arenaId);
  if (!arena) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const slack = 60;
  return (
    x >= -slack && x <= arena.width + slack &&
    y >= -slack && y <= arena.height + slack
  );
}

module.exports = {
  ARENAS,
  DEFAULT_ARENA_ID,
  PLAYER_RADIUS,
  getArena,
  getDefaultArena,
  pointInRect,
  isInFinishZone,
  distanceToFinish,
  clampToBounds,
  isPlausiblePosition,
};
