'use strict';

// #2236: a note a coding agent posts on a person's behalf through the
// Homeroom MCP connector is marked `posted_via = 'agent'`, and every surface
// that draws a human reply wears a "via agent" chip beside the author.
//
// The marker is a SERVER fact. The connector's loopback write to
// POST /api/apps/:slug/messages authenticates with a connector bearer, the
// one path that sets `req.connectorClientId` (routes/cli-auth.js); the route
// reads that and nothing in the body. So the contract under test is:
//
//   * the route hands the WS handler `postedVia: 'agent'` for a connector
//     request, and null for a browser session or a plain CLI token — and a
//     body claiming `posted_via` changes nothing either way;
//   * the WS handler persists the column and echoes it on the broadcast;
//   * the history SELECT and the write response carry `posted_via`;
//   * the group-chat view model, the transcript row and the Activity feed's
//     bubble render the chip, with `data-posted-via` on the row, only when
//     the row says 'agent';
//   * the staging mock stream (`?demo=1`) carries one agent row, which is
//     what the declared check reads on the demo issue's discussion. (The
//     Activity feed has no check of its own: the feed-comments capture
//     unfolds a row whose thread, on a production-cloned staging database,
//     already has a genuine transcript, and the mock only stands in for an
//     empty one. Its chip is pinned by the render test below instead.)
//
// Run with: node --test tests/agent-posted-via.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const express = require('express');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ── Route: the marker comes from the credential, never the body ─────────

const poolMod = require('../src/db/pool');
const pool = { query: async () => ({ rows: [] }) };
poolMod.getPool = () => pool;

const appAccessId = require.resolve('../src/services/app-access');
require.cache[appAccessId] = {
  id: appAccessId, filename: appAccessId, loaded: true, paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, slug) => (slug === 'demo' ? { id: 7, slug: 'demo' } : null),
    checkAppAccess: async () => true,
  },
};

const wsId = require.resolve('../src/services/ws');
let handleCalls = [];
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true, paths: [],
  exports: {
    handleMessage: async (...args) => {
      handleCalls.push(args);
      const client = args[1];
      return {
        ok: true,
        message: {
          id: 31, userId: client.user.id, username: client.user.username,
          content: args[2].content, msgType: 'message', thread: args[2].thread,
          createdAt: '2026-09-15T10:00:00.000Z', postedVia: client.postedVia,
        },
      };
    },
    getReactionsForMessages: async () => ({}),
  },
};

// The stubs stay in place for the whole file, as in
// tests/chat-message-write-route.test.js: the route requires the WS module
// lazily, per request, so a stub restored before the first request is a
// stub that was never hit.
const { chatRoutes, postedViaFor, stagingMockGroupChat } = require('../src/routes/chat');

