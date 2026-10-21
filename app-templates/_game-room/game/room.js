// The game room: who is playing, the game's phases and its state, kept in
// Postgres and sent to every player live (game/live.js) or on request (the
// /api/room routes below). It came from Homeroom's game starters; change it
// when the game needs something it does not do, and keep the contract below.
//
// The whole project plays in one room, "main". The room knows nothing about
// the game: game/rules.js does, so a different game is a different rules.js
// and screen, and the room stays as it is.
//
// Phases: lobby (people join; anyone who joined starts a game) -> playing ->
// over (the results are saved and the leaderboard moves) -> lobby again on
// "Play again", with the same players. An always-on game (rules.open) has no
// lobby: it is always playing and anyone signed in can play.
//
// THE RULES CONTRACT. game/rules.js exports:
//   minPlayers, maxPlayers  how many can play one game
//   open        true: always on, no lobby and no turns (a shared world)
//   dropIn      true: people can join a game that is already on
//   live        true: the room calls tick() every tickMs and sends frames
//   tickMs      a live game's tick, in milliseconds
//   setup({ players, random, now, extra }) -> the game's state (plain JSON),
//               or { error } when it cannot start ("Write a question first")
//   act(game, action, { player, random, now }) -> { game, event? } or { error }
//               a move, checked here, on the server. `event` (optional) is
//               sent to everyone instead of a whole new view: a block placed.
//   update?(game, { now, random, isOnline }) -> a new game, or null for no
//               change. Called every second while a game is on: turn timers,
//               playing for somebody who left.
//   tick?(game, dtMs, { now, random }) -> game    (live games)
//   input?(game, player, input, { now }) -> game  a player's controls, many
//               times a second; not saved, not checked as a move
//   frame?(game) -> what a live frame carries (default: view(game, null))
//   addPlayer?(game, player) -> game, removePlayer?(game, playerId) -> game
//   view?(game, viewerId) -> what that viewer may see (hide the answer)
//   result(game) -> null while it goes on; when it is over,
//               [{ id, username, score, place }] (place 1 won)
//   leaderboard 'wins' (most games won) or 'best' (best score)
//   prepare?(pool) -> data setup() needs, read before a game starts
//
// Players are { id, username } from the platform's sign-in (req.user).
// Time is Date.now(): games run on real time, not a preview's req.now.

'use strict';

const { EventEmitter } = require('events');

const ROOM_ID = 'main';
const SAVE_DELAY_MS = 400;
// Somebody asking over plain requests (no live connection) counts as here
// for this long after they last asked.
const HERE_MS = 15000;
const UPDATE_MS = 1000;

function httpError(status, error) {
  return { status, error };
}

class Room extends EventEmitter {
  constructor(rules) {
    super();
    this.setMaxListeners(0);
    this.rules = rules;
    this.pool = null;
    this.state = null;
    this.version = 0;
    this.leaders = [];
    this.here = new Map(); // user id -> { username, sockets, at }
    this.timers = { save: null, update: null, tick: null, frame: null };
    this.lastTick = 0;
    this.inputsMoved = false;
  }

  now() {
    return Date.now();
  }

  random() {
    return Math.random();
  }

