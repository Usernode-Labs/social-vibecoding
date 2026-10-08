// The block world's rules: one world everyone builds in together, always
// on. Place a block of a colour on the ground or on another block, or take
// one away; everyone sees it at once. Where each builder is pointing shows
// on everyone else's screen, so you can see who is building what.
//
// Kept to the game room's contract (game/room.js) as an always-on game
// (`open`): no lobby, no turns and no end. A placed or removed block is an
// `event` the room sends everyone, instead of the whole world again.

'use strict';

const SIZE = { x: 32, y: 16, z: 32 };
// How many colours the palette has (their colours are in public/app.js).
const COLOURS = 10;
const MAX_BLOCKS = 20000;
// A builder who has not pointed anywhere for this long stops showing.
const CURSOR_MS = 10000;

const key = (x, y, z) => `${x},${y},${z}`;

function inWorld(x, y, z) {
  return [x, y, z].every(Number.isInteger) && x >= 0 && x < SIZE.x && y >= 0 && y < SIZE.y && z >= 0 && z < SIZE.z;
}

function setup() {
  return { size: SIZE, blocks: {}, count: 0, cursors: {} };
}

function act(game, action, { player }) {
  const { x, y, z } = action;
  if (!inWorld(x, y, z)) return { error: 'That is outside the world.' };
  const at = key(x, y, z);
  if (action.type === 'place') {
    const c = action.c;
    if (!Number.isInteger(c) || c < 0 || c >= COLOURS) return { error: 'Pick a colour.' };
    if (game.blocks[at] != null) return { error: 'There is a block there already.' };
    if (game.count >= MAX_BLOCKS) return { error: 'The world is full. Take some blocks away first.' };
    game.blocks[at] = c;
    game.count += 1;
    return { game, event: { type: 'place', x, y, z, c, by: player.username } };
  }
  if (action.type === 'remove') {
    if (game.blocks[at] == null) return { error: 'There is no block there.' };
    delete game.blocks[at];
    game.count -= 1;
    return { game, event: { type: 'remove', x, y, z, by: player.username } };
  }
  return { error: 'That is not a move in this game.' };
}

// Where a builder is pointing: a cell and their colour, or nothing.
function input(game, player, controls, { now }) {
  if (controls && inWorld(controls.x, controls.y, controls.z)) {
    game.cursors[player.id] = {
      username: player.username, x: controls.x, y: controls.y, z: controls.z,
      c: Number.isInteger(controls.c) ? controls.c : 0, erase: controls.erase === true, at: now,
    };
  } else {
    delete game.cursors[player.id];
  }
  return game;
}

function frame(game) {
  const now = Date.now();
  return {
    cursors: Object.entries(game.cursors)
      .filter(([, c]) => now - c.at < CURSOR_MS)
      .map(([id, c]) => [Number(id), c.username, c.x, c.y, c.z, c.c, c.erase ? 1 : 0]),
  };
}

// The whole world, as [x, y, z, colour] rows.
function view(game) {
  return {
    size: game.size,
    count: game.count,
    blocks: Object.entries(game.blocks).map(([k, c]) => k.split(',').map(Number).concat(c)),
  };
}

module.exports = {
  open: true,
  frameMs: 150,
  leaderboard: null,
  setup,
  act,
  input,
  frame,
  view,
  result: () => null,
  SIZE,
  COLOURS,
  MAX_BLOCKS,
  key,
};
