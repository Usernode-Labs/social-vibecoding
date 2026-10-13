// The space game's rules: a forward-scrolling dodging run, flown together.
// Pulsars drift into the field and throw out storms of sparks in patterns
// (rings, spirals, curving flowers, fans aimed at the nearest ship) and
// comet showers sweep down from the top. Every pilot weaves through them
// and collects the stardust drifting past. A spark that hits a ship costs
// it a shield (and a moment of cover); out of shields, the ship is out of
// the run. The run ends when every ship is out, and each pilot's score
// (time flown and stardust) goes on the leaderboard.
//
// Nothing here is a weapon and nobody attacks anybody: the storms are the
// weather of space, and the game is dodging them. That is what keeps it
// within Homeroom's content rules. Keep it that way when you change it.
//
// A live game, kept to the game room's contract (game/room.js). The server
// decides WHAT is in the field: each storm is a few numbers (where its
// pulsar drifts, how often it throws sparks, how many, how fast, how they
// turn), and every page works out where each spark is at any moment from
// those numbers (public/app.js, sparkAt), so hundreds of sparks cost a frame
// almost nothing. Each player flies their own ship on their own screen and
// sends where it is (input); their own page sees a spark touch their ship
// and says so (act 'hit'), and the server takes a shield.

'use strict';

const W = 600;
const H = 1000;
const SHIELDS = 3;
const COVER_MS = 2000;
const AWAY_MS = 8000;
// The fastest a ship may move, in field units a second (a finger dragging).
const MAX_SPEED = 560;
// Every half minute, the next sector: more storms, faster sparks.
const SECTOR_MS = 30000;
const POINTS_PER_SECOND = 10;
const DUST_POINTS = 50;
// How near a ship has to be to stardust to collect it, allowing for the
// time it takes to hear where the ship is.
const DUST_REACH = 110;
// The longest a spark is followed; by then it has left the field.
const SPARK_LIFE_MS = 9000;
const ENTER_MS = 1600;

// The storms a pulsar can throw, and the sector each first appears in.
// colour indexes the page's palette (public/app.js SPARK_COLOURS); size is
// how big a spark is (1 small, 2 large). An aimed storm's sparks are sent as
// bursts, since where they go depends on where the ships were.
const PATTERNS = {
  ring: { from: 1, interval: 1300, n: 12, rot: 0.13, v: 105, curve: 0, size: 2, colour: 0 },
  spiral: { from: 2, interval: 150, n: 3, rot: 0.29, v: 150, curve: 0, size: 1, colour: 1 },
  fan: { from: 3, interval: 1000, n: 5, spread: 0.2, v: 185, size: 1, colour: 3, aimed: true },
  flower: { from: 4, interval: 1150, n: 12, rot: 0, v: 100, curve: 0.85, alt: true, size: 1, colour: 2 },
};
const WALL_COLOUR = 4;

