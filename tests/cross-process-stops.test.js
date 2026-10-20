'use strict';

// Stops for work another platform process runs (docs/plans/
// draining-releases.md): a turn, and the BYOK spend a proxy saw for a turn
// it does not run. (A bench trial's or run's cancel is the bench lane's
// machine's, which stops a trial through its build wherever it runs: never
// the bus.) The process that holds
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

test('a Stop for shots is no bus message: the shots machine cancels the agent\'s step wherever it runs', () => {
  // src/workflow/shots/: StopRequested fails the run and cancels its work
  // item, whose process stops at its next lease renewal; the run's cleanup
  // stops its turn. Nothing is relayed between processes.
  const fs = require('node:fs');
  const path = require('node:path');
  const ws = fs.readFileSync(path.join(__dirname, '..', 'src/services/ws.js'), 'utf8');
  assert.doesNotMatch(ws, /shots_stop/);
});

test('a bench cancel is the bench lane\'s machine\'s, never the bus\'s', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lane = fs.readFileSync(path.join(__dirname, '..', 'src/services/bench/lane.js'), 'utf8');
  assert.doesNotMatch(lane, /bench_cancel|bench_wake|heldMap\('bench_trial'\)/);
  assert.match(lane, /benchCancelTrial\(Number\(trialId\)/);
  const ws = fs.readFileSync(path.join(__dirname, '..', 'src/services/ws.js'), 'utf8');
  assert.doesNotMatch(ws, /bench_cancel|bench_wake/);
});

test('the bus delivers each stop to its receiver, and a turn\'s BYOK spend to the process running it', async (t) => {
  const ws = require('../src/services/ws');
  const sessions = require('../src/routes/sessions');
  const worker = require('../src/services/worker');
  const got = [];
  const saved = { s: sessions.receiveSessionStop, w: worker.receiveTurnByok };
  sessions.receiveSessionStop = async (p) => { got.push(['session', p.sessionId]); };
  worker.receiveTurnByok = (p) => { got.push(['byok', p.cents]); };
  t.after(() => {
    sessions.receiveSessionStop = saved.s; worker.receiveTurnByok = saved.w;
  });
  ws._onBusMessage({ kind: 'session_stop', data: { sessionId: 1 } });
  ws._onBusMessage({ kind: 'turn_byok', data: { cents: 12 } });
  ws._onBusMessage({ kind: 'session_stop', data: { sessionId: 2 }, oversize: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [['session', 1], ['byok', 12]], 'an oversize one carries nothing to act on');
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
