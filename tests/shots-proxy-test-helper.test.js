'use strict';

// tests/lib/shots-proxy.js, which every shots origin proxy suite now waits and
// stops its proxy with. A proxy that exits before it is ready fails its test
// at once, saying what it wrote; and stopping one that already exited
// returns, rather than leaving the file's later tests cancelled (5 October:
// one slow start read as six failures). A proxy that could not bind the
// persona ports it was given, because another test took one first, is
// started again on fresh ones (7 October).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const {
  closedPromise, waitForReady, stopProxy, READY_TIMEOUT_MS, PORTS_TAKEN, freePersonaPorts, startOnFreePorts,
} = require('./lib/shots-proxy');

function fakeProxy(script) {
  const proxy = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = closedPromise(proxy);
  const stderr = [];
  proxy.stderr.on('data', (chunk) => stderr.push(chunk));
  return { proxy, closed, output: () => Buffer.concat(stderr).toString() };
}

test('a proxy that exits before it is ready fails at once, with what it wrote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-helper-'));
  const { proxy, closed, output } = fakeProxy("process.stderr.write('Shots proxy could not listen on its ports.\\n'); process.exit(1)");
  const started = Date.now();
  await assert.rejects(waitForReady(proxy, path.join(dir, 'proxy.ready'), { output }),
    /the proxy did not start: it exited \(exit 1\)\. It wrote:\nShots proxy could not listen on its ports\./);
  assert.ok(Date.now() - started < READY_TIMEOUT_MS / 2, 'without waiting out the deadline');
  await stopProxy(proxy, closed);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a proxy that never becomes ready fails at the deadline, and stopping it returns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-helper-'));
  const { proxy, closed, output } = fakeProxy("process.stderr.write('still starting\\n'); setInterval(() => {}, 1000)");
  await assert.rejects(waitForReady(proxy, path.join(dir, 'proxy.ready'), { output, timeoutMs: 300 }),
    /nothing after 300 ms\. It wrote:\nstill starting/);
  await stopProxy(proxy, closed);
  assert.notEqual(proxy.signalCode ?? proxy.exitCode, null, 'it was stopped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the ready file\'s port is returned once it appears', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-helper-'));
  const ready = path.join(dir, 'proxy.ready');
  const { proxy, closed, output } = fakeProxy(
    `require('fs').writeFileSync(${JSON.stringify(ready)}, '41234'); setInterval(() => {}, 1000)`);
  assert.equal(await waitForReady(proxy, ready, { output }), 41234);
  await stopProxy(proxy, closed);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stopping a proxy that already exited returns instead of waiting forever', async () => {
  const { proxy, closed } = fakeProxy('process.exit(0)');
  await closed;
  await stopProxy(proxy, closed);
});

// The real proxy, given only what it needs to start, on these persona ports:
// what it writes when one of them is taken is what startOnFreePorts reads.
async function realProxy(t, ports) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-helper-'));
  const ready = path.join(dir, 'proxy.ready');
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js')], {
    env: {
      PATH: process.env.PATH,
      SHOTS_ALLOWED_ORIGINS: JSON.stringify(['http://127.0.0.1:1', 'http://127.0.0.1:2']),
      SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready,
      SHOTS_PROXY_CONTROL_TOKEN: 'c'.repeat(64),
      SHOTS_MEMBER_TOKEN: 'm', SHOTS_ADMIN_TOKEN: 'a', SHOTS_FULL_ADMIN_TOKEN: 'f',
      SHOTS_PROXY_PERSONA_PORTS: JSON.stringify(ports),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = closedPromise(proxy);
  const stderr = [];
  proxy.stderr.on('data', (chunk) => stderr.push(chunk));
  t.after(async () => {
    await stopProxy(proxy, closed);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return waitForReady(proxy, ready, { output: () => Buffer.concat(stderr).toString() });
}

test('each persona gets its own port', async () => {
  const ports = await freePersonaPorts();
  assert.deepEqual(Object.keys(ports), ['member', 'read_only_admin', 'full_admin', 'guest']);
  assert.equal(new Set(Object.values(ports)).size, 4);
});

test('a proxy whose persona port was taken first is started again on fresh ones', async (t) => {
  const thief = net.createServer();
  await new Promise((resolve) => thief.listen(0, '127.0.0.1', resolve));
  t.after(() => thief.close());
  const taken = thief.address().port;
  const given = [];
  const shared = await startOnFreePorts((ports) => {
    given.push(given.length ? ports : { ...ports, member: taken });
    return realProxy(t, given[given.length - 1]);
  });
  assert.equal(given.length, 2, 'started twice');
  assert.ok(shared > 0, 'the second start is ready');
  assert.notEqual(given[1].member, taken);
});

test('any other failure is not retried', async () => {
  let calls = 0;
  await assert.rejects(startOnFreePorts(() => {
    calls += 1;
    throw new Error('the proxy did not start: it exited (exit 1). It wrote:\nShots proxy requires exactly two allowed origins.');
  }), /two allowed origins/);
  assert.equal(calls, 1);
});

test('it gives up after its attempts, with the last failure', async () => {
  let calls = 0;
  await assert.rejects(startOnFreePorts(() => {
    calls += 1;
    throw new Error(`attempt ${calls}: ${PORTS_TAKEN}`);
  }, { attempts: 2 }), /attempt 2: Shots proxy could not listen/);
  assert.equal(calls, 2);
});
