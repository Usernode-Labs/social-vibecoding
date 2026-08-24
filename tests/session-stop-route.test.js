'use strict';

// #1378 — the two HTTP surfaces the Stop button actually talks to.
//
// GET /api/sessions/:id/status now answers `stoppable`, which is NOT the
// same fact as `busy`. Everything holding a session reads busy — an adopted
// turn, a handoff, a proposal pipeline — but only a turn this process has a
// stop handle for (or a durable active_turn in a recoverable phase, which
// recovery will register a handle for) can actually be ended. The client
// used to assume busy ⇒ stoppable and painted a live red Stop that answered
// `{ stopped: false }`; the signal is what lets it paint a spinner instead.
//
// POST /api/sessions/:id/stop was owner-only, which is why an admin
// watching someone else's runaway turn got a 404 and "Couldn't stop the
// agent". It now accepts an admin who may WRITE — deliberately
// `canAdminWrite`, not `isAdmin`, because that includes view-only admins
// and killing a turn is a privileged mutation.
//
// Harness follows tests/me-session-state-route.test.js: override getPool
// BEFORE requiring the route module (sessions.js destructures it at require
// time), mount the router on a real express app, inject req.user.
//
// Run with: node --test tests/session-stop-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(String(sql), params);
  },
});

const { activeWorkers } = require('../src/services/active-workers');
const stopRegistry = require('../src/services/stop-registry');
const workerMod = require('../src/services/worker');
const wsMod = require('../src/services/ws');
const sessionBus = require('../src/services/session-bus');

const { sessionRoutes } = require('../src/routes/sessions');

const OWNER = { id: 7, username: 'alice' };
const WRITE_ADMIN = { id: 99, username: 'root', isAdmin: true, canAdminWrite: true };
const VIEW_ADMIN = { id: 98, username: 'auditor', isAdmin: true, canAdminWrite: false };
const SESSION_ID = 4242;

function startServer(viewer) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function call(server, path, init) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
  return { status: res.status, body: await res.json() };
}

// The route runs a handful of unrelated reads (progress log, session row,
// lease). Only two matter here, so answer by shape and default to empty.
function routeQueries({ activeTurn = null, ownerId = OWNER.id } = {}) {
  poolQueryHandler = async (sql, params = []) => {
    if (/SELECT active_turn FROM chat_sessions/.test(sql)) {
      return { rows: [{ active_turn: activeTurn }] };
    }
    if (/SELECT id, user_id FROM chat_sessions/.test(sql)) {
      // Evaluate the route's own `(user_id = $2 OR $3::boolean)` filter
      // rather than always answering with a row — the admin bypass IS the
      // thing under test, so the stub must not grant it for free.
      const [, viewerId, adminBypass] = params;
      if (ownerId !== viewerId && adminBypass !== true) return { rows: [] };
      return { rows: [{ id: SESSION_ID, user_id: ownerId }] };
    }
    return { rows: [] };
  };
}

function durableTurn(over = {}) {
  return {
    turnId: 'turn-xyz',
    journal: '/journals/turn-xyz.jsonl',
    phase: 'executing',
    mode: 'build',
    startedAt: new Date().toISOString(),
    ...over,
  };
}

test.beforeEach(() => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  activeWorkers.clear();
  stopRegistry._reset();
  routeQueries();
});

test.afterEach(() => {
  activeWorkers.clear();
  stopRegistry._reset();
});

// ── GET /status: stoppable ──────────────────────────────────────────────

test('a busy session with no turn to stop reports stoppable: false', async () => {
  // The reported shape: something holds the session (so the client shows a
  // spinner at all), but nothing in this process can end it.
  activeWorkers.add(SESSION_ID);
  routeQueries({ activeTurn: null });

  const server = await startServer(OWNER);
  try {
    const { status, body } = await call(server, `/api/sessions/${SESSION_ID}/status`);
    assert.equal(status, 200);
    assert.equal(body.busy, true, 'still busy — the session is genuinely held');
    assert.equal(body.stoppable, false, 'but there is nothing for POST /stop to do');
  } finally { server.close(); }
});

test('a live turn with a stop handle reports stoppable: true and its phase', async () => {
  activeWorkers.add(SESSION_ID);
  stopRegistry.set(SESSION_ID, stopRegistry.createHandle({
    sessionId: SESSION_ID, phase: 'cc', workerName: 'usernode-worker-4242',
  }));

  const server = await startServer(OWNER);
  try {
    const { body } = await call(server, `/api/sessions/${SESSION_ID}/status`);
    assert.equal(body.stoppable, true);
    assert.equal(body.phase, 'cc');
    assert.equal(body.stopping, false);
  } finally { server.close(); }
});

