'use strict';

// Stops for work another platform process runs (docs/plans/
// draining-releases.md): a turn, a shots run, a bench trial or run, and the
// BYOK spend a proxy saw for a turn it does not run. The process that holds
// the work does what a stop in its own process does; the one asked forwards
// it over the WebSocket bus and answers as if it had. Here the other process
// is played by the registry's copy of its holds (a fake database answers the
// mirror's read) and the bus by a stub of its publish.
//
// Run with: node --test tests/cross-process-stops.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const processes = require('../src/services/processes');
const wsBus = require('../src/services/ws-bus');

// The registry, started over a database whose only other process holds `held`.
async function elsewhere(held) {
  processes._reset();
  const pool = {
    query: async (sql) => {
      if (/FROM process_holds h\s+JOIN platform_processes p ON p\.id = h\.process_id\s+WHERE h\.process_id <> \$1/.test(sql)) {
        return { rows: held.map(([kind, ref]) => ({ kind, ref: String(ref), process_id: 'pod-old' })) };
      }
      if (/SELECT DISTINCT h\.process_id/.test(sql)) return { rows: held.length ? [{ process_id: 'pod-old' }] : [] };
      return { rows: [], rowCount: 0 };
    },
  };
  await processes.start({ pool, role: 'all' });
  return pool;
}

function capturePublishes() {
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data }); };
  return { sent, restore: () => { wsBus.publish = real; } };
}

