'use strict';

// One pass at a time for a timer callback (services/single-flight.js). On
// 14 Oct 2026 the session sweeper's passes, minutes long during a staging
// heal, overlapped because setInterval started the next one beside them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { singleFlight } = require('../src/services/single-flight');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a tick while a pass runs starts nothing; the next tick after it ends runs', async () => {
  const passes = [];
  const tick = singleFlight('test', () => {
    const d = deferred();
    passes.push(d);
    return d.promise;
  });
  const settle = () => new Promise((r) => setImmediate(r));
  const first = tick();
  await settle();
  assert.equal(passes.length, 1);
  assert.equal(tick.isRunning(), true);
  assert.equal(tick(), first, 'a skipped tick shares the running pass');
  tick();
  await settle();
  assert.equal(passes.length, 1, 'no second pass beside the first');
  passes[0].resolve();
  await first;
  assert.equal(tick.isRunning(), false);
  tick();
  await settle();
  assert.equal(passes.length, 2, 'the tick after it ended runs a pass');
  passes[1].resolve();
});

test('a pass that throws frees the next tick', async () => {
  let calls = 0;
  const tick = singleFlight('test', async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
  });
  await assert.rejects(tick(), /boom/);
  assert.equal(tick.isRunning(), false);
  await tick();
  assert.equal(calls, 2);
});

test('the session sweeper runs one pass at a time', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /sessionSweeperHandle = setInterval\(singleFlight\('session-sweeper', async \(\) => \{/);
  assert.match(server, /\}\), config\.sessionSweepIntervalMs\)\.unref\(\);/);
});
