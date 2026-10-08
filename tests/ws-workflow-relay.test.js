// What a web process does with a push a workflow machine published
// (services/ws-bus.js WORKFLOW_SENDER, src/workflow/pushes.ts): it relays it
// to its own sockets.
//
//   * a notification is named by id, not carried: the relay reads it for the
//     recipient's open tabs, and nobody else gets it;
//   * notifications_changed schedules the phone badge sync, for a workflow
//     push, not for a peer's (its emitter already did);
//   * a push too big to carry still runs the board-change reaction, from its
//     type and routing.
//
// Real sockets against ws.attach, pool stubbed via require.cache, as in
// tests/ws-session-event-routing.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocket } = require('ws');

const USERS = {
  author: { user_id: 1, username: 'ana', is_admin: false },
  other: { user_id: 2, username: 'bo', is_admin: false },
};
const reads = [];
const fakePool = {
  async query(sql, params = []) {
    if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: params[0] }] };
    if (/FROM sessions s JOIN users u/.test(sql)) {
      const user = USERS[params[0]];
      return { rows: user ? [{ ...user, expires_at: new Date(Date.now() + 3600e3).toISOString() }] : [] };
    }
    if (/FROM notifications n/.test(sql)) {
      reads.push(params[0]);
      return { rows: [{ id: params[0], kind: 'pr_merged', user_id: 1, read_at: null, created_at: new Date(0), app_id: 5,
        app_slug: 'five', app_name: 'Five', session_id: 9, pr_title: 'Dark mode', pr_number: 3, detail: {} }] };
    }
    return { rows: [] };
  },
};
const stub = (p, exports) => { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] }; };
stub('../src/db/pool', { getPool: () => fakePool });
const badges = [];
stub('../src/services/mobile-push', { scheduleBadgeSync: (userId) => { badges.push(userId); return true; } });
delete require.cache[require.resolve('../src/services/ws')];
const ws = require('../src/services/ws');

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(cookieParser());
  server = http.createServer(app);
  ws.attach(server, { jwtSecret: 'test-secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

function openEvents(who) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { cookie: `session=${who}` } });
  sock.received = [];
  sock.on('message', (raw) => { sock.received.push(JSON.parse(String(raw))); });
  return new Promise((resolve, reject) => { sock.on('open', () => resolve(sock)); sock.on('error', reject); });
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const relay = (m) => ws._onBusMessage({ oversize: false, ...m });

test('a notification named by a workflow push is read by the relay and reaches its recipient only', async () => {
  const author = await openEvents('author');
  const other = await openEvents('other');
  await settle();
  relay({ kind: 'user', routing: { userId: 1 }, data: { type: 'notification_new', notificationId: 77 }, fromWorkflow: true });
  await settle();
  assert.deepEqual(reads, [77], 'read once, outside the transition');
  const got = author.received.filter((m) => m.type === 'notification_new');
  assert.equal(got.length, 1);
  assert.equal(got[0].notification.id, 77);
  assert.ok(!('notificationId' in got[0]), 'the tabs get the notification, not the reference');
  assert.equal(other.received.filter((m) => m.type === 'notification_new').length, 0);
  // A process without the recipient's sockets reads nothing.
  reads.length = 0;
  relay({ kind: 'user', routing: { userId: 3 }, data: { type: 'notification_new', notificationId: 78 }, fromWorkflow: true });
  await settle();
  assert.deepEqual(reads, []);
  author.terminate();
  other.terminate();
});

test('a relayed workflow push schedules no badge sync: the deciding process\'s badgeSync notifier does', async () => {
  badges.length = 0;
  relay({ kind: 'user', routing: { userId: 2 }, data: { type: 'notifications_changed' }, fromWorkflow: true });
  relay({ kind: 'user', routing: { userId: 2 }, data: { type: 'notifications_changed' } });
  assert.deepEqual(badges, []);
});
