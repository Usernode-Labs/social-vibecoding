'use strict';

// tests/lib/shots-proxy.js, which every shots origin proxy suite now waits and
// stops its proxy with. A proxy that exits before it is ready fails its test
// at once, saying what it wrote; and stopping one that already exited
// returns, rather than leaving the file's later tests cancelled (5 October:
// one slow start read as six failures).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { closedPromise, waitForReady, stopProxy, READY_TIMEOUT_MS } = require('./lib/shots-proxy');

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
