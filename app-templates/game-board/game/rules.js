// The board game's rules: a dice race. Everyone starts off the board; on
// your turn you roll and move that many squares. A shortcut jumps you ahead,
// a slide takes you back, a six rolls again, and the first to reach the last
// square wins. Somebody who is not here has their turn rolled for them, so a
// game never waits on an empty seat.
//
// Plain functions of the game's state, kept to the game room's contract
// (game/room.js): the room calls them, saves the state and sends each
// player the result. To make it a different board game, change these and
// the screen (public/app.js).

'use strict';

const SQUARES = 30;
// Where a square sends you: up a shortcut, or down a slide.
const SHORTCUTS = { 4: 12, 9: 18, 16: 24, 20: 27 };
const SLIDES = { 13: 6, 19: 11, 26: 17, 28: 22 };
// Somebody who is not here gets a moment, then their roll is made for them.
const AWAY_MS = 2500;
// Nobody's turn waits forever: after this, the room rolls for them too.
const TURN_MS = 45000;
const LOG_MAX = 8;

function clone(game) {
  return JSON.parse(JSON.stringify(game));
}

function currentId(game) {
  return game.order[game.turn % game.order.length];
}

function setup({ players, now }) {
  return {
    squares: SQUARES,
    shortcuts: SHORTCUTS,
    slides: SLIDES,
    order: players.map((p) => p.id),
    pieces: Object.fromEntries(players.map((p, seat) => [p.id, { username: p.username, pos: 0, seat }])),
    turn: 0,
    turnAt: now,
    rollNo: 0,
    lastMove: null,
    log: [],
    winner: null,
  };
}

function roll(game, id, { random, now }, forThem) {
  const g = clone(game);
  const piece = g.pieces[id];
  const die = 1 + Math.floor(random() * 6);
  const from = piece.pos;
  const landed = Math.min(SQUARES, from + die);
  let to = landed;
  let note = '';
  if (SHORTCUTS[landed]) { to = SHORTCUTS[landed]; note = `, took the shortcut to ${to}`; }
  else if (SLIDES[landed]) { to = SLIDES[landed]; note = `, slid down to ${to}`; }
  piece.pos = to;
  g.rollNo += 1;
  g.lastMove = { id, die, from, landed, to, rollNo: g.rollNo };
  const who = '@' + piece.username;
  let text = `${who} rolled ${die}${forThem ? ' (rolled for them)' : ''}: ${landed === SQUARES ? 'the finish' : `square ${landed}`}${note}`;
  if (to >= SQUARES) {
    g.winner = id;
    text += '. They win!';
  } else if (die === 6) {
    text += '. A six: roll again.';
  } else {
    g.turn = (g.turn + 1) % g.order.length;
  }
  g.turnAt = now;
  g.log = [{ text, rollNo: g.rollNo }].concat(g.log).slice(0, LOG_MAX);
  return g;
}

function act(game, action, ctx) {
  if (game.winner != null) return { error: 'This game is over.' };
  if (action.type !== 'roll') return { error: 'That is not a move in this game.' };
  if (currentId(game) !== ctx.player.id) return { error: 'It is not your turn yet.' };
  return { game: roll(game, ctx.player.id, ctx, false) };
}

// Every second: roll for somebody whose turn it is and who is not here, or
// who has let their turn run out.
function update(game, ctx) {
  if (game.winner != null || !game.order.length) return null;
  const id = currentId(game);
  const waited = ctx.now - game.turnAt;
  if ((!ctx.isOnline(id) && waited >= AWAY_MS) || waited >= TURN_MS) return roll(game, id, ctx, true);
  return null;
}

// Somebody left mid-game: their piece goes, and if it was their turn the
// next player's begins.
function removePlayer(game, id, ctx) {
  const g = clone(game);
  if (!g.order.includes(id)) return g;
  const current = currentId(g);
  const seat = g.order.indexOf(id);
  g.order.splice(seat, 1);
  delete g.pieces[id];
  if (!g.order.length) return g;
  if (current === id) {
    g.turn = seat % g.order.length;
    g.turnAt = ctx.now;
  } else {
    g.turn = g.order.indexOf(current);
  }
  return g;
}

// Over when somebody reached the last square: the winner first, then
// everyone by how far they got.
function result(game) {
  if (game.winner == null) return null;
  const ranked = game.order
    .map((id) => ({ id, username: game.pieces[id].username, score: game.pieces[id].pos }))
    .sort((a, b) => (a.id === game.winner ? -1 : b.id === game.winner ? 1 : b.score - a.score));
  return ranked.map((r, i) => ({ ...r, place: i + 1 }));
}

module.exports = {
  minPlayers: 1,
  maxPlayers: 6,
  leaderboard: 'wins',
  setup,
  act,
  update,
  removePlayer,
  result,
  SQUARES,
  SHORTCUTS,
  SLIDES,
};
