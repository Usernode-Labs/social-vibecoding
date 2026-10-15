// The game room's live connection: one WebSocket per open page, at
// /api/live, through which a player gets the room as it changes and sends
// their moves and controls. server.js hands this the HTTP server (api.js
// attach), because Express never sees a WebSocket upgrade: so the sign-in
// check is done here, the same way server.js does it for every request.
//
// Inside Homeroom the page opens the socket with ?token=<its token>;
// signed in at the app's own address, the platform adds the token as the
// x-usernode-token header instead. A guest (no account) may watch and is
// refused every write, as the platform conventions ask of a socket.
//
// Messages are JSON. From the page: { t: 'join' | 'leave' | 'start' |
// 'again' }, { t: 'act', action }, { t: 'input', input }, { t: 'ping' }.
// To the page: { t: 'view', view } (the room as this viewer sees it, after
// every change), { t: 'frame', frame } (a live game's moving parts, many
// times a second), { t: 'event', event, version } (one small change, such
// as a block placed), { t: 'error', error } (a move that was refused),
// { t: 'pong' }.

'use strict';

const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PATH = '/api/live';
const PING_MS = 25000;
// More than this many messages in a second from one page is not a person.
const MAX_PER_SECOND = 60;

const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n');
const APP_AUDIENCE = process.env.USERNODE_APP_ID ? 'usernode:app:' + process.env.USERNODE_APP_ID : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n');
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;

/**
 * Who opened the socket: { user } for a person, { guest: true } for a
 * visitor with no account, or null for nobody (refused). The same checks as
 * server.js's middleware: pinned algorithm, issuer and audience.
 */
function identify(req, url) {
  const token = url.searchParams.get('token') || req.headers['x-usernode-token'];
  if (!token) return null;
  if (JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'], issuer: 'usernode', audience: APP_AUDIENCE });
      if (claims && claims.pur === 'iframe') return { user: { id: claims.id, username: claims.username } };
    } catch {}
  }
  if (GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, { algorithms: ['ES256'], issuer: 'usernode', audience: GUEST_AUDIENCE });
      if (guest && guest.pur === 'guest' && guest.guest === true) return { guest: true };
    } catch {}
  }
  return null;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

/** Take the room's live connections on `server`. Returns { close }. */
function attach(server, room) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://app'); } catch { url = null; }
    if (!url || url.pathname !== PATH) {
      socket.destroy();
      return;
    }
    const who = identify(req, url);
    if (!who) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => opened(ws, who.user || null));
  });

  function opened(ws, user) {
    const client = { ws, user, alive: true, window: 0, count: 0 };
    clients.add(client);
    room.connect(user);
    send(ws, { t: 'view', view: room.viewFor(user) });

    ws.on('pong', () => { client.alive = true; });
    ws.on('message', async (data) => {
      const second = Math.floor(Date.now() / 1000);
      if (second !== client.window) { client.window = second; client.count = 0; }
      client.count += 1;
      if (client.count > MAX_PER_SECOND) return;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') return send(ws, { t: 'pong' });
      // Every other message is a write: a guest only watches.
      if (!user) return send(ws, { t: 'error', error: 'account_required' });
      try {
        let out;
        if (msg.t === 'input') out = room.input(user, msg.input);
        else if (msg.t === 'act') out = room.act(user, msg.action);
        else if (msg.t === 'join') out = room.join(user);
        else if (msg.t === 'leave') out = room.leave(user);
        else if (msg.t === 'start') out = await room.start(user);
        else if (msg.t === 'again') out = room.again(user);
        else return;
        if (out && out.error) send(ws, { t: 'error', error: out.error });
      } catch (err) {
        console.error(err);
        send(ws, { t: 'error', error: 'Something went wrong on our side. Try again in a moment.' });
      }
    });
    ws.on('close', () => {
      clients.delete(client);
      room.disconnect(user);
    });
    ws.on('error', () => {});
  }

  // Everyone gets their own view after a change: a view can hide things
  // (the answer to a question) from some players and not others.
  room.on('change', () => {
    for (const c of clients) send(c.ws, { t: 'view', view: room.viewFor(c.user) });
  });
  room.on('frame', (frame) => {
    const msg = JSON.stringify({ t: 'frame', frame });
    for (const c of clients) send(c.ws, msg);
  });
  room.on('event', (event) => {
    const msg = JSON.stringify({ t: 'event', event, version: room.version });
    for (const c of clients) send(c.ws, msg);
  });

  // A connection that stops answering is closed, so "who is here" stays true.
  const ping = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }, PING_MS);
  ping.unref?.();

  return {
    close() {
      clearInterval(ping);
      for (const c of clients) {
        try { c.ws.close(1001, 'restarting'); } catch {}
      }
      wss.close();
      room.close();
    },
  };
}

module.exports = { attach, identify, PATH };
