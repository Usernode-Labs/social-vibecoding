'use strict';

// The platform's sockets accept the session cookie only on a handshake the
// Homeroom page itself opened. Browsers attach the Lax cookie to every
// same-site handshake and WebSockets have no CORS, so without this any app or
// preview on a sibling host could open /ws/events or /ws/chat/<slug> as the
// visitor. A client that sends neither Origin nor Sec-Fetch-Site is not a
// browser riding someone's cookie, and keeps working.
//
// Run with: node --test tests/ws-handshake-origin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const poolPath = require.resolve(path.join(ROOT, 'src/db/pool'));
const wsPath = require.resolve(path.join(ROOT, 'src/services/ws'));

// Only the cookie lookup answers; every other query sees an empty database.
const fakePool = {
  async query(sql) {
    if (/FROM sessions s JOIN users u/.test(sql)) {
      return { rows: [{ user_id: 7, expires_at: new Date(Date.now() + 3600e3), username: 'fake-member', is_admin: false }] };
    }
    return { rows: [] };
  },
  async connect() { return { query: fakePool.query, release() {} }; },
};

async function withSocketServer(fn) {
  const savedPool = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };
  delete require.cache[wsPath];
  const ws = require(wsPath);
  const server = http.createServer(express());
  ws.attach(server, {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete require.cache[wsPath];
    if (savedPool) require.cache[poolPath] = savedPool; else delete require.cache[poolPath];
  }
}

// 'open' or the HTTP status the handshake was refused with.
function handshake(port, headers) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { cookie: 'session=fake-token', ...headers } });
    sock.once('open', () => { sock.terminate(); resolve('open'); });
    sock.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    sock.once('error', () => resolve('error'));
  });
}

test('a cookie handshake from another origin is refused; the page itself and non-browsers connect', async () => {
  await withSocketServer(async (port) => {
    const own = `http://127.0.0.1:${port}`;
    assert.equal(await handshake(port, { origin: own }), 'open', 'the Homeroom page');
    assert.equal(await handshake(port, { origin: own, 'sec-fetch-site': 'same-origin' }), 'open');
    assert.equal(await handshake(port, {}), 'open', 'no Origin, no Fetch Metadata: not a browser');
    assert.equal(await handshake(port, { origin: 'https://evil-app.onhomeroom.com' }), 401, 'sibling app');
    assert.equal(await handshake(port, { origin: 'null' }), 401, 'opaque origin');
    assert.equal(await handshake(port, { origin: own, 'sec-fetch-site': 'same-site' }), 401,
      'Fetch Metadata wins over a forged-looking Origin');
    assert.equal(await handshake(port, { 'sec-fetch-site': 'cross-site' }), 401);
  });
});
