// The block world's rules: one world everyone builds in together, always
// on. Place a block on the ground or on another block, or take one away;
// everyone sees it at once. Each builder flies around the world in first
// person, and where everyone is shows on everyone else's screen, so you can
// see who is building what.
//
// Kept to the game room's contract (game/room.js) as an always-on game
// (`open`): no lobby, no turns and no end. A placed or removed block is an
// `event` the room sends everyone, instead of the whole world again.

'use strict';

const SIZE = { x: 40, y: 20, z: 40 };
// How many kinds of block there are (their names and colours are in
// public/app.js BLOCKS, in this order).
const BLOCKS = 12;
const MAX_BLOCKS = 20000;
// A builder who has not moved for this long stops showing.
const BUILDER_MS = 10000;
// How far outside the world a builder may fly (the camera, not blocks).
const MARGIN = 12;

const key = (x, y, z) => `${x},${y},${z}`;

function inWorld(x, y, z) {
  return [x, y, z].every(Number.isInteger) && x >= 0 && x < SIZE.x && y >= 0 && y < SIZE.y && z >= 0 && z < SIZE.z;
}

function setup() {
  return { size: SIZE, blocks: {}, count: 0, builders: {} };
}

function act(game, action, { player }) {
  const { x, y, z } = action;
  if (!inWorld(x, y, z)) return { error: 'That is outside the world.' };
  const at = key(x, y, z);
  if (action.type === 'place') {
    const c = action.c;
    if (!Number.isInteger(c) || c < 0 || c >= BLOCKS) return { error: 'Pick a block to build with.' };
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

// Where a builder is: their camera's position and which way they face, and
// the block in their hand.
function input(game, player, controls, { now }) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = n(controls.x);
  const y = n(controls.y);
  const z = n(controls.z);
  game.builders = game.builders || {};
  const inside = x != null && y != null && z != null &&
    x >= -MARGIN && x <= SIZE.x + MARGIN && y >= 0 && y <= SIZE.y + MARGIN && z >= -MARGIN && z <= SIZE.z + MARGIN;
  if (inside) {
    game.builders[player.id] = {
      username: player.username, x, y, z, yaw: n(controls.yaw) || 0,
      c: Number.isInteger(controls.c) && controls.c >= 0 && controls.c < BLOCKS ? controls.c : 0, at: now,
    };
  } else {
    delete game.builders[player.id];
  }
  return game;
}

const tenth = (v) => Math.round(v * 10) / 10;

function builders(game) {
  const now = Date.now();
  return Object.entries(game.builders || {})
    .filter(([, b]) => now - b.at < BUILDER_MS)
    .map(([id, b]) => [Number(id), b.username, tenth(b.x), tenth(b.y), tenth(b.z), Math.round(b.yaw * 100) / 100, b.c]);
}

// A frame: where everyone is, as [id, username, x, y, z, yaw, block].
function frame(game) {
  return { builders: builders(game) };
}

// The whole world, as [x, y, z, block] rows, and where everyone is.
function view(game) {
  return {
    size: game.size,
    count: game.count,
    blocks: Object.entries(game.blocks).map(([k, c]) => k.split(',').map(Number).concat(c)),
    builders: builders(game),
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
  BLOCKS,
  MAX_BLOCKS,
  key,
};
