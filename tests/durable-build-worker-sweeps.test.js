'use strict';

// 14 Oct 2026 (#5162's follow-up): never evict a worker under a durable build.
//
// #5162 made ensureWorker keep a worker on an old image while a durable build
// holds its session (services/build-runs.js holdsSession: the session's
// workflow_owner set and its build still 'building'), and flagged a risk it
// did not test. When a release replaces a process, the draining process
// forgets its idle warm workers (server.js cleanup) and the new leader
// adopts them (sweepLeftWarmWorkers, which keeps a durable build's worker:
// adoptOrphanWorker). The new process's own sweeps could then stop the
// worker a DRAINING process's build is still using between its turns: the
// idle eviction (idle 10 minutes) and the auto-pause sweeper (idle minutes,
// then pauseSession destroys the worker). Slot eviction is pinned in
// tests/session-lifecycle.test.js.
//
// Pinned here: each sweep skips a session a durable build holds, says so
// once, and still acts on every other; a read that fails is today's
// behaviour. The holds are answered by the real holdsSession, from a pool
// that plays the database.
//
// Run with: node --test tests/durable-build-worker-sweeps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── The database, as holdsSession and the auto-pause pass read it ────────
const db = { held: new Set(), fail: false, idle: [] };
const calls = [];
const pool = {
  async query(sql, params) {
    calls.push({ sql: String(sql), params });
    if (/FROM wf_instances w/.test(sql)) {
      if (db.fail) throw new Error('connection reset');
      return { rows: [{ held: db.held.has(Number(params[0])) }] };
    }
    if (/SELECT id FROM chat_sessions\s+WHERE status = 'active'\s+AND active_turn IS NULL/.test(sql)) {
      return { rows: db.idle.map((id) => ({ id })) };
    }
    return { rows: [] };
  },
};
require('../src/db/pool').getPool = () => pool;

// ── The worker registry ─────────────────────────────────────────────────
let registry = [];
const evicted = [];
const forgotten = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  warmRegistrySnapshot: () => registry.map((m) => ({ ...m })),
  evictWorker: async (sessionId) => { evicted.push(Number(sessionId)); },
  forgetWorker: (sessionId) => { forgotten.push(Number(sessionId)); },
};

// Pausing a session (it destroys the worker): recorded, not run.
const lifecycle = require('../src/services/session-lifecycle');
const paused = [];
lifecycle.pauseSession = async ({ sessionId, reason }) => {
  paused.push([Number(sessionId), reason]);
  return { paused: true };
};

// What the sweeps say.
const logger = require('../src/services/logger');
const said = [];
const realInfo = logger.info;
logger.info = (scope, message, fields) => { said.push([message, fields?.sessionId]); };

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let server;
try { server = require('../server'); } finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}
test.after(() => { logger.info = realInfo; });

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const idleFor = (min) => NOW - min * MIN;

function reset({ held = [], fail = false, idle = [] } = {}) {
  db.held = new Set(held);
  db.fail = fail;
  db.idle = idle;
  calls.length = 0;
  evicted.length = 0;
  forgotten.length = 0;
  paused.length = 0;
  said.length = 0;
}
const asked = () => calls.filter((c) => /FROM wf_instances w/.test(c.sql)).map((c) => Number(c.params[0]));

