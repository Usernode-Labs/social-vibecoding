'use strict';

// One platform process for tests/processes-multi-postgres.test.js: the real
// registry (services/processes.js) and the real WebSocket bus
// (services/ws-bus.js) against the database named on the command line,
// driven by JSON lines on stdin and answering JSON lines on stdout.
//
// Commands: { id, op: 'hold' | 'release' | 'heldElsewhere' | 'holders' |
// 'refresh' | 'publish' | 'stop', kind?, ref?, data? }. Every answer
// carries the command's id; bus messages arrive as { type: 'bus', kind, data }.

const readline = require('node:readline');
const { Pool } = require('pg');
const processes = require('../../src/services/processes');
const wsBus = require('../../src/services/ws-bus');

const url = process.argv[2];
const pool = new Pool({ connectionString: url, max: 4 });
// As the platform's own pools: a dropped idle connection is replaced.
pool.on('error', () => {});
const releases = new Map();
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function main() {
  await processes.start({ pool, role: 'all' });
  let listening;
  const subscribed = new Promise((r) => { listening = r; });
  wsBus.start({
    pool,
    connectionString: url,
    onMessage: (m) => send({ type: 'bus', kind: m.kind, data: m.data }),
    onListening: () => listening(),
  });
  await subscribed;
  send({ type: 'ready', processId: processes.ID });

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    const reply = (value) => send({ type: 'reply', id: cmd.id, value });
    try {
      if (cmd.op === 'hold') {
        releases.set(`${cmd.kind}:${cmd.ref}`, processes.hold(cmd.kind, cmd.ref));
        await processes.flush();
        reply(true);
      } else if (cmd.op === 'release') {
        releases.get(`${cmd.kind}:${cmd.ref}`)?.();
        await processes.flush();
        reply(true);
      } else if (cmd.op === 'heldElsewhere') {
        reply(processes.heldElsewhere(cmd.kind, cmd.ref));
      } else if (cmd.op === 'refresh') {
        await processes.refreshMirror();
        reply(true);
      } else if (cmd.op === 'holders') {
        reply(await processes.holders(cmd.kind, cmd.ref));
      } else if (cmd.op === 'publish') {
        wsBus.publish(cmd.kind, null, cmd.data);
        reply(true);
      } else if (cmd.op === 'stop') {
        await processes.stop();
        await wsBus.stop();
        await pool.end();
        reply(true);
        process.exit(0);
      }
    } catch (err) {
      send({ type: 'reply', id: cmd.id, error: err.message });
    }
  }
}

main().catch((err) => {
  send({ type: 'fatal', error: err.message });
  process.exit(1);
});
