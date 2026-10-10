// This app's API: the space game, played in the game room (game/room.js)
// by its rules (game/rules.js), with a live connection for every open page
// (game/live.js) that carries 20 frames a second while a run is on. It came
// from Homeroom's space game starter; the first version turns it into the
// game its creator described.
//
// server.js mounts routes() after the sign-in check (a write always has
// req.user; a read may come from a guest, who can watch but not fly), runs
// migrate() on boot and hands attach() the HTTP server for the live
// connection.

const { Room } = require('./game/room');
const live = require('./game/live');
const rules = require('./game/rules');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const room = new Room(rules);

async function migrate(pool) {
  await room.migrate(pool);
  // A staging preview gets a few past runs by obviously fake pilots for the
  // leaderboard; its reviewers join and launch a run of their own. Never
  // runs in production.
  if (IS_STAGING) {
    await room.seed(pool, {
      results: [
        { id: 900001, gameNo: 1, userId: 900001, username: 'staging-demo-ana', score: 180, place: 1 },
        { id: 900002, gameNo: 1, userId: 900002, username: 'staging-demo-user', score: 180, place: 1 },
        { id: 900003, gameNo: 2, userId: 900002, username: 'staging-demo-user', score: 90, place: 1 },
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
