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

// Staging demo: a small house, a tree and a path, as if two people had
// started building. Colours are palette indexes (public/app.js PALETTE).
function demoWorld() {
  const blocks = {};
  const put = (x, y, z, c) => { blocks[rules.key(x, y, z)] = c; };
  const BRICK = 3;
  const WOOD = 2;
  const LEAVES = 0;
  const STONE = 1;
  const GLASS = 5;
  for (let x = 6; x <= 11; x++) {
    for (let z = 6; z <= 10; z++) {
      const wall = x === 6 || x === 11 || z === 6 || z === 10;
      for (let y = 0; y <= 2; y++) {
        const door = z === 6 && (x === 8 || x === 9) && y <= 1;
        const pane = y === 1 && ((x === 6 || x === 11) && z === 8);
        if (wall && !door) put(x, y, z, pane ? GLASS : BRICK);
      }
      put(x, 3, z, WOOD);
    }
  }
  for (let y = 0; y <= 3; y++) put(20, y, 12, WOOD);
  for (let x = 19; x <= 21; x++) for (let z = 11; z <= 13; z++) for (let y = 4; y <= 5; y++) put(x, y, z, LEAVES);
  put(20, 6, 12, LEAVES);
  for (let z = 0; z <= 5; z++) put(8, 0, z, STONE);
  return { size: rules.SIZE, blocks, count: Object.keys(blocks).length, cursors: {} };
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
