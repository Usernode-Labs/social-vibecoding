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
//
// The persona ports are picked free in the test and bound by the proxy a
// moment later, and under the full suite another test can take one in
// between: the proxy then exits with "could not listen on its ports"
// (shots-origin-proxy-egress, 7 October, on a proposal that touched nothing
// here). startOnFreePorts starts it again on fresh ports. The worker itself
// has fixed persona ports (worker/run-cc.sh), so only the tests race.

const fs = require('node:fs');
const net = require('node:net');

const READY_TIMEOUT_MS = 30000;
const PERSONAS = ['member', 'read_only_admin', 'full_admin', 'guest'];
// What worker/shots-origin-proxy.js writes when a listener cannot bind.
const PORTS_TAKEN = 'Shots proxy could not listen on its ports.';

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

/**
 * A port for each persona, free a moment ago on 127.0.0.1 and all different:
 * every one is held until all four are picked.
 */
async function freePersonaPorts() {
  const servers = await Promise.all(PERSONAS.map(() => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const ports = Object.fromEntries(PERSONAS.map((persona, i) => [persona, servers[i].address().port]));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

/**
 * Run `start(ports)` with fresh persona ports, and again with new ones when
 * the proxy could not listen on them, up to `attempts` times. Any other
 * failure, and the last attempt's, is thrown as it is.
 */
async function startOnFreePorts(start, { attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start(await freePersonaPorts());
    } catch (err) {
      if (attempt >= attempts || !String(err?.message).includes(PORTS_TAKEN)) throw err;
    }
  }
}

/** Stop the proxy, and wait for it to close even if it already had. */
async function stopProxy(proxy, closed) {
  if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGTERM');
  await closed;
}

module.exports = {
  READY_TIMEOUT_MS, PORTS_TAKEN, closedPromise, waitForReady, stopProxy, freePersonaPorts, startOnFreePorts,
};
