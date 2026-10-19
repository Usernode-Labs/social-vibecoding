'use strict';

// A staging preview listens before its workflow boot backfill, not after it
// (server.js backfillAfterListen, src/workflow/platform.ts startWorkflow's
// `backfillLater`). The backfill adopts what the preview's copied database
// holds and no machine does yet (some 80 proposals and a few governance
// rows, 1.2 to 1.5 s of every preview's start), and nothing a request does
// needs it first: these tests drive the requests that touch what it adopts
// before it has run, and the admin read that waits for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('server.js: a preview listens first and backfills once it does; production keeps its order', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.slice(server.indexOf('async function start() {'));
  const body = start.slice(0, start.indexOf('\n}\n'));
  const runtimeAt = body.indexOf("const backfillLater = !runsClusterMaintenance();");
  const startAt = body.indexOf(".startWorkflow(config, { loops: backfillLater, backfillLater });");
  const listenAt = body.indexOf('app.listen(config.port, () => {');
  const backfillAt = body.indexOf('if (backfillLater) backfillAfterListen();');
  assert.ok(runtimeAt > 0 && startAt > runtimeAt, 'the runtime starts, with its loops on a preview, before the listener');
  assert.ok(listenAt > startAt, 'the listener comes after the runtime');
  assert.ok(backfillAt > listenAt, 'the backfill runs in the listen callback');
  const callback = body.slice(listenAt, body.indexOf('\n  });\n', listenAt));
  assert.ok(callback.includes('if (backfillLater) backfillAfterListen();'), 'inside the listen callback, not before it');
  // Only one path runs the backfill on a process: the leader's (becomeLeader)
  // or a preview's. A preview never stands for election.
  assert.match(body, /if \(runsClusterMaintenance\(\)\) startProcessDuties\(\);/);
  assert.match(body, /if \(!runsClusterMaintenance\(\)\) \{\n {4}log\.info\('server', 'Leader duties skipped/);

  const platform = fs.readFileSync(path.join(ROOT, 'src/workflow/platform.ts'), 'utf8');
  const sw = platform.slice(platform.indexOf('export async function startWorkflow('));
  const swBody = sw.slice(0, sw.indexOf('\n}\n'));
  assert.match(swBody, /if \(opts\.loops && opts\.backfillLater\) await runtime\.start\(\{ loops: true \}\);\n {2}else if \(opts\.loops\) await startWorkflowLoops\(\);/,
    'with backfillLater the timers and services start, and the backfill does not');
});

test('backfillAfterListen logs the backfill when it ends, and stops the process when it fails', async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
  process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
  require('./platform-keys').setPlatformKeys();
  const origSetInterval = global.setInterval;
  const origSetTimeout = global.setTimeout;
  global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
  global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
  let backfillAfterListen;
  try {
    ({ backfillAfterListen } = require('../server'));
  } finally {
    global.setInterval = origSetInterval;
    global.setTimeout = origSetTimeout;
  }
  const kills = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => { kills.push([pid, signal]); return true; };
  try {
    let ran = 0;
    await backfillAfterListen({ startWorkflowLoops: async () => { ran += 1; } });
    assert.equal(ran, 1);
    assert.deepEqual(kills, [], 'a backfill that ends stops nothing');
    await backfillAfterListen({ startWorkflowLoops: async () => { throw new Error('database gone'); } });
    assert.deepEqual(kills, [[process.pid, 'SIGTERM']], 'a failed backfill ends the process through its drain');
  } finally {
    process.kill = realKill;
  }
});

