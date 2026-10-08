// The space game's rules: everyone flies together through waves of
// asteroids. A ship's mining beam cracks a rock into smaller ones, and the
// smallest into crystals; flying through a crystal collects it for the
// team's score. A rock that hits a ship costs it a shield (and a moment of
// cover); out of shields, the ship heads back to the dock. The run ends when
// every ship is docked, and its score goes on the leaderboard.
//
// No weapons and nothing gets hurt: a mining beam on rocks, which is what
// keeps it within Homeroom's content rules. Keep it that way when you change
// it.
//
// A live game, kept to the game room's contract (game/room.js): the server
// ticks the rocks, crystals, beams and hits 20 times a second and sends every
// page a frame. Each player flies their own ship on their own screen, so the
// controls answer at once, and sends where it is (input); the server keeps
// it inside the field and does the rest.

'use strict';

const W = 960;
const H = 600;
const SHIP_R = 14;
const MAX_SPEED = 320;
const BEAM_LEN = 210;
const BEAM_POWER = 1.6; // rock strength removed per second of beam
const CRYSTAL_TTL_MS = 12000;
const CRYSTAL_POINTS = 10;
const SHIELDS = 3;
const COVER_MS = 2000;
const AWAY_MS = 8000;
const WAVE_GAP_MS = 2500;
// A rock's radius and strength by size.
const SIZES = { 3: { r: 42, hp: 1.4 }, 2: { r: 26, hp: 0.9 }, 1: { r: 15, hp: 0.5 } };

function wrap(v, max) {
  return ((v % max) + max) % max;
}

// The shortest way from a to b on a field that wraps round.
function delta(a, b, max) {
  let d = b - a;
  if (d > max / 2) d -= max;
  if (d < -max / 2) d += max;
  return d;
}

function newShip(player, seat, now) {
  return {
    username: player.username, seat, x: W / 2 + (seat % 3 - 1) * 60, y: H / 2 + (Math.floor(seat / 3) - 0.5) * 60,
    a: -Math.PI / 2, beam: false, shields: SHIELDS, docked: false, coverUntil: now + COVER_MS, crystals: 0, seenAt: now,
  };
}

function setup({ players, now }) {
  const ships = {};
  players.forEach((p, seat) => { ships[p.id] = newShip(p, seat, now); });
  return {
    w: W, h: H, wave: 0, waveAt: now + 1500, score: 0, nextId: 1,
    ships, rocks: [], crystals: [], flew: players.map((p) => ({ id: p.id, username: p.username })), over: false,
  };
}

function spawnWave(game, random) {
  game.wave += 1;
  const count = 2 + game.wave;
  const speed = 40 + game.wave * 8;
  for (let i = 0; i < count; i += 1) {
    // From the edges, never on top of the ships in the middle.
    const edge = Math.floor(random() * 4);
    const x = edge === 0 ? 0 : edge === 1 ? W - 1 : random() * W;
    const y = edge === 2 ? 0 : edge === 3 ? H - 1 : random() * H;
    const dir = random() * Math.PI * 2;
    game.rocks.push({ id: game.nextId++, x, y, vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed, size: 3, hp: SIZES[3].hp });
  }
}

// How far a rock's centre is from a beam: the segment from the ship's nose.
function beamDistance(ship, rock) {
  const dx = Math.cos(ship.a);
  const dy = Math.sin(ship.a);
  const rx = delta(ship.x, rock.x, W);
  const ry = delta(ship.y, rock.y, H);
  const along = Math.max(0, Math.min(BEAM_LEN, rx * dx + ry * dy));
  return Math.hypot(rx - dx * along, ry - dy * along);
}

function crack(game, rock, random) {
  if (rock.size > 1) {
    const size = rock.size - 1;
    const speed = Math.hypot(rock.vx, rock.vy) * 1.25 + 20;
    const dir = Math.atan2(rock.vy, rock.vx);
    for (const turn of [-0.8, 0.8]) {
      game.rocks.push({
        id: game.nextId++, x: rock.x, y: rock.y, size, hp: SIZES[size].hp,
        vx: Math.cos(dir + turn) * speed, vy: Math.sin(dir + turn) * speed,
      });
    }
  } else {
    for (let i = 0; i < 2; i += 1) {
      const dir = random() * Math.PI * 2;
      game.crystals.push({ id: game.nextId++, x: rock.x, y: rock.y, vx: Math.cos(dir) * 30, vy: Math.sin(dir) * 30, ttl: CRYSTAL_TTL_MS });
    }
  }
}