test('a durable executing turn with no handle yet is stoppable — recovery will register one', async () => {
  // The window right after a restart: the turn record is in the database,
  // this process has adopted it (or is about to). Answering false here
  // would tell the client the turn is unstoppable seconds before it is.
  activeWorkers.add(SESSION_ID);
  routeQueries({ activeTurn: durableTurn({ phase: 'executing' }) });

  const server = await startServer(OWNER);
  try {
    const { body } = await call(server, `/api/sessions/${SESSION_ID}/status`);
    assert.equal(body.stoppable, true);
  } finally { server.close(); }
});

test('a turn parked in a non-recoverable phase is not stoppable', async () => {
  activeWorkers.add(SESSION_ID);
  routeQueries({ activeTurn: durableTurn({ phase: 'quarantined' }) });

  const server = await startServer(OWNER);
  try {
    const { body } = await call(server, `/api/sessions/${SESSION_ID}/status`);
    assert.equal(body.stoppable, false,
      'a quarantined turn is not going to be ended by pressing Stop');
  } finally { server.close(); }
});

test('a durable stop stamp repaints Stopping… across a restart, with its original clock', async () => {
  // No handle in this process — the stamp is the only surviving record of
  // the click, and it has to be enough to keep the ladder at the right rung.
  const at = new Date(Date.now() - 30_000).toISOString();
  activeWorkers.add(SESSION_ID);
  routeQueries({
    activeTurn: durableTurn({ stopRequestedAt: at, stopRequestedBy: 'alice' }),
  });

  const server = await startServer(OWNER);
  try {
    const { body } = await call(server, `/api/sessions/${SESSION_ID}/status`);
    assert.equal(body.stopping, true, 'a calm red Stop would be a lie here');
    assert.equal(body.stopRequestedAt, Date.parse(at),
      'the ladder resumes 30s in, not from zero');
  } finally { server.close(); }
});

// ── POST /stop: who may press it ────────────────────────────────────────

test('an admin who can write stops another user\'s turn, and is recorded as the stopper', async () => {
  routeQueries({ activeTurn: null, ownerId: OWNER.id });
  const handle = stopRegistry.createHandle({
    sessionId: SESSION_ID, phase: 'mayor1',
  });
  stopRegistry.set(SESSION_ID, handle);

  const server = await startServer(WRITE_ADMIN);
  try {
    const { status, body } = await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(status, 200);
    assert.equal(body.stopped, true);
    assert.equal(handle.stopped, true);
    assert.equal(handle.stoppedBy, 'root',
      'attribution names the admin, not the session owner');
    assert.ok(handle.stopRequestedAt > 0);
  } finally { server.close(); }
});

test('a view-only admin still gets the owner-only 404', async () => {
  routeQueries({ activeTurn: null, ownerId: OWNER.id });
  const handle = stopRegistry.createHandle({ sessionId: SESSION_ID, phase: 'mayor1' });
  stopRegistry.set(SESSION_ID, handle);

  const server = await startServer(VIEW_ADMIN);
  try {
    const { status } = await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(status, 404, 'isAdmin alone is not enough — killing a turn is a write');
    assert.equal(handle.stopped, false, 'and nothing was stopped on the way to the 404');
  } finally { server.close(); }
});

test('the ownership filter is parameterised on canAdminWrite, not spliced in', async () => {
  const server = await startServer(VIEW_ADMIN);
  try {
    await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  } finally { server.close(); }
  const lookup = capturedQueries.find((q) => /SELECT id, user_id FROM chat_sessions/.test(q.sql));
  assert.ok(lookup, 'the ownership lookup ran');
  assert.deepEqual(lookup.params, [SESSION_ID, VIEW_ADMIN.id, false],
    'the admin bypass rides as a bound boolean');
});

// ── POST /stop: the durable stamp, and the honest miss ──────────────────

