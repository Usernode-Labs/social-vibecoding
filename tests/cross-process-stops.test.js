'use strict';

// Stops for work another platform process runs (docs/plans/
// draining-releases.md): a turn, and the BYOK spend a proxy saw for a turn
// it does not run. A person's turn is its machine's work item
// (src/workflow/turn/): a Stop reaches it through its machine, and the
// durable path (the stamp, the kill inside the worker) reaches the rest from
// any process. Nothing is forwarded over the WebSocket bus any more, and no
// process reads another's memory. (A bench trial's or run's cancel is the
// bench lane's machine's; shots are the shots machine's.)
//
// Run with: node --test tests/cross-process-stops.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const wsBus = require('../src/services/ws-bus');

function capturePublishes() {
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data }); };
  return { sent, restore: () => { wsBus.publish = real; } };
}

test('a Stop with no turn here forwards nothing over the bus: its turn\'s machine, or the durable path, reaches it', async (t) => {
  const bus = capturePublishes();
  t.after(() => { bus.restore(); });
  const { requestSessionStop } = require('../src/routes/sessions');
  const pool = { query: async () => ({ rows: [{ id: 4242, user_id: 7 }] }) };
  await requestSessionStop({ pool, sessionId: 4242, user: { id: 7, username: 'alice' } });
  assert.deepEqual(bus.sent.filter((m) => m.kind === 'session_stop'), []);
  // The stop's user is checked first: someone else's session is refused.
  const denied = await requestSessionStop({
    pool: { query: async () => ({ rows: [] }) }, sessionId: 4242, user: { id: 8, username: 'mallory' },
  });
  assert.equal(denied.status, 404);
  assert.equal(require('../src/routes/sessions').receiveSessionStop, undefined, 'and nothing receives one');
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

test('the bus delivers a turn\'s BYOK spend to the process running it, and an older release\'s stop forward to nobody', async (t) => {
  const ws = require('../src/services/ws');
  const worker = require('../src/services/worker');
  const got = [];
  const saved = worker.receiveTurnByok;
  worker.receiveTurnByok = (p) => { got.push(['byok', p.cents]); };
  t.after(() => { worker.receiveTurnByok = saved; });
  ws._onBusMessage({ kind: 'session_stop', data: { sessionId: 1 } });
  ws._onBusMessage({ kind: 'turn_byok', data: { cents: 12 } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [['byok', 12]]);
});

test('BYOK spend the proxy here saw for a turn this process does not run is not kept here', async () => {
  const worker = require('../src/services/worker');
  worker.noteTurnByokSpend(515, 40);
  assert.equal(worker.getTurnByokCents(515), 0, 'this process runs no turn on the session: no tally of its own');
  assert.equal(worker.markTurnByokSwitched(515), true, 'the first switched call is said');
  assert.equal(worker.markTurnByokSwitched(515), false, 'and not again for the same turn');
  assert.equal(worker.receiveTurnByok({ sessionId: 515, turnId: 't1', cents: 40 }), false,
    'the bus copy is added only where the same turn runs');
});
