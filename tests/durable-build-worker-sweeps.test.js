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
// idle eviction (idle 10 minutes) and the idle pause (idle minutes, then the
// pause destroys the worker). The idle pause is the proposal machine's
// IdleCheck now (src/workflow/proposal/machine.ts), which reads the build's
// hold under the session's lock with everything else it decides on; slot
// eviction is the same machine's Pause guard (P8 in
// tests/workflow-proposal-postgres.test.js).
//
// Pinned here: the idle eviction skips a session a durable build holds, says
// so once, and still acts on every other; a read that fails is today's
// behaviour. The holds are answered by the real holdsSession, from a pool
// that plays the database. The idle check's own decision is driven as the
// pure transition it is.
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

// ── The database, as holdsSession reads it ──────────────────────────────
const db = { held: new Set(), fail: false };
const calls = [];
const pool = {
  async query(sql, params) {
    calls.push({ sql: String(sql), params });
    if (/FROM wf_instances w/.test(sql)) {
      if (db.fail) throw new Error('connection reset');
      return { rows: [{ held: db.held.has(Number(params[0])) }] };
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

function reset({ held = [], fail = false } = {}) {
  db.held = new Set(held);
  db.fail = fail;
  calls.length = 0;
  evicted.length = 0;
  forgotten.length = 0;
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

// The idle pause: the proposal machine's IdleCheck, a timer's event to a
// session holding its slot. Idle past the window, it pauses (its worker is
// destroyed as the pause's work); held by a durable build, it waits and
// looks again a minute on, as it does while somebody works on it.
test('the idle check leaves a session a durable build holds, and pauses the others', () => {
  const { proposal, WORK, IDLE_RECHECK_MS } = require('../src/workflow/proposal/machine.ts');
  const machine = proposal({ idleMs: 5 * MIN, exemptFixtures: false, reviewCheckMs: 60 * MIN, staleNotifyMs: 0, staleGraceMs: 0 });
  const now = new Date(NOW);
  const idleCheck = (row) => {
    const s = { name: 'underway', data: {
      sessionId: row.id, appId: 1, imported: false, slot: 'held', promoting: null, answer: null, reason: null,
      claim: null, pr: { running: null, next: null }, n: 0 } };
    const event = { id: 1, type: 'IdleCheck', payload: {}, source: { kind: 'timer' } };
    const f = { row: { id: row.id, appId: 1, appSlug: 'shop', lastActivityAt: new Date(idleFor(10)).toISOString(),
      activeTurn: false, workedOn: false, moving: false, shotsRunning: false, buildHold: false, fixture: false, ...row } };
    const entry = machine.entryFor('underway', 'IdleCheck');
    assert.equal(entry.guard(s, event, f, { now }), true);
    return entry.to(s, event, f, { now });
  };
  const held = idleCheck({ id: 51, buildHold: true });
  assert.equal(held.next.data.slot, 'held', 'a durable build keeps its session\'s slot');
  assert.deepEqual(held.work || [], [], 'and its worker');
  assert.equal(held.timer.event.type, 'IdleCheck');
  assert.equal(held.timer.at.getTime(), NOW + IDLE_RECHECK_MS, 'it looks again a minute on');
  for (const id of [52, 53]) {
    const idle = idleCheck({ id });
    assert.equal(idle.next.data.slot, 'released', 'an idle session nobody holds gives its slot back');
    assert.deepEqual(idle.work.map((w) => w.kind), [WORK.destroy]);
  }
  // Not idle long enough: nothing yet, looked at again when it may be.
  const fresh = idleCheck({ id: 54, lastActivityAt: new Date(idleFor(2)).toISOString() });
  assert.equal(fresh.next.data.slot, 'held');
  assert.equal(fresh.timer.at.getTime(), idleFor(2) + 5 * MIN);
  // The hold is read under the session's lock with the rest of its facts.
  const facts = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/proposal/facts.ts'), 'utf8');
  assert.match(facts, /buildHoldSql\(/);
});

test('every sweep that stops a worker unasked asks first; adoption already keeps a durable build\'s', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The interval runs the pass. The session sweeper pauses nothing itself:
  // its first pass hands every session holding a slot to the proposal
  // machine, whose idle check is the pause.
  assert.match(src, /sweeperHandle = setInterval\(async \(\) => \{\s*if \(lifecycle\.isShuttingDown\(\)\) return;\s*await sweepIdleWarmWorkers\(\)\.catch/);
  assert.doesNotMatch(src, /autoPauseIdleSessions/);
  assert.match(src, /\/\/ Pass 1:[\s\S]*?await require\('\.\/src\/workflow\/platform\.ts'\)\.adoptProposals\(\)/);
  assert.match(src, /function heldByDurableBuild\(sessionId, pool = getPool\(config\)\) \{\s*return require\('\.\/src\/services\/build-runs'\)\.holdsSession\(pool, sessionId\);/);
  // The left-behind sweep adopts through adoptOrphanWorker, which keeps a
  // durable build's worker as it is (tests/homeroom-bot-restart-recovery.test.js).
  const adopt = src.slice(src.indexOf('async function adoptOrphanWorker('));
  assert.match(adopt.slice(0, 6000), /if \(session\.workflow_owned\) \{\s*if \(containerState === 'running'\) worker\.adoptWarmWorker\(sessionId, containerName\);/);
  // A draining process only forgets its idle workers; it stops none.
  const cleanup = src.slice(src.indexOf('async function cleanup()'));
  assert.match(cleanup.slice(0, 4000), /if \(!meta\.inFlight && !meta\.bootstrapping\) worker\.forgetWorker\(meta\.sessionId\);/);
});