test('the idle eviction leaves a worker a durable build holds, and evicts the others', async () => {
  registry = [
    { sessionId: 41, containerName: 'usernode-worker-41', lastUsedMs: idleFor(25) }, // a draining build's, between turns
    { sessionId: 42, containerName: 'usernode-worker-42', lastUsedMs: idleFor(25) }, // nobody's: evicted
    { sessionId: 43, containerName: 'usernode-worker-43', lastUsedMs: idleFor(2) }, // not idle long enough
    { sessionId: 44, containerName: 'usernode-worker-44', lastUsedMs: idleFor(25), inFlight: true },
  ];
  reset({ held: [41, 43, 44] });
  await server.sweepIdleWarmWorkers({ now: NOW });
  assert.deepEqual(evicted, [42]);
  assert.deepEqual(asked(), [41, 42], 'asked only of a worker it would otherwise evict');
  assert.deepEqual(said.filter(([m]) => /durable build/.test(m)),
    [['Not evicting an idle warm worker: a durable build holds its session', 41]]);
  // Said once while it stays held, not on every pass.
  said.length = 0;
  await server.sweepIdleWarmWorkers({ now: NOW + MIN });
  assert.deepEqual(said.filter(([m]) => /durable build/.test(m)), []);
  assert.deepEqual(evicted, [42, 42]);
  // Its build ended: the next pass evicts it as any idle worker.
  reset({ held: [] });
  await server.sweepIdleWarmWorkers({ now: NOW + 2 * MIN });
  assert.deepEqual(evicted.sort(), [41, 42]);
});

test('the idle eviction: a read that fails evicts as before', async () => {
  registry = [
    { sessionId: 41, containerName: 'usernode-worker-41', lastUsedMs: idleFor(25) },
    { sessionId: 42, containerName: 'usernode-worker-42', lastUsedMs: idleFor(25) },
  ];
  reset({ held: [41], fail: true });
  await server.sweepIdleWarmWorkers({ now: NOW });
  assert.deepEqual(evicted, [41, 42]);
});

test('the auto-pause sweeper leaves a session a durable build holds, and pauses the others', async () => {
  reset({ held: [51], idle: [51, 52, 53] });
  assert.deepEqual(await server.autoPauseIdleSessions(pool, { idleMs: 5 * MIN }), [52, 53]);
  assert.deepEqual(paused, [[52, 'auto-idle'], [53, 'auto-idle']]);
  assert.deepEqual(asked(), [51, 52, 53]);
  assert.deepEqual(said.filter(([m]) => /durable build/.test(m)), [['Not auto-pausing an idle session: a durable build holds it', 51]]);
  // Its own query is unchanged: only idle, active sessions with no turn.
  const select = calls.find((c) => /SELECT id FROM chat_sessions/.test(c.sql));
  assert.match(select.sql, /status = 'active'\s+AND active_turn IS NULL/);
  assert.deepEqual(select.params, [5 * MIN, false]);
  // A read that fails pauses as before.
  reset({ held: [51], idle: [51, 52], fail: true });
  assert.deepEqual(await server.autoPauseIdleSessions(pool, { idleMs: 5 * MIN }), [51, 52]);
});

test('every sweep that stops a worker unasked asks first; adoption already keeps a durable build\'s', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The interval runs the pass, and the auto-pause sweeper's first pass is the helper.
  assert.match(src, /sweeperHandle = setInterval\(async \(\) => \{\s*if \(lifecycle\.isShuttingDown\(\)\) return;\s*await sweepIdleWarmWorkers\(\)\.catch/);
  assert.match(src, /await autoPauseIdleSessions\(pool, \{\s*idleMs: config\.sessionAutopauseIdleMs, exemptFixtures: process\.env\.USERNODE_ENV === 'staging',\s*\}\);/);
  assert.match(src, /function heldByDurableBuild\(sessionId, pool = getPool\(config\)\) \{\s*return require\('\.\/src\/services\/build-runs'\)\.holdsSession\(pool, sessionId\);/);
  // The left-behind sweep adopts through adoptOrphanWorker, which keeps a
  // durable build's worker as it is (tests/homeroom-bot-restart-recovery.test.js).
  const adopt = src.slice(src.indexOf('async function adoptOrphanWorker('));
  assert.match(adopt.slice(0, 6000), /if \(session\.workflow_owned\) \{\s*if \(containerState === 'running'\) worker\.adoptWarmWorker\(sessionId, containerName\);/);
  // A draining process only forgets its idle workers; it stops none.
  const cleanup = src.slice(src.indexOf('async function cleanup()'));
  assert.match(cleanup.slice(0, 4000), /if \(!meta\.inFlight && !meta\.bootstrapping\) worker\.forgetWorker\(meta\.sessionId\);/);
});