test('a Stop for a turn another process runs is forwarded to it, and answered as stopping', async (t) => {
  await elsewhere([['session', 4242]]);
  const bus = capturePublishes();
  t.after(() => { bus.restore(); processes._reset(); });
  const { requestSessionStop } = require('../src/routes/sessions');
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push(sql); return { rows: [{ id: 4242, user_id: 7 }] }; } };
  const result = await requestSessionStop({ pool, sessionId: 4242, user: { id: 7, username: 'alice' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.stopping, true);
  assert.deepEqual(bus.sent, [{
    kind: 'session_stop', routing: null,
    data: { sessionId: 4242, user: { id: 7, username: 'alice', canAdminWrite: false }, force: false, immediate: false, expectedTurnId: null },
  }]);
  // The stop's user is checked here first: someone else's session is not forwarded.
  bus.sent.length = 0;
  const denied = await requestSessionStop({
    pool: { query: async () => ({ rows: [] }) }, sessionId: 4242, user: { id: 8, username: 'mallory' },
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(bus.sent, []);
});

test('a forwarded stop is run where the turn is, and never forwarded again', async (t) => {
  await elsewhere([['session', 4242]]);
  const bus = capturePublishes();
  t.after(() => { bus.restore(); processes._reset(); });
  const sessions = require('../src/routes/sessions');
  // Not held here: nothing to do, nothing published.
  assert.equal(await sessions.receiveSessionStop({ sessionId: 4242, user: { id: 7, username: 'alice' } }), null);
  assert.deepEqual(bus.sent, []);
  assert.equal(await sessions.receiveSessionStop({ sessionId: 'x', user: { id: 7 } }), null, 'a malformed one is ignored');
});

test('a Stop for shots another process runs fails the run here and tells that process to stop its agent', async (t) => {
  await elsewhere([['shots', 42]]);
  const bus = capturePublishes();
  t.after(() => { bus.restore(); processes._reset(); });
  const orchestrator = require('../src/services/shots-orchestrator');
  const transitions = [];
  const stops = [];
  const pool = { query: async () => ({ rows: [{ id: 42, app_id: 7, app_slug: 'demo', shots_run_id: 'r1' }] }) };
  const out = await orchestrator.stopForSession(pool, 42, {
    state: {
      getRun: async () => ({ id: 'r1', current_run_id: 'r1', state: 'exploring', head_sha: 'a'.repeat(40) }),
      transitionRun: async (_p, runId, next) => { transitions.push([runId, next]); },
    },
    worker: { getActiveTurnMode: () => null, stopTurn: async (id) => { stops.push(id); } },
  });
  assert.deepEqual(out, { stopped: true, runId: 'r1' });
  assert.deepEqual(transitions, [['r1', 'failed']], 'the run is failed in the database here');
  assert.deepEqual(stops, [], 'no shots turn runs here to kill');
  assert.deepEqual(bus.sent.filter((m) => m.kind === 'shots_stop').map((m) => [m.data.sessionId, m.data.runId]), [[42, 'r1']]);
  // The holder: a run it does not execute is not stopped there either.
  assert.equal(await orchestrator.receiveStop({ sessionId: 42, runId: 'r1', headSha: 'a'.repeat(40) }), false);
});

test('a cancel for a bench trial another process runs is forwarded; one nobody runs is refused as before', async (t) => {
  await elsewhere([['bench_trial', 77]]);
  const bus = capturePublishes();
  t.after(() => { bus.restore(); processes._reset(); });
  const lane = require('../src/services/bench/lane');
  const running = { query: async (sql) => (/UPDATE bench_trials/.test(sql) ? { rows: [] } : { rows: [{ status: 'running' }] }) };
  assert.deepEqual(await lane.cancelTrial(running, 77), { ok: true, status: 'stopping' });
  assert.deepEqual(bus.sent.map((m) => [m.kind, m.data]), [['bench_cancel', { trialId: 77 }]]);
  bus.sent.length = 0;
  const refused = await lane.cancelTrial(running, 78);
  assert.equal(refused.status ?? refused.statusCode ?? refused.code, 409);
  assert.deepEqual(bus.sent, []);
  assert.equal(lane.receiveCancel({ trialId: 77 }), false, 'the holder side: nothing of it runs in this process');
  // A slot this process only counts (a durable trial another process
  // executes, as holdDurableTrials takes after a release): marked, and the
  // cancel still goes to the process running it.
  lane._resetForTests();
  bus.sent.length = 0;
  const slot = { runId: 1, est: 0, sessionId: null, promise: null, durable: true };
  lane._inFlightForTests().set(77, slot);
  assert.deepEqual(await lane.cancelTrial(running, 77), { ok: true, status: 'stopping' });
  assert.equal(slot.cancelled, true);
  assert.deepEqual(bus.sent.map((m) => [m.kind, m.data]), [['bench_cancel', { trialId: 77 }]]);
  lane._resetForTests();
});

test('the bus delivers each stop to its receiver, and a turn\'s BYOK spend to the process running it', async (t) => {
  const ws = require('../src/services/ws');
  const sessions = require('../src/routes/sessions');
  const orchestrator = require('../src/services/shots-orchestrator');
  const lane = require('../src/services/bench/lane');
  const worker = require('../src/services/worker');
  const got = [];
  const saved = {
    s: sessions.receiveSessionStop, o: orchestrator.receiveStop, l: lane.receiveCancel, w: worker.receiveTurnByok,
  };
  sessions.receiveSessionStop = async (p) => { got.push(['session', p.sessionId]); };
  orchestrator.receiveStop = async (p) => { got.push(['shots', p.runId]); };
  lane.receiveCancel = (p) => { got.push(['bench', p.trialId]); };
  worker.receiveTurnByok = (p) => { got.push(['byok', p.cents]); };
  t.after(() => {
    sessions.receiveSessionStop = saved.s; orchestrator.receiveStop = saved.o;
    lane.receiveCancel = saved.l; worker.receiveTurnByok = saved.w;
  });
  ws._onBusMessage({ kind: 'session_stop', data: { sessionId: 1 } });
  ws._onBusMessage({ kind: 'shots_stop', data: { runId: 'r' } });
  ws._onBusMessage({ kind: 'bench_cancel', data: { trialId: 3 } });
  ws._onBusMessage({ kind: 'turn_byok', data: { cents: 12 } });
  ws._onBusMessage({ kind: 'session_stop', data: { sessionId: 2 }, oversize: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [['session', 1], ['shots', 'r'], ['bench', 3], ['byok', 12]], 'an oversize one carries nothing to act on');
});

test('BYOK spend the proxy here saw for a turn another process runs is not kept here', async (t) => {
  await elsewhere([['session', 515]]);
  t.after(() => processes._reset());
  const worker = require('../src/services/worker');
  worker.noteTurnByokSpend(515, 40);
  assert.equal(worker.getTurnByokCents(515), 0, 'this process runs no turn on the session: no tally of its own');
  assert.equal(worker.markTurnByokSwitched(515), true, 'the first switched call is said');
  assert.equal(worker.markTurnByokSwitched(515), false, 'and not again for the same turn');
  assert.equal(worker.receiveTurnByok({ sessionId: 515, turnId: 't1', cents: 40 }), false,
    'the bus copy is added only where the same turn runs');
});
