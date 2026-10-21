'use strict';

// What the shutdown drain waits for: background work registered in
// src/services/inflight-work.js, and the HTTP handlers still answering,
// counted by src/middleware/inflight-requests.js.
//
// Before these existed cleanup() waited for busy workers and shots runs
// alone, so on a pod with neither it exited the moment SIGTERM arrived and
// cut every handler and every fire-and-forget merge mid-write. These pin
// the two halves the drain now reads: the registry holds exactly what is
// running, and the request count leaves out the requests that are held open
// by design (event streams, long polls), which would otherwise hold every
// shutdown to its deadline. tests/server-graceful-shutdown.test.js drives
// cleanup() itself against both.
//
// Run with: node --test tests/inflight-work.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const inflight = require('../src/services/inflight-work');
const requests = require('../src/middleware/inflight-requests');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('track holds an entry until the work settles and hands the same promise back', async () => {
  assert.equal(inflight.size(), 0);
  const d = deferred();
  const returned = inflight.track('merge-queue', d.promise);
  assert.equal(returned, d.promise, 'the caller keeps its own promise');
  assert.equal(inflight.size(), 1);
  assert.deepEqual(inflight.snapshot().map((e) => e.name), ['merge-queue']);
  d.resolve('merged');
  assert.equal(await returned, 'merged');
  await new Promise((r) => setImmediate(r));
  assert.equal(inflight.size(), 0);
});

test('a rejection still reaches the caller, and the entry is released all the same', async () => {
  const failing = inflight.track('vote-settle', () => Promise.reject(new Error('github down')));
  assert.equal(inflight.size(), 1);
  await assert.rejects(failing, /github down/);
  await new Promise((r) => setImmediate(r));
  assert.equal(inflight.size(), 0);
  // A synchronous throw from a function is a rejection, not a crash.
  await assert.rejects(inflight.track('sync', () => { throw new Error('boom'); }), /boom/);
  await new Promise((r) => setImmediate(r));
  assert.equal(inflight.size(), 0);
});

test('snapshot lists the oldest first, one entry per call', async () => {
  const a = deferred();
  const b = deferred();
  inflight.track('timer:stale-pr-sweep', a.promise);
  await new Promise((r) => setTimeout(r, 5));
  inflight.track('merge-queue', b.promise);
  inflight.track('merge-queue', b.promise);
  const names = inflight.snapshot().map((e) => e.name);
  assert.deepEqual(names, ['timer:stale-pr-sweep', 'merge-queue', 'merge-queue']);
  assert.ok(inflight.snapshot()[0].ageMs >= 5);
  a.resolve(); b.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(inflight.size(), 0);
});

test('waitIdle resolves the moment the last entry settles, not on its next poll', async () => {
  const d = deferred();
  inflight.track('slow', d.promise);
  const startedAt = Date.now();
  const waited = inflight.waitIdle({ timeoutMs: 5000, pollMs: 4000 });
  setTimeout(() => d.resolve(), 50);
  assert.equal(await waited, true);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 45 && elapsed < 1000, `woke after ${elapsed}ms`);
});

test('waitIdle gives up at its deadline with the work still held', async () => {
  const d = deferred();
  inflight.track('never', d.promise);
  const startedAt = Date.now();
  assert.equal(await inflight.waitIdle({ timeoutMs: 120 }), false);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 110 && elapsed < 1000, `gave up after ${elapsed}ms`);
  assert.deepEqual(inflight.snapshot().map((e) => e.name), ['never']);
  d.resolve();
  await new Promise((r) => setImmediate(r));
});

test('waitIdle also waits for `also`, polling it', async () => {
  let open = true;
  setTimeout(() => { open = false; }, 60);
  const startedAt = Date.now();
  assert.equal(await inflight.waitIdle({ timeoutMs: 2000, pollMs: 10, also: () => !open }), true);
  // It resolved only once also() said idle. Not a wall-clock bound: a busy
  // runner fires the 60 ms timer early by Date.now() (libuv counts from its
  // cached loop time), which failed the unit suite with nothing wrong.
  assert.equal(open, false, 'waited for also()');
  assert.ok(Date.now() - startedAt < 2000, 'well before the deadline');
  assert.equal(await inflight.waitIdle({ timeoutMs: 0, also: () => true }), true, 'idle now: no wait');
});

// ── the request count ─────────────────────────────────────────────────

async function withApp(mount, fn) {
  const app = express();
  app.use(requests.inflightRequests());
  mount(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Open a request and resolve once its response headers arrive (or never, for
// a handler that has not answered); the socket is left open for the test.
function open(port, path) {
  const req = http.get({ host: '127.0.0.1', port, path, agent: false });
  const headers = new Promise((resolve) => req.on('response', (res) => { res.resume(); resolve(res); }));
  req.on('error', () => {});
  return { req, headers };
}

async function until(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
}

test('a handler is counted from arrival until it has answered', async () => {
  const release = deferred();
  await withApp((app) => {
    app.post('/api/sessions/:id/votes', async (_req, res) => {
      await release.promise;
      res.json({ ok: true });
    });
  }, async (port) => {
    assert.equal(requests.pending(), 0);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/sessions/4242/votes?token=secret', agent: false });
    const done = new Promise((resolve) => req.on('response', (res) => { res.resume(); res.on('end', resolve); }));
    req.end();
    assert.ok(await until(() => requests.pending() === 1), 'counted while the handler works');
    // The log names the surface, never the id or the query string.
    assert.deepEqual(requests.snapshot().map((e) => e.surface), ['POST /api/sessions']);
    release.resolve();
    await done;
    assert.ok(await until(() => requests.pending() === 0), 'released once answered');
  });
});

test('an event stream leaves the count once its headers are out; so does a long poll marked open-ended', async () => {
  await withApp((app) => {
    // Both header styles the routes use: setHeader, and writeHead with an
    // object on a response nothing called setHeader on.
    app.get('/sse-set', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write(': hello\n\n');
    });
    app.get('/sse-head', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': hello\n\n');
    });
    app.get('/turns/next', (_req, res) => {
      requests.openEnded(res);
      // Never answers within the test: the CLI's poll window.
    });
    app.get('/slow', () => { /* never answers: a stuck handler IS counted */ });
  }, async (port) => {
    const a = open(port, '/sse-set');
    const b = open(port, '/sse-head');
    await Promise.all([a.headers, b.headers]);
    const c = open(port, '/turns/next');
    const d = open(port, '/slow');
    assert.ok(await until(() => requests.snapshot().some((e) => e.surface === 'GET /slow')));
    assert.equal(requests.pending(), 1, 'only the stuck handler holds the drain');
    for (const r of [a, b, c, d]) r.req.destroy();
    assert.ok(await until(() => requests.pending() === 0));
  });
});

test('isEventStream reads either header style and nothing before the headers are sent', () => {
  assert.equal(requests.isEventStream({ headersSent: false, getHeader: () => 'text/event-stream' }), false);
  assert.equal(requests.isEventStream({ headersSent: true, getHeader: () => 'text/event-stream; charset=utf-8' }), true);
  assert.equal(requests.isEventStream({
    headersSent: true, getHeader: () => undefined,
    _header: 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n',
  }), true);
  assert.equal(requests.isEventStream({
    headersSent: true, getHeader: () => 'application/json',
    _header: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n',
  }), false);
});