  /** The room's tables, made idempotently on every boot. */
  async migrate(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_rooms (
        id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_results (
        id SERIAL PRIMARY KEY,
        room_id TEXT NOT NULL,
        game_no INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username VARCHAR(255) NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        place INTEGER NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS game_results_room_idx ON game_results (room_id, user_id)');
  }

  /**
   * A staging preview's starting point: the room as `state` and a few past
   * results, owned by obviously fake people. Idempotent; never in production
   * (api.js calls it behind IS_STAGING).
   */
  async seed(pool, { state = null, results = [] } = {}) {
    if (state) {
      await pool.query(
        'INSERT INTO game_rooms (id, state, version) VALUES ($1, $2, 1) ON CONFLICT (id) DO NOTHING',
        [ROOM_ID, JSON.stringify(state)]
      );
    }
    for (const r of results) {
      await pool.query(
        `INSERT INTO game_results (id, room_id, game_no, user_id, username, score, place)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [r.id, ROOM_ID, r.gameNo, r.userId, r.username, r.score, r.place]
      );
    }
    if (results.length) {
      await pool.query(`SELECT setval(pg_get_serial_sequence('game_results', 'id'), GREATEST((SELECT MAX(id) FROM game_results), 1))`);
    }
  }

  fresh() {
    const open = !!this.rules.open;
    return {
      phase: open ? 'playing' : 'lobby',
      players: [],
      game: open ? this.rules.setup({ players: [], random: () => this.random(), now: this.now(), extra: null }) : null,
      gameNo: open ? 1 : 0,
      results: null,
    };
  }

  /** Read the room (or start it), the leaderboard, and start its clocks. */
  async load(pool) {
    this.pool = pool;
    const { rows } = await pool.query('SELECT state, version FROM game_rooms WHERE id = $1', [ROOM_ID]);
    if (rows.length) {
      this.state = rows[0].state;
      this.version = rows[0].version;
    } else {
      this.state = this.fresh();
      await pool.query('INSERT INTO game_rooms (id, state, version) VALUES ($1, $2, 0) ON CONFLICT (id) DO NOTHING', [ROOM_ID, JSON.stringify(this.state)]);
    }
    // A live game does not survive a restart: its moment has passed.
    if (this.rules.live && this.state.phase === 'playing' && !this.rules.open) {
      this.state.phase = 'lobby';
      this.state.game = null;
      this.saveSoon();
    }
    await this.readLeaders();
    this.startClocks();
  }

  // ── Who is here ───────────────────────────────────────────────────────

  isHere(id) {
    const h = this.here.get(id);
    return !!h && (h.sockets > 0 || this.now() - h.at < HERE_MS);
  }

  /** Somebody asked over a plain request: they are here for a while. */
  touch(user) {
    if (!user) return;
    const h = this.here.get(user.id) || { username: user.username, sockets: 0, at: 0 };
    const was = this.isHere(user.id);
    h.at = this.now();
    h.username = user.username;
    this.here.set(user.id, h);
    if (!was) this.changed({ save: false });
  }

  /** A live connection opened (game/live.js); guests are not counted. */
  connect(user) {
    if (!user) return;
    const h = this.here.get(user.id) || { username: user.username, sockets: 0, at: 0 };
    h.sockets += 1;
    h.at = this.now();
    this.here.set(user.id, h);
    if (h.sockets === 1) this.changed({ save: false });
  }

  disconnect(user) {
    if (!user) return;
    const h = this.here.get(user.id);
    if (!h) return;
    h.sockets = Math.max(0, h.sockets - 1);
    h.at = this.now();
    if (!h.sockets) this.changed({ save: false });
  }

  // ── What a viewer sees ────────────────────────────────────────────────

  playerOf(id) {
    return this.state.players.find((p) => p.id === id) || null;
  }

  viewFor(viewer) {
    const st = this.state;
    const id = viewer ? viewer.id : null;
    const watching = [];
    for (const [uid, h] of this.here) {
      if (this.isHere(uid) && !this.playerOf(uid)) watching.push({ id: uid, username: h.username });
    }
    return {
      version: this.version,
      // The server's clock, so a page can count down a deadline in the game.
      now: this.now(),
      phase: st.phase,
      gameNo: st.gameNo,
      players: st.players.map((p) => ({ id: p.id, username: p.username, here: this.isHere(p.id) })),
      watching,
      you: viewer ? { id, username: viewer.username, joined: !!this.playerOf(id) } : null,
      game: st.game == null ? null : (this.rules.view ? this.rules.view(st.game, id) : st.game),
      results: st.results,
      leaders: this.leaders,
      rules: {
        minPlayers: this.rules.minPlayers || 1,
        maxPlayers: this.rules.maxPlayers || 8,
        open: !!this.rules.open,
        dropIn: !!this.rules.dropIn,
        live: !!this.rules.live,
        leaderboard: this.rules.leaderboard || null,
      },
    };
  }

  // ── Changes ───────────────────────────────────────────────────────────

  /** Something everyone should see: a new version, sent out, saved soon. */
  changed({ save = true } = {}) {
    this.version += 1;
    if (save) this.saveSoon();
    this.emit('change');
    return { ok: true };
  }

  saveSoon() {
    if (this.timers.save || !this.pool) return;
    this.timers.save = setTimeout(() => {
      this.timers.save = null;
      this.save().catch((err) => console.error('[game] save failed: ' + err.message));
    }, SAVE_DELAY_MS);
    this.timers.save.unref?.();
  }

  async save() {
    await this.pool.query(
      'UPDATE game_rooms SET state = $2, version = $3, updated_at = NOW() WHERE id = $1',
      [ROOM_ID, JSON.stringify(this.state), this.version]
    );
  }

  ctx(player = null) {
    return {
      player,
      now: this.now(),
      random: () => this.random(),
      isOnline: (id) => this.isHere(id),
    };
  }

  join(user) {
    const st = this.state;
    if (this.rules.open || this.playerOf(user.id)) return { ok: true };
    if (st.phase === 'playing' && !this.rules.dropIn) return httpError(409, 'A game is on. You can join the next one.');
    if (st.players.length >= (this.rules.maxPlayers || 8)) return httpError(409, 'This game is full.');
    const player = { id: user.id, username: user.username };
    st.players.push(player);
    if (st.phase === 'playing' && this.rules.addPlayer) st.game = this.rules.addPlayer(st.game, player, this.ctx(player));
    return this.changed();
  }

  leave(user) {
    const st = this.state;
    if (this.rules.open || !this.playerOf(user.id)) return { ok: true };
    st.players = st.players.filter((p) => p.id !== user.id);
    if (st.phase === 'playing') {
      if (this.rules.removePlayer) st.game = this.rules.removePlayer(st.game, user.id, this.ctx());
      if (!st.players.length && !this.rules.result(st.game)) {
        // Everybody left a game that has no result without them (a race
        // nobody won): it is abandoned. A game that is over once its last
        // player goes (a team's run) keeps its results, below.
        st.phase = 'lobby';
        st.game = null;
        this.stopClocks();
      } else {
        this.checkOver();
      }
    }
    return this.changed();
  }

  async start(user) {
    const st = this.state;
    if (this.rules.open) return { ok: true };
    if (st.phase === 'playing') return httpError(409, 'A game is already on.');
    if (!this.playerOf(user.id)) return httpError(409, 'Join the game first.');
    const min = this.rules.minPlayers || 1;
    if (st.players.length < min) return httpError(409, `It takes at least ${min} players.`);
    const extra = this.rules.prepare ? await this.rules.prepare(this.pool) : null;
    // Somebody else may have started it while that was read.
    if (st.phase === 'playing') return { ok: true };
    const game = this.rules.setup({ players: st.players.slice(), random: () => this.random(), now: this.now(), extra });
    if (game && game.error) return httpError(409, game.error);
    st.phase = 'playing';
    st.game = game;
    st.gameNo += 1;
    st.results = null;
    this.lastTick = this.now();
    this.startClocks();
    return this.changed();
  }

  act(user, action) {
    const st = this.state;
    if (st.phase !== 'playing') return httpError(409, 'No game is on right now.');
    let player = this.playerOf(user.id);
    if (!player && this.rules.open) player = { id: user.id, username: user.username };
    if (!player) return httpError(409, 'You are watching this game. Join the next one to play.');
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return httpError(400, 'That is not a move.');
    const out = this.rules.act(st.game, action, this.ctx(player));
    if (!out || out.error) return httpError(409, (out && out.error) || 'That move is not allowed.');
    st.game = out.game;
    if (out.event) {
      // A small change everyone applies themselves, instead of a whole view.
      this.version += 1;
      this.saveSoon();
      this.emit('event', out.event);
    } else {
      this.changed();
    }
    this.checkOver();
    return { ok: true };
  }

  input(user, input) {
    const st = this.state;
    if (st.phase !== 'playing' || !this.rules.input || !input || typeof input !== 'object') return { ok: true };
    const player = this.playerOf(user.id) || (this.rules.open ? { id: user.id, username: user.username } : null);
    if (!player) return { ok: true };
    st.game = this.rules.input(st.game, player, input, this.ctx(player));
    this.inputsMoved = true;
    return { ok: true };
  }

  again(user) {
    const st = this.state;
    if (this.rules.open) return { ok: true };
    if (st.phase !== 'over') return { ok: true };
    st.phase = 'lobby';
    st.game = null;
    if (!this.playerOf(user.id)) st.players.push({ id: user.id, username: user.username });
    return this.changed();
  }

  checkOver() {
    const st = this.state;
    if (st.phase !== 'playing' || this.rules.open) return;
    const results = this.rules.result(st.game);
    if (!results) return;
    st.phase = 'over';
    st.results = results;
    this.stopClocks();
    this.startClocks();
    this.changed();
    this.record(st.gameNo, results).catch((err) => console.error('[game] results not saved: ' + err.message));
  }

  async record(gameNo, results) {
    if (!this.pool) return;
    for (const r of results) {
      await this.pool.query(
        `INSERT INTO game_results (room_id, game_no, user_id, username, score, place, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ROOM_ID, gameNo, r.id, r.username, Math.round(r.score || 0), r.place, new Date(this.now())]
      );
    }
    await this.readLeaders();
    this.changed({ save: false });
  }

  async readLeaders() {
    if (!this.pool || !this.rules.leaderboard) { this.leaders = []; return; }
    const order = this.rules.leaderboard === 'best' ? 'best DESC, wins DESC' : 'wins DESC, best DESC';
    const { rows } = await this.pool.query(
      `SELECT MAX(username) AS username, COUNT(*)::int AS played,
              COUNT(*) FILTER (WHERE place = 1)::int AS wins, MAX(score)::int AS best
         FROM game_results WHERE room_id = $1
        GROUP BY user_id ORDER BY ${order}, played DESC LIMIT 10`,
      [ROOM_ID]
    );
    this.leaders = rows;
  }

  // ── Clocks ────────────────────────────────────────────────────────────

  startClocks() {
    const st = this.state;
    if (st.phase !== 'playing') return;
    if (this.rules.update && !this.timers.update) {
      this.timers.update = setInterval(() => this.runUpdate(), UPDATE_MS);
      this.timers.update.unref?.();
    }
    if (this.rules.live && this.rules.tick && !this.timers.tick) {
      this.lastTick = this.now();
      this.timers.tick = setInterval(() => this.runTick(), this.rules.tickMs || 50);
      this.timers.tick.unref?.();
    }
    // An always-on game with live controls (cursors) and no tick sends a
    // frame when somebody's controls moved.
    if (this.rules.input && !this.rules.tick && !this.timers.frame) {
      this.timers.frame = setInterval(() => {
        if (!this.inputsMoved) return;
        this.inputsMoved = false;
        this.emit('frame', this.frame());
      }, this.rules.frameMs || 200);
      this.timers.frame.unref?.();
    }
  }

  stopClocks() {
    for (const k of ['update', 'tick', 'frame']) {
      if (this.timers[k]) clearInterval(this.timers[k]);
      this.timers[k] = null;
    }
  }

  runUpdate() {
    if (this.state.phase !== 'playing') return;
    try {
      const next = this.rules.update(this.state.game, this.ctx());
      if (next) {
        this.state.game = next;
        this.changed();
        this.checkOver();
      }
    } catch (err) {
      console.error('[game] update failed: ' + err.message);
    }
  }

  runTick() {
    if (this.state.phase !== 'playing') return;
    const now = this.now();
    const dt = Math.min(250, now - this.lastTick);
    this.lastTick = now;
    try {
      this.state.game = this.rules.tick(this.state.game, dt, this.ctx());
      this.emit('frame', this.frame());
      this.checkOver();
    } catch (err) {
      console.error('[game] tick failed: ' + err.message);
    }
  }

  frame() {
    const g = this.state.game;
    return this.rules.frame ? this.rules.frame(g) : (this.rules.view ? this.rules.view(g, null) : g);
  }

  close() {
    this.stopClocks();
    if (this.timers.save) {
      clearTimeout(this.timers.save);
      this.timers.save = null;
      return this.save().catch(() => {});
    }
    return Promise.resolve();
  }

  // ── Plain requests: the same room for a page with no live connection ──

  routes(app) {
    const fail = (res, err) => {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
    };
    app.get('/api/room', (req, res) => {
      try {
        this.touch(req.user);
        res.json(this.viewFor(req.user || null));
      } catch (err) {
        fail(res, err);
      }
    });
    const write = (fn) => async (req, res) => {
      if (!req.user) return res.status(401).json({ error: 'account_required' });
      try {
        this.touch(req.user);
        const out = await fn(req.user, req.body || {});
        if (out && out.error) return res.status(out.status || 409).json({ error: out.error });
        res.json(this.viewFor(req.user));
      } catch (err) {
        fail(res, err);
      }
    };
    app.post('/api/room/join', write((user) => this.join(user)));
    app.post('/api/room/leave', write((user) => this.leave(user)));
    app.post('/api/room/start', write((user) => this.start(user)));
    app.post('/api/room/again', write((user) => this.again(user)));
    app.post('/api/room/act', write((user, body) => this.act(user, body.action)));
    // Controls answer with nothing: they come many times a second.
    app.post('/api/room/input', (req, res) => {
      if (!req.user) return res.status(401).json({ error: 'account_required' });
      this.touch(req.user);
      this.input(req.user, req.body && req.body.input);
      res.status(204).end();
    });
  }
}

module.exports = { Room, ROOM_ID };