function tick(game, dt, { now, random }) {
  const g = game; // mutated in place: a tick is the room's alone
  const s = dt / 1000;
  if (g.over) return g;
  for (const r of g.rocks) {
    r.x = wrap(r.x + r.vx * s, W);
    r.y = wrap(r.y + r.vy * s, H);
  }
  for (const c of g.crystals) {
    c.x = wrap(c.x + c.vx * s, W);
    c.y = wrap(c.y + c.vy * s, H);
    c.ttl -= dt;
  }
  const ships = Object.entries(g.ships).filter(([, ship]) => !ship.docked);
  // Somebody who stopped sending (closed the page) heads back to the dock.
  for (const [, ship] of ships) if (now - ship.seenAt > AWAY_MS) ship.docked = true;
  // Beams wear rocks down; a worn-out rock cracks.
  const cracked = new Set();
  for (const [, ship] of ships) {
    if (ship.docked || !ship.beam) continue;
    for (const r of g.rocks) {
      if (cracked.has(r.id)) continue;
      if (beamDistance(ship, r) < SIZES[r.size].r) {
        r.hp -= BEAM_POWER * s;
        if (r.hp <= 0) cracked.add(r.id);
      }
    }
  }
  if (cracked.size) {
    const gone = g.rocks.filter((r) => cracked.has(r.id));
    g.rocks = g.rocks.filter((r) => !cracked.has(r.id));
    for (const r of gone) crack(g, r, random);
  }
  // Crystals flown through are collected; old ones fade.
  g.crystals = g.crystals.filter((c) => {
    if (c.ttl <= 0) return false;
    for (const [, ship] of ships) {
      if (ship.docked) continue;
      if (Math.hypot(delta(ship.x, c.x, W), delta(ship.y, c.y, H)) < SHIP_R + 10) {
        ship.crystals += 1;
        g.score += CRYSTAL_POINTS;
        return false;
      }
    }
    return true;
  });
  // A rock that hits a ship costs it a shield, then a moment of cover.
  for (const [, ship] of ships) {
    if (ship.docked || now < ship.coverUntil) continue;
    for (const r of g.rocks) {
      if (Math.hypot(delta(ship.x, r.x, W), delta(ship.y, r.y, H)) < SIZES[r.size].r + SHIP_R * 0.7) {
        ship.shields -= 1;
        ship.coverUntil = now + COVER_MS;
        if (ship.shields <= 0) ship.docked = true;
        break;
      }
    }
  }
  // The next wave, a moment after the last rock went.
  if (!g.rocks.length && g.waveAt == null) g.waveAt = now + WAVE_GAP_MS;
  if (g.waveAt != null && now >= g.waveAt) {
    g.waveAt = null;
    spawnWave(g, random);
  }
  const flying = Object.values(g.ships).some((ship) => !ship.docked);
  if (!flying && Object.keys(g.ships).length) g.over = true;
  return g;
}

// A ship's controls: where its own page says it is, kept inside the field
// and to the speed limit, and whether its beam is on.
function input(game, player, controls, { now }) {
  const ship = game.ships[player.id];
  if (!ship || ship.docked) return game;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = n(controls.x);
  const y = n(controls.y);
  if (x != null && y != null) {
    // A jump further than the speed limit allows is not believed.
    const far = Math.hypot(delta(ship.x, x, W), delta(ship.y, y, H));
    const allowed = MAX_SPEED * Math.max(0.25, (now - ship.seenAt) / 1000) + 40;
    if (far <= allowed) {
      ship.x = wrap(x, W);
      ship.y = wrap(y, H);
    }
  }
  if (n(controls.a) != null) ship.a = controls.a;
  ship.beam = controls.beam === true;
  ship.seenAt = now;
  return game;
}

// Somebody joins a run already on: a new ship near the middle.
function addPlayer(game, player, { now }) {
  if (game.ships[player.id] && !game.ships[player.id].docked) return game;
  game.ships[player.id] = newShip(player, Object.keys(game.ships).length, now);
  if (!game.flew.some((f) => f.id === player.id)) game.flew.push({ id: player.id, username: player.username });
  return game;
}

function removePlayer(game, id) {
  if (game.ships[id]) game.ships[id].docked = true;
  const flying = Object.values(game.ships).some((ship) => !ship.docked);
  if (!flying) game.over = true;
  return game;
}

const round = (v) => Math.round(v);

// What a frame carries: everything that moves, rounded, as short arrays.
function frame(game) {
  return {
    w: game.w, h: game.h, wave: game.wave, waveAt: game.waveAt, score: game.score,
    ships: Object.entries(game.ships).map(([id, s]) => [Number(id), round(s.x), round(s.y), Math.round(s.a * 100) / 100,
      s.beam ? 1 : 0, s.shields, s.docked ? 1 : 0, s.coverUntil, s.seat, s.username, s.crystals]),
    rocks: game.rocks.map((r) => [r.id, round(r.x), round(r.y), r.size]),
    crystals: game.crystals.map((c) => [c.id, round(c.x), round(c.y)]),
  };
}

// The team shares its score: everyone who flew in the run gets it.
function result(game) {
  if (!game.over) return null;
  return game.flew.map((f) => ({ id: f.id, username: f.username, score: game.score, place: 1 }));
}

module.exports = {
  minPlayers: 1,
  maxPlayers: 8,
  dropIn: true,
  live: true,
  tickMs: 50,
  leaderboard: 'best',
  setup,
  tick,
  input,
  addPlayer,
  removePlayer,
  view: (game) => frame(game),
  frame,
  act: () => ({ error: 'Fly with the controls: there are no moves to make here.' }),
  result,
  W,
  H,
  SIZES,
  SHIP_R,
  BEAM_LEN,
  MAX_SPEED,
};