async function startServer(decorate) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { decorate(req); next(); });
  app.use(chatRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(server, body) {
  return fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('postedViaFor reads only the connector credential', () => {
  assert.equal(postedViaFor({ connectorClientId: 'homeroom-mcp', cliAuthenticated: true }), 'agent');
  assert.equal(postedViaFor({ cliAuthenticated: true }), null, 'a plain CLI token is a person');
  assert.equal(postedViaFor({ user: { id: 1 } }), null, 'a browser session is a person');
  assert.equal(postedViaFor({ body: { posted_via: 'agent' } }), null, 'the body cannot claim it');
  assert.equal(postedViaFor(undefined), null);
});

test('a connector-authenticated write is handed to the chat handler as posted via agent', async () => {
  handleCalls = [];
  const server = await startServer((req) => {
    // What routes/cli-auth.js connectorApiBearerChain leaves on the request.
    req.user = { id: 5, username: 'alice' };
    req.cliAuthenticated = true;
    req.connectorClientId = 'homeroom-mcp';
  });
  try {
    const res = await post(server, { content: 'Reproduced; drafting a fix.', thread_type: 'issue', thread_ref: 864 });
    assert.equal(res.status, 201);
    assert.equal(handleCalls.length, 1);
    assert.equal(handleCalls[0][1].postedVia, 'agent');
    assert.deepEqual(handleCalls[0][2], {
      type: 'chat', content: 'Reproduced; drafting a fix.', thread: { type: 'issue', ref: 864 },
    }, 'the marker rides on the client, not in the message');
    const { message } = await res.json();
    assert.equal(message.posted_via, 'agent', 'the write response says so too');
  } finally {
    server.close();
  }
});

test('a browser session and a plain CLI token stay unmarked, whatever the body claims', async () => {
  for (const decorate of [
    (req) => { req.user = { id: 5, username: 'alice' }; },
    (req) => { req.user = { id: 5, username: 'alice' }; req.cliAuthenticated = true; },
  ]) {
    handleCalls = [];
    const server = await startServer(decorate);
    try {
      const res = await post(server, {
        content: 'hello', thread_type: 'issue', thread_ref: 864, posted_via: 'agent', postedVia: 'agent',
      });
      assert.equal(res.status, 201);
      assert.equal(handleCalls[0][1].postedVia, null);
      const { message } = await res.json();
      assert.equal(message.posted_via, null);
    } finally {
      server.close();
    }
  }
});

test('the history SELECT carries posted_via for every reader of the thread', () => {
  const src = read('src/routes/chat.js');
  assert.match(src, /SELECT m\.id, m\.user_id, u\.username, m\.content, m\.msg_type, m\.metadata,\s*\n\s*m\.thread_type, m\.thread_ref, m\.created_at, m\.edited_at, m\.posted_via/);
});

test('the staging mock stream carries exactly one agent row, and it is the newest human row', () => {
  const rows = stagingMockGroupChat(1, { type: 'issue', ref: 900008 });
  const agent = rows.filter((r) => r.posted_via === 'agent');
  assert.equal(agent.length, 1);
  assert.equal(agent[0].username, 'staging-demo-agent');
  assert.equal(agent[0].msg_type, 'message');
  assert.equal(agent[0].user_id, 0, 'never a real user’s row');
  assert.match(agent[0].content, /^\[Mock\] /);
  assert.ok(!/—/.test(agent[0].content), 'no em dash in platform copy');
  const human = rows.filter((r) => r.msg_type === 'message');
  assert.equal(human[human.length - 1], agent[0], 'last human row, so the feed preview shows it');
  for (const r of rows) assert.ok('posted_via' in r, 'every mock row spells the column');
});

test('the boot schema adds the nullable column idempotently', () => {
  assert.match(read('src/db/schema.sql'), /ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS posted_via VARCHAR\(16\);/);
});

// ── WS handler: persisted and broadcast ─────────────────────────────────

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadWs() {
  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: class {} };
    if (request === 'jsonwebtoken') return { verify: () => ({}), sign: () => '' };
    return _origLoad.call(this, request, ...rest);
  };
  const ids = {
    pool: require.resolve('../src/db/pool'),
    logger: require.resolve('../src/services/logger'),
    notifications: require.resolve('../src/services/notifications'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    subject: require.resolve('../src/services/ws'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.notifications, {
    createReplyNotification: async () => [],
    createMentionNotifications: async () => [],
  });
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, { checkAppAccess: async () => true });
  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');
  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

function makePool() {
  const seen = [];
  return {
    seen,
    insert() { return seen.find((q) => /INSERT INTO chat_messages/.test(q.sql)); },
    async query(sql, params) {
      seen.push({ sql, params });
      if (/FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
      }
      if (/INSERT INTO chat_messages/.test(sql)) {
        return { rows: [{ id: 321, created_at: '2026-09-15T12:00:00.000Z' }] };
      }
      return { rows: [] };
    },
  };
}

test('the chat handler persists posted_via and echoes it on the broadcast', async () => {
  const { handleMessage } = loadWs();
  for (const [postedVia, expected] of [['agent', 'agent'], [null, null], [undefined, null], ['bogus', null]]) {
    const pool = makePool();
    const client = { user: { id: 5, username: 'alice' }, appId: 7, ...(postedVia === undefined ? {} : { postedVia }) };
    const result = await handleMessage(pool, client, { type: 'chat', content: 'note' });
    assert.equal(result.ok, true);
    const ins = pool.insert();
    assert.ok(ins, 'INSERT ran');
    assert.match(ins.sql, /thread_ref, posted_via\)\s*\n\s*VALUES \(\$1, \$2, \$3, 'message', \$4, \$5, \$6, \$7\)/);
    assert.equal(ins.params[6], expected, `posted_via param for ${String(postedVia)}`);
    assert.equal(result.message.postedVia, expected, 'the broadcast row carries the same value');
  }
});

// ── Rendering: the view model, the transcript row, the feed bubble ──────

function loadGroupChat() {
  const gcJs = read('public/js/group-chat.js');
  const document = {
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams, document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

test('the view model reads the marker off a loaded row and a live one, and nothing else', () => {
  const gc = loadGroupChat();
  const base = { id: 9, msg_type: 'message', username: 'evan', content: 'hi', created_at: '2026-09-15T10:00:00Z' };
  assert.equal(gc._messageView({ ...base, posted_via: 'agent' }).postedVia, 'agent', 'REST spelling');
  assert.equal(gc._messageView({ ...base, postedVia: 'agent' }).postedVia, 'agent', 'broadcast spelling');
  assert.equal(gc._messageView(base).postedVia, null, 'a person typing');
  assert.equal(gc._messageView({ ...base, posted_via: 'robot' }).postedVia, null, 'only the value the server writes');
});

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const FEED = 'frontend/src/features/dev-board/card/feed-thread.tsx';

const rowBase = {
  id: 5, kind: 'message', username: 'evan', time: '10:00', timeTitle: 't', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
  showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [],
  attachments: [], voteRowClass: '', voteRef: null, specShare: null,
};

test('the transcript row wears the chip and data-posted-via only for an agent row', () => {
  const { MessageRow } = loadTsx(TRANSCRIPT);
  const agent = renderToHtml(createElement(MessageRow, { msg: { ...rowBase, postedVia: 'agent' } }));
  assert.match(agent, /<div class="[^"]*\bgc-msg\b[^"]*"[^>]*data-posted-via="agent"/, 'the row carries the attribute');
  assert.match(agent, /<span class="[^"]*\bgc-posted-via\b[^"]*"[^>]*title="Posted by a coding agent on this person(?:'|&#x27;|&#39;)s behalf"[^>]*>.*?<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>via agent<\/span>/s,
    'the chip: a sparkle glyph then the words');
  assert.match(agent, /gc-msg-username|<span>evan<\/span>/, 'the author name is still drawn');
  assert.match(agent, /bg-violet-50[^"]*text-violet-700/, 'shell palette, not the admin console’s');
  assert.ok(!/—/.test(agent), 'no em dash in platform copy');

  const person = renderToHtml(createElement(MessageRow, { msg: rowBase }));
  assert.ok(!/data-posted-via/.test(person), 'an ordinary row has no attribute');
  assert.ok(!/gc-posted-via|via agent/.test(person), 'and no chip');
});

test('the Activity feed bubble wears the same chip, from the REST spelling', () => {
  const { MessageLine, feedThreadPreview } = loadTsx(FEED);
  const rows = [
    { id: 1, username: 'evan', user_id: 2, content: 'typed', created_at: '2026-09-15T09:00:00Z', msg_type: 'message' },
    { id: 2, username: 'evan', user_id: 2, content: 'noted', created_at: '2026-09-15T10:00:00Z', msg_type: 'message', posted_via: 'agent' },
  ];
  const { messages } = feedThreadPreview(rows);
  assert.deepEqual(messages.map((m) => m.postedVia), [null, 'agent']);

  const agent = renderToHtml(createElement(MessageLine, { m: messages[1] }));
  assert.match(agent, /<div class="dev-feed-msg" data-posted-via="agent">/);
  assert.match(agent, /<span class="dev-feed-msg-author">evan<\/span><span class="[^"]*\bgc-posted-via\b[^"]*"[^>]*>.*?via agent<\/span><time/s,
    'author, chip, then the age, on the head line');
  const person = renderToHtml(createElement(MessageLine, { m: messages[0] }));
  assert.ok(!/data-posted-via|gc-posted-via/.test(person));
});

test('one declared check reads the mock agent row on the demo issue\u2019s discussion', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const checks = dapp.tests.filter((t) => /#2236/.test(t.name));
  assert.equal(checks.length, 1);
  assert.match(checks[0].path, /^\/\?demo=1#app\/usernode-2d5619\/dev\/issues\/\d+$/);
  assert.match(checks[0].expectSelector, /#gc-thread-messages \.gc-msg\[data-posted-via="agent"\]\[data-username="staging-demo-agent"\] \.gc-posted-via/);
  assert.equal(checks[0].expectText, 'via agent');
});