function smooth(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

// Where a storm's pulsar is at time T: it drifts in from the top, sways
// while it throws sparks, then drifts back out. The page has the same.
function pulsarAt(s, T) {
  const t = T - s.t0;
  let y;
  if (t < s.enter) y = -60 + (s.ys + 60) * smooth(t / s.enter);
  else if (t < s.enter + s.stay) y = s.ys;
  else y = s.ys - (s.ys + 60) * smooth((t - s.enter - s.stay) / s.enter);
  return { x: s.x + s.sway * Math.sin((2 * Math.PI * t) / s.swayMs), y };
}

function sectorOf(game, now) {
  return 1 + Math.floor(Math.max(0, now - game.start) / SECTOR_MS);
}

function newShip(player, seat, now) {
  return {
    username: player.username, seat, x: W / 2 + ((seat % 4) - 1.5) * 70, y: H - 150 + Math.floor(seat / 4) * 50,
    shields: SHIELDS, out: false, coverUntil: now + COVER_MS, seenAt: now, aliveMs: 0, dust: 0, score: 0,
  };
}

function setup({ players, now }) {
  const ships = {};
  players.forEach((p, seat) => { ships[p.id] = newShip(p, seat, now); });
  return {
    w: W, h: H, now, start: now, sector: 1, nextId: 1,
    nextStorm: now + 2000, nextWall: now + 7000, nextDust: now + 800,
    ships, storms: [], bursts: [], dust: [],
    flew: players.map((p) => ({ id: p.id, username: p.username })), over: false,
  };
}

function aliveShips(game) {
  return Object.values(game.ships).filter((s) => !s.out);
}

function spawnStorm(game, now, random) {
  const kinds = Object.keys(PATTERNS).filter((k) => PATTERNS[k].from <= game.sector);
  const kind = kinds[Math.floor(random() * kinds.length)];
  const p = PATTERNS[kind];
  const mul = Math.min(1.6, 1 + 0.08 * (game.sector - 1));
  const n = p.aimed ? 0 : p.n + Math.min(6, game.sector - 1);
  game.storms.push({
    id: game.nextId++, kind, t0: now, x: 90 + random() * (W - 180), ys: 130 + random() * 260,
    sway: random() * 90, swayMs: 5000 + random() * 4000, enter: ENTER_MS, stay: 5500 + random() * 2500,
    interval: Math.round(p.interval * Math.max(0.6, 1 - 0.07 * (game.sector - 1))), n, rot: (p.rot || 0) * (random() < 0.5 ? -1 : 1), spread: n ? (Math.PI * 2) / n : 0,
    v: Math.round(p.v * mul), curve: p.curve || 0, alt: !!p.alt, size: p.size, colour: p.colour,
    a0: random() * Math.PI * 2, aimed: !!p.aimed, nextAim: now + ENTER_MS, dropped: false,
  });
}

// A comet shower: a row of comets across the top, with a gap to fly through.
function spawnWall(game, now, random) {
  const n = 12;
  const dx = W / n;
  const mul = Math.min(1.6, 1 + 0.08 * (game.sector - 1));
  game.bursts.push({
    id: game.nextId++, t: now, x: dx / 2, y: -20, n, dx, a: Math.PI / 2, spread: 0,
    v: Math.round(130 * mul), size: 2, colour: WALL_COLOUR, gap: 1 + Math.floor(random() * (n - 3)),
  });
}

function spawnDust(game, now, x, y, random) {
  game.dust.push({ id: game.nextId++, x: Math.round(x), y: Math.round(y), t: now, v: Math.round(80 + random() * 50) });
}

function dustAt(d, T) {
  return { x: d.x, y: d.y + (d.v * (T - d.t)) / 1000 };
}

function tick(game, dt, { now, random }) {
  const g = game; // mutated in place: a tick is the room's alone
  g.now = now;
  if (g.over) return g;
  g.sector = sectorOf(g, now);
  // Somebody who stopped sending (closed the page) is out of the run.
  for (const ship of aliveShips(g)) if (now - ship.seenAt > AWAY_MS) ship.out = true;
  for (const ship of aliveShips(g)) {
    ship.aliveMs += dt;
    ship.score = Math.floor(ship.aliveMs / (1000 / POINTS_PER_SECOND)) + ship.dust * DUST_POINTS;
  }
  // New storms, more of them at once as the sectors go by.
  const active = g.storms.filter((s) => now < s.t0 + s.enter + s.stay).length;
  if (now >= g.nextStorm && active < Math.min(4, g.sector)) {
    spawnStorm(g, now, random);
    g.nextStorm = now + Math.max(2200, 5200 - 500 * (g.sector - 1));
  }
  if (now >= g.nextWall) {
    spawnWall(g, now, random);
    g.nextWall = now + Math.max(5000, 10000 - 700 * (g.sector - 1));
  }
  if (now >= g.nextDust) {
    spawnDust(g, now, 40 + random() * (W - 80), -20, random);
    g.nextDust = now + 1300;
  }
  for (const s of g.storms) {
    // An aimed storm throws a fan at the nearest ship.
    if (s.aimed) {
      while (s.nextAim <= now && s.nextAim < s.t0 + s.enter + s.stay) {
        const at = pulsarAt(s, s.nextAim);
        const ships = aliveShips(g);
        let aim = Math.PI / 2;
        let best = Infinity;
        for (const ship of ships) {
          const d = Math.hypot(ship.x - at.x, ship.y - at.y);
          if (d < best) { best = d; aim = Math.atan2(ship.y - at.y, ship.x - at.x); }
        }
        const p = PATTERNS[s.kind];
        g.bursts.push({
          id: g.nextId++, t: s.nextAim, x: Math.round(at.x), y: Math.round(at.y), n: p.n, dx: 0,
          a: aim - (p.spread * (p.n - 1)) / 2, spread: p.spread, v: s.v, size: p.size, colour: p.colour, gap: -10,
        });
        s.nextAim += s.interval;
      }
    }
    // A storm that has blown over leaves stardust behind.
    if (!s.dropped && now >= s.t0 + s.enter + s.stay) {
      s.dropped = true;
      const at = pulsarAt(s, now);
      for (let i = 0; i < 4; i += 1) spawnDust(g, now, at.x + (i - 1.5) * 26, at.y + (i % 2) * 20, random);
    }
  }
  // Forget what has left the field.
  g.storms = g.storms.filter((s) => now < s.t0 + s.enter * 2 + s.stay + SPARK_LIFE_MS);
  g.bursts = g.bursts.filter((b) => now < b.t + SPARK_LIFE_MS);
  g.dust = g.dust.filter((d) => dustAt(d, now).y < H + 40);
  if (Object.keys(g.ships).length && !aliveShips(g).length) g.over = true;
  return g;
}

// A ship's controls: where its own page says it is, kept inside the field
// and to the speed limit.
function input(game, player, controls, { now }) {
  const ship = game.ships[player.id];
  if (!ship || ship.out) return game;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = n(controls.x);
  const y = n(controls.y);
  if (x != null && y != null) {
    // A jump further than the speed limit allows is not believed.
    const far = Math.hypot(ship.x - x, ship.y - y);
    const allowed = MAX_SPEED * Math.max(0.25, (now - ship.seenAt) / 1000) + 40;
    if (far <= allowed) {
      ship.x = Math.max(0, Math.min(W, x));
      ship.y = Math.max(0, Math.min(H, y));
    }
  }
  ship.seenAt = now;
  return game;
}

// A pilot's own page saw a spark touch their ship, or flew it through
// stardust. Each is sent to everyone as an event; the next frame has the rest.
function act(game, action, { player, now }) {
  const ship = game.ships[player.id];
  if (!ship) return { error: 'Join the run to fly.' };
  if (ship.out) return { error: 'Your ship is out of this run.' };
  if (action.type === 'hit') {
    if (now < ship.coverUntil) return { game };
    ship.shields -= 1;
    ship.coverUntil = now + COVER_MS;
    if (ship.shields <= 0) ship.out = true;
    if (!aliveShips(game).length) game.over = true;
    return { game, event: { type: 'hit', id: player.id, shields: ship.shields } };
  }
  if (action.type === 'collect') {
    const d = game.dust.find((x) => x.id === action.id);
    if (!d) return { game };
    const at = dustAt(d, now);
    if (Math.hypot(at.x - ship.x, at.y - ship.y) > DUST_REACH) return { game };
    game.dust = game.dust.filter((x) => x !== d);
    ship.dust += 1;
    return { game, event: { type: 'dust', id: d.id, by: player.id } };
  }
  return { error: 'That is not a move in this game.' };
}

// Somebody joins a run already on: a new ship near the bottom.
function addPlayer(game, player, { now }) {
  if (game.ships[player.id] && !game.ships[player.id].out) return game;
  game.ships[player.id] = newShip(player, Object.keys(game.ships).length, now);
  if (!game.flew.some((f) => f.id === player.id)) game.flew.push({ id: player.id, username: player.username });
  return game;
}

function removePlayer(game, id) {
  if (game.ships[id]) game.ships[id].out = true;
  if (!aliveShips(game).length) game.over = true;
  return game;
}

const round = (v) => Math.round(v);

// What a frame carries: the ships as short arrays, and the storms, bursts
// and stardust as the numbers every page works the sparks out from.
function frame(game) {
  return {
    w: game.w, h: game.h, now: game.now, start: game.start, sector: game.sector, over: game.over,
    ships: Object.entries(game.ships).map(([id, s]) => [Number(id), round(s.x), round(s.y), s.shields, s.out ? 1 : 0,
      s.coverUntil, s.seat, s.username, s.score]),
    storms: game.storms.map((s) => ({
      id: s.id, t0: s.t0, x: round(s.x), ys: round(s.ys), sway: round(s.sway), swayMs: round(s.swayMs), enter: s.enter,
      stay: round(s.stay), interval: s.interval, n: s.n, rot: s.rot, spread: s.spread, v: s.v, curve: s.curve,
      alt: s.alt, size: s.size, colour: s.colour, a0: s.a0,
    })),
    bursts: game.bursts.map((b) => [b.id, b.t, b.x, b.y, b.n, b.dx, b.a, b.spread, b.v, b.size, b.colour, b.gap]),
    dust: game.dust.map((d) => [d.id, d.x, d.y, d.t, d.v]),
  };
}

// Each pilot's own score: the highest first.
function result(game) {
  if (!game.over) return null;
  const ranked = game.flew
    .map((f) => ({ id: f.id, username: f.username, score: game.ships[f.id] ? game.ships[f.id].score : 0 }))
    .sort((a, b) => b.score - a.score);
  return ranked.map((r, i) => ({ ...r, place: i + 1 }));
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
  act,
  addPlayer,
  removePlayer,
  view: (game) => frame(game),
  frame,
  result,
  pulsarAt,
  dustAt,
  W,
  H,
  SHIELDS,
  MAX_SPEED,
  PATTERNS,
};
