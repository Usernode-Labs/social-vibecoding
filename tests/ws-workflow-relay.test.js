// A notification a workflow machine pushes is named by id, not carried
// (src/workflow/merge-followups/machine.ts): the web process relaying it
// reads it for the recipient's open tabs, and nobody else gets it.
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

// GitHub's open-issues list is cached in each web process, which also hides
// issues it was told were just closed (GitHub's list lags). A machine says
// which it closed as a push every process relays: the relaying process
// updates its own copy, and no socket hears anything.
test('issues a workflow closed reach this process\'s copy of the open-issues list, and no socket', async () => {
  const github = require('../src/services/github');
  const calls = [];
  // Applied here only (github.js applyIssuesChange): every process hears the
  // transition itself, so none passes it on.
  const saved = { apply: github.applyIssuesChange };
  github.applyIssuesChange = (...a) => { calls.push(['apply', ...a]); };
  const sock = await openEvents('author');
  try {
    relay({ kind: 'issues_closed', routing: { owner: 'acme', repo: 'shop' }, data: { numbers: [5, 6] }, fromWorkflow: true });
    // Still open after all: shown again.
    relay({ kind: 'issues_closed', routing: { owner: 'acme', repo: 'shop' }, data: { numbers: [], open: [8] }, fromWorkflow: true });
    // Only a machine says so: a peer's publish of this kind is not one.
    relay({ kind: 'issues_closed', routing: { owner: 'acme', repo: 'shop' }, data: { numbers: [7] } });
    await settle();
    assert.deepEqual(calls, [
      ['apply', 'acme', 'shop', { closed: [5, 6], open: undefined, invalidate: true }],
      ['apply', 'acme', 'shop', { closed: [], open: [8], invalidate: true }],
    ]);
    assert.deepEqual(sock.received.filter((m) => m.type !== 'platform_version'), [], 'nothing for browsers');
  } finally {
    github.applyIssuesChange = saved.apply;
    sock.close();
  }
});

// Step 8 (workflow-foundation's design-bot-notes.md): a machine's board
// change rides its push, and the relaying process hands it to the Workshop;
// what one process changed about an app's access, every other one forgets;
// and a process whose bus came back forgets what it may have missed.
test('a machine\'s push marked as a board change reaches this process\'s Workshop listener; an unmarked one, or a route\'s, does not', () => {
  const heard = [];
  ws.onBoardChange((info) => heard.push(info));
  relay({ kind: 'scoped', routing: { appId: 5, appSlug: 'five', boardChange: true }, data: { type: 'issue_update', action: 'voted' }, fromWorkflow: true });
  relay({ kind: 'scoped', routing: { appId: 6, appSlug: 'six' }, data: { type: 'issue_update', action: 'voted' }, fromWorkflow: true });
  relay({ kind: 'scoped', routing: { appId: 7, appSlug: 'seven', boardChange: true }, data: { type: 'issue_update' }, fromWorkflow: false });
  assert.deepEqual(heard, [{ appId: 5, appSlug: 'five' }], 'once, for the machine\'s marked push only (the emitting route kicks its own)');
});

test('what another process changed about an app\'s visibility, governance or admins is forgotten here; the bus coming back forgets it all', () => {
  const appAccess = require('../src/services/app-access');
  const governance = require('../src/services/governance');
  const admins = require('../src/services/app-admins');
  const seen = [];
  const spy = (mod, name) => { const real = mod[name]; mod[name] = (...a) => { seen.push([name, ...a]); return real(...a); }; return () => { mod[name] = real; }; };
  const undo = [spy(appAccess, 'invalidateVisibilityHere'), spy(governance, 'invalidateGovernanceHere'), spy(admins, 'invalidateAppAdminsHere'),
    spy(appAccess, 'invalidateAllVisibility')];
  try {
    relay({ kind: 'app_access', routing: null, data: { appId: 5, slug: 'five' } });
    assert.deepEqual(seen, [['invalidateVisibilityHere', 5, 'five'], ['invalidateGovernanceHere', 5], ['invalidateAppAdminsHere', 5]]);
    seen.length = 0;
    ws._onBusListening();
    assert.deepEqual(seen.map((s) => s[0]).sort(), ['invalidateAllVisibility', 'invalidateAppAdminsHere', 'invalidateGovernanceHere']);
  } finally {
    for (const u of undo) u();
  }
});

test('an invalidation here is shared with every other process, which applies it without publishing again', () => {
  const bus = require('../src/services/ws-bus');
  const sent = [];
  const real = bus.publish;
  bus.publish = (kind, routing, data) => { sent.push([kind, data]); };
  try {
    require('../src/services/governance').invalidateGovernance(5);
    require('../src/services/app-access').invalidateVisibility(5, 'five');
    require('../src/services/app-admins').invalidateAppAdmins(5);
    assert.deepEqual(sent, [['app_access', { appId: 5, slug: null }], ['app_access', { appId: 5, slug: 'five' }], ['app_access', { appId: 5, slug: null }]]);
    sent.length = 0;
    relay({ kind: 'app_access', routing: null, data: { appId: 5, slug: 'five' } });
    assert.deepEqual(sent, [], 'a receiver publishes nothing');
  } finally {
    bus.publish = real;
  }
});