test('a stop writes the intent durably so a cutover mid-click still honours it', async () => {
  routeQueries({ activeTurn: durableTurn() });
  stopRegistry.set(SESSION_ID, stopRegistry.createHandle({
    sessionId: SESSION_ID, phase: 'cc', workerName: 'usernode-worker-4242',
  }));
  // The stop path docker-stops the worker; keep it off the real runtime.
  const realStopTurn = workerMod.stopTurn;
  workerMod.stopTurn = async () => true;

  const server = await startServer(OWNER);
  try {
    await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  } finally {
    workerMod.stopTurn = realStopTurn;
    server.close();
  }

  const stamp = capturedQueries.find((q) => /stopRequestedAt/.test(q.sql));
  assert.ok(stamp, `the durable stamp was written (saw: ${capturedQueries.map((q) => q.sql.slice(0, 40)).join(' | ')})`);
  assert.match(stamp.sql, /UPDATE chat_sessions/);
  assert.match(stamp.sql, /active_turn->>'stopRequestedAt' IS NULL/,
    'compare-and-set: the FIRST stop owns the timestamp the ladder measures against');
  const patch = JSON.parse(stamp.params.find((p) => typeof p === 'string' && p.startsWith('{')));
  assert.equal(patch.stopRequestedBy, 'alice',
    'the clicker is recorded on the turn record, not only in memory');
  assert.ok(Date.parse(patch.stopRequestedAt) > 0, 'and when they clicked');
  assert.ok(stamp.params.includes('turn-xyz'), 'stamped against this turn\'s identity');
});

test('a stop with nothing to stop reports hasDurableTurn so the client can keep escalating', async () => {
  // The honest miss: no handle here, but the turn record says a turn is
  // alive somewhere. Answering a bare "no active turn" is what let the
  // client stand down while the agent kept running.
  activeWorkers.add(SESSION_ID);
  routeQueries({ activeTurn: durableTurn() });

  const server = await startServer(OWNER);
  try {
    const { status, body } = await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(status, 200);
    assert.equal(body.stopped, false);
    assert.equal(body.reason, 'no active turn');
    assert.equal(body.hasDurableTurn, true,
      'the client needs this to keep the Force stop rung armed');
  } finally { server.close(); }
});

test('with no handle and no turn record, hasDurableTurn is false', async () => {
  routeQueries({ activeTurn: null });
  const server = await startServer(OWNER);
  try {
    const { body } = await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(body.hasDurableTurn, false, 'nothing is running; the client may stand down');
  } finally { server.close(); }
});

// ── force-orphan: the turn nobody holds a handle for ────────────────────

test('force-stopping a handle-less turn still announces it on both channels', async () => {
  // The force rung exists for exactly the turn this issue is about: one
  // this process never had a handle for. Every announcement on that path
  // used to be `handle?.send?.(...)`, so it went out to nobody — the user
  // pressed Force stop, the turn ended, and the screen kept spinning.
  routeQueries({ activeTurn: null });

  const broadcasts = [];
  const busEvents = [];
  const realBroadcast = wsMod.broadcastGlobal;
  const realExecuting = workerMod.isWorkerExecuting;
  wsMod.broadcastGlobal = (msg) => broadcasts.push(msg);
  workerMod.isWorkerExecuting = async () => false;
  const unsub = sessionBus.subscribe(SESSION_ID, (e) => busEvents.push(e));

  const server = await startServer(OWNER);
  let body;
  try {
    ({ body } = await call(server, `/api/sessions/${SESSION_ID}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }));
  } finally {
    wsMod.broadcastGlobal = realBroadcast;
    workerMod.isWorkerExecuting = realExecuting;
    if (typeof unsub === 'function') unsub();
    server.close();
  }

  assert.equal(body.stopped, true);
  assert.equal(body.forced, true);

  const events = broadcasts.filter((b) => b.type === 'session_event').map((b) => b.event);
  for (const want of ['status', 'stopped', 'done']) {
    assert.ok(events.includes(want), `${want} reached the WS broadcast (got ${events.join(',')})`);
  }
  const busTypes = busEvents.map((e) => e.type);
  for (const want of ['status', 'stopped', 'done']) {
    assert.ok(busTypes.includes(want), `${want} reached the session bus (got ${busTypes.join(',')})`);
  }

  // Envelope shape: an inner `type` must not clobber `type: 'session_event'`
  // or the client's switch never routes it to handleSessionEvent (#437).
  const stopped = broadcasts.find((b) => b.event === 'stopped');
  assert.equal(stopped.type, 'session_event');
  assert.equal(stopped.sessionId, SESSION_ID);
  assert.equal(stopped.forced, true);
  assert.equal(stopped.by, 'alice');
  // sessionBus.publish drops anything without a _seq, so the fallback has
  // to mint one — the reason the bus half of this is easy to get wrong.
  assert.ok(busEvents.every((e) => e._seq), 'every bus event carries a _seq');

  const row = capturedQueries.find((q) => /INSERT INTO chat_session_messages/.test(q.sql));
  assert.ok(row, 'the forced stop is persisted too, for the reloading tab');
  assert.match(row.params[1], /Stopped by @alice \(forced\)\./);
});
