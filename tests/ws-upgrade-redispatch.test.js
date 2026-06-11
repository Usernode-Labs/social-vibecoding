// Regression tests for the Caddy forward_auth × WebSocket interplay
// (src/services/ws.js attach()'s 'upgrade' handler).
//
// Caddy's forward_auth subrequest for a proxied WebSocket handshake
// PRESERVES the Connection/Upgrade headers while rewriting the URI to
// /__caddy/access. Node routes any upgrade-flagged request to the http
// server's 'upgrade' event — not the normal request listener — so the
// gate pre-flight used to fall through to socket.destroy() in
// ws.attach. forward_auth then read EOF, answered 502, and every
// WebSocket behind the wildcard site (all staging previews and child
// apps) was unreachable; staging group chat sat on "Reconnecting…"
// forever. The fix re-dispatches non-/ws/* upgrade requests into the
// regular request chain so routes like /__caddy/access can answer with
// a real HTTP response. Pool is stubbed via require.cache, same
// pattern as tests/edge-gate.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocket } = require('ws');

const VALID_SESSION = 'valid-session-token';
const USER = { user_id: 1, username: 'evan', is_admin: true };

// ── pool stub ──────────────────────────────────────────────────────────
const fakePool = {
  async query(sql, params = []) {
    if (/FROM sessions s JOIN users u/.test(sql)) {
      if (params[0] !== VALID_SESSION) return { rows: [] };
      return {
        rows: [{ ...USER, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
      };
    }
    if (/SELECT id, collab_visibility, view_visibility FROM apps WHERE slug/.test(sql)) {
      if (params[0] === 'chatapp') {
        return { rows: [{ id: 1, collab_visibility: 'public', view_visibility: 'public' }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { getPool: () => fakePool },
};
delete require.cache[require.resolve('../src/services/ws')];

const ws = require('../src/services/ws');

// ── harness: express app + ws.attach, like server.js wires them ──────
let server;
let port;

test.before(async () => {
  const app = express();
  app.use(cookieParser());
  // Stand-in for the real /__caddy/access route — what matters here is
  // that an upgrade-flagged request reaches the Express chain at all.
  app.get('/__caddy/access', (_req, res) => res.status(200).send('ok'));
  server = http.createServer(app);
  ws.attach(server, { jwtSecret: 'test-secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// Send a raw upgrade-flagged GET (exactly what Caddy's forward_auth
// subrequest looks like) and return the full HTTP response text.
function rawUpgradeRequest(path, extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
        'Host: chatapp--s1.social-vibecoding.usernodelabs.org\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        extraHeaders +
        '\r\n'
      );
    });
    let buf = '';
    sock.on('data', (d) => (buf += d));
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(buf); }, 2000);
  });
}

test('forward_auth-style upgrade subrequest to /__caddy/access gets an HTTP response, not EOF', async () => {
  const res = await rawUpgradeRequest('/__caddy/access');
  // Before the fix this socket was destroyed without a byte written
  // (Caddy logged "EOF" and turned it into a 502).
  assert.notEqual(res, '', 'socket closed without any response (forward_auth would 502)');
  assert.match(res.split('\r\n')[0], /^HTTP\/1\.1 200/);
  assert.match(res, /ok$/);
});

test('upgrade-flagged request to an unknown non-/ws path gets a 404, not EOF', async () => {
  const res = await rawUpgradeRequest('/no-such-route');
  assert.notEqual(res, '', 'socket closed without any response');
  assert.match(res.split('\r\n')[0], /^HTTP\/1\.1 404/);
});

test('chat WS with a valid session cookie completes the handshake and stays open', async () => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/chatapp`, {
    headers: { cookie: `session=${VALID_SESSION}` },
  });
  await new Promise((resolve, reject) => {
    sock.on('open', resolve);
    sock.on('error', reject);
    sock.on('unexpected-response', (_req, res) =>
      reject(new Error(`handshake rejected with ${res.statusCode}`)));
  });
  // Give the post-handshake access check a beat — a 4004 close here
  // would mean the app-level gate rejected the room join.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sock.readyState, WebSocket.OPEN);
  sock.terminate();
});

test('chat WS without credentials is rejected with 401', async () => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/chatapp`);
  const status = await new Promise((resolve, reject) => {
    sock.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    sock.on('open', () => reject(new Error('connected without credentials')));
    sock.on('error', () => {});
  });
  assert.equal(status, 401);
});
