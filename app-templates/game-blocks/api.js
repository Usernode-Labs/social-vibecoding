// This app's API: the block world, kept by the game room (game/room.js) as
// an always-on game with its rules in game/rules.js, and a live connection
// for every open page (game/live.js). The whole world is the room's state,
// saved in game_rooms. It came from Homeroom's 3D blocks starter; the first
// version turns it into the game its creator described.
//
// server.js mounts routes() after the sign-in check (a write always has
// req.user; a read may come from a guest, who can look around but not
// build), runs migrate() on boot and hands attach() the HTTP server for the
// live connection.

const { Room } = require('./game/room');
const live = require('./game/live');
const rules = require('./game/rules');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const room = new Room(rules);

// Staging demo: a small house, a tree and a path in the middle of the
// world, as if two people had started building. Blocks are indexes into
// public/app.js BLOCKS.
function demoWorld() {
  const blocks = {};
  const put = (x, y, z, c) => { blocks[rules.key(x, y, z)] = c; };
  const STONE = 2;
  const WOOD = 3;
  const PLANKS = 4;
  const LEAVES = 5;
  const BRICK = 7;
  const GLASS = 8;
  for (let x = 15; x <= 21; x++) {
    for (let z = 15; z <= 20; z++) {
      const wall = x === 15 || x === 21 || z === 15 || z === 20;
      for (let y = 0; y <= 2; y++) {
        const door = z === 20 && x === 18 && y <= 1;
        const pane = y === 1 && (((x === 15 || x === 21) && (z === 17 || z === 18)) || (z === 20 && (x === 16 || x === 20)));
        if (wall && !door) put(x, y, z, pane ? GLASS : BRICK);
      }
    }
  }
  // A roof that steps in.
  for (let step = 0; step < 3; step++) {
    for (let x = 14 + step; x <= 22 - step; x++) {
      for (let z = 14 + step; z <= 21 - step; z++) put(x, 3 + step, z, PLANKS);
    }
  }
  for (let y = 0; y <= 3; y++) put(27, y, 22, WOOD);
  for (let x = 26; x <= 28; x++) for (let z = 21; z <= 23; z++) for (let y = 4; y <= 5; y++) put(x, y, z, LEAVES);
  put(27, 6, 22, LEAVES);
  for (let z = 21; z <= 39; z++) put(18, 0, z, STONE);
  return { size: rules.SIZE, blocks, count: Object.keys(blocks).length, builders: {} };
}

async function migrate(pool) {
  await room.migrate(pool);
  // A staging preview starts with the demo world, so its checks and its
  // reviewers have something to look at and build on. Never runs in
  // production, where the world starts empty.
  if (IS_STAGING) {
    await room.seed(pool, {
      state: { phase: 'playing', players: [], game: demoWorld(), gameNo: 1, results: null },
    });
  }
  await room.load(pool);
}

function routes(app) {
  room.routes(app);
}

function attach(server) {
  return live.attach(server, room);
}

module.exports = { migrate, routes, attach };
