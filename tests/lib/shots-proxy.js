'use strict';

// Waiting for worker/shots-origin-proxy.js in a test, and stopping it, the
// same way in every suite that starts one.
//
// Each suite used to wait five seconds for the ready file and then assert
// that it existed ("the proxy started"). Under the full suite's load that
// failed about twenty times between 1 and 5 October 2026, on proposals and
// on main alike, and said nothing of why: the proxy's own output was not
// shown. Then the cleanup's `await once(proxy, 'close')` waited for a close
// that had already happened, the event loop emptied, and node:test cancelled
// every later test in the file. One slow start read as six failures.

const fs = require('node:fs');

const READY_TIMEOUT_MS = 30000;

/**
 * A promise that settles when `proxy` closes, whenever that is. Take it
 * right after spawn, so a proxy that exits before cleanup still settles it.
 * Never rejects.
 */
function closedPromise(proxy) {
  return new Promise((resolve) => proxy.once('close', resolve));
}

/**
 * Wait for the proxy's ready file and return the shared port it holds.
 * Fails as soon as the proxy exits, or at the deadline, with what the proxy
 * wrote (`output`, a function returning its captured output).
 */
async function waitForReady(proxy, ready, { output = () => '', timeoutMs = READY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(ready)) {
    const exited = proxy.exitCode !== null ? `exit ${proxy.exitCode}`
      : proxy.signalCode !== null ? proxy.signalCode : null;
    if (exited || Date.now() >= deadline) {
      const why = exited ? `it exited (${exited})` : `nothing after ${timeoutMs} ms`;
      throw new Error(`the proxy did not start: ${why}. It wrote:\n${output() || '(nothing)'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Number(fs.readFileSync(ready, 'utf8'));
}

/** Stop the proxy, and wait for it to close even if it already had. */
async function stopProxy(proxy, closed) {
  if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGTERM');
  await closed;
}

module.exports = { READY_TIMEOUT_MS, closedPromise, waitForReady, stopProxy };
