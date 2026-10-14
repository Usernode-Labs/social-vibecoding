// This app's API: the board game, played in the game room (game/room.js)
// by its rules (game/rules.js), with a live connection for every open page
// (game/live.js). It came from Homeroom's board game starter; the first
// version turns it into the game its creator described.
//
// server.js mounts routes() after the sign-in check (a write always has
// req.user; a read may come from a guest, who can watch but not play), runs
// migrate() on boot and hands attach() the HTTP server for the live
// connection.

const { Room } = require('./game/room');
const live = require('./game/live');
const rules = require('./game/rules');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const room = new Room(rules);

async function migrate(pool) {
  await room.migrate(pool);
  // A staging preview gets a lobby with one obviously fake player already
  // in it, and a few past games for the leaderboard, so its checks and its
  // reviewers see a game about to start. Join and start it: a player who is
  // not here has their turns rolled for them. Never runs in production.
  if (IS_STAGING) {
    await room.seed(pool, {
      state: {
        phase: 'lobby',
        players: [{ id: 900001, username: 'staging-demo-ana' }],
        game: null,
        gameNo: 2,
        results: null,
      },
      results: [
        { id: 900001, gameNo: 1, userId: 900001, username: 'staging-demo-ana', score: 30, place: 1 },
        { id: 900002, gameNo: 1, userId: 900002, username: 'staging-demo-user', score: 22, place: 2 },
        { id: 900003, gameNo: 2, userId: 900002, username: 'staging-demo-user', score: 30, place: 1 },
        { id: 900004, gameNo: 2, userId: 900001, username: 'staging-demo-ana', score: 17, place: 2 },
      ],
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
