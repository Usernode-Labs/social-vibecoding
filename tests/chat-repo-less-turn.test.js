// Session-2585 fix, route test for POST /api/sessions/:id/chat
// (src/routes/sessions.js): a turn on an app with no GitHub repo used to
// bail with an SSE-only 'error' event — nothing persisted, nothing
// logged, no 'done' — so the session looked dead after a refresh. The
// contract pinned here: the bail persists a 'system' status row carrying
// turnError metadata (it survives refresh) and still emits 'done' on the
// stream so turn-completion hooks fire.
//
// Same property-override harness as tests/create-session-issue-link.test.js:
// override getPool BEFORE requiring the route module, capture every query,
// mount on a real express app and read the SSE body.
//
// Run with: node --test tests/chat-repo-less-turn.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(sql, params);
  },
});

// The bail happens before any billing spend, but the payer is resolved
// up front — stub it so no real key/budget lookup runs.
const limits = require('../src/services/limits');
limits.resolveBillingPath = async () => ({ apiKey: null });

// First-message titling is fire-and-forget Haiku work — keep it inert.
const sessionTitles = require('../src/services/session-title');
sessionTitles.maybeTitleFirstMessage = () => {};
sessionTitles.refreshFromHistory = () => {};

// send() broadcasts non-SSE-only events on the global WS — no real
// socket server in tests.
const ws = require('../src/services/ws');
ws.broadcastGlobal = () => {};

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

const SESSION_ROW = {
  id: 2585,
  app_id: 494,
  user_id: 7,
  branch_name: 'dev/tester-1',
  status: 'active',
  is_headless: false,
  session_title: 'Existing title',
  pr_number: null,
  cc_session_id: null,
  app_slug: 'mypage-777ed2',
  app_name: 'MyPage',
  repo_url: null, // the broken state under test
  app_self_hosted: false,
  // appAccess.sessionCollabGuard selects a.collab_visibility +
  // a.view_visibility alongside the session; checkAppAccess THROWS when handed
  // a row without them. Model what the real SQL returns — the old
  // default-to-public branch meant this stub never exercised the gate at all.
  collab_visibility: 'public',
  view_visibility: 'public',
};

function installHandlers() {
  capturedQueries = [];
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/FROM chat_sessions cs/.test(s)) return { rows: [{ ...SESSION_ROW }] };
    if (/INSERT INTO chat_session_messages/.test(s) && /'user'/.test(s)) {
      return { rows: [{ id: 1001 }] };
    }
    return { rows: [] };
  };
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({ jwtSecret: 's' }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function parseSse(body) {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

test('repo-less turn persists a turnError status row and emits done', async (t) => {
  // The bail schedules the same 30s sessionBus cleanup timer as every
  // other turn exit — mock setTimeout so the test process isn't held
  // open for it (flushed via runAll() below).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installHandlers();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/2585/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'try again?' }),
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());

    // No bare SSE-only 'error' event anymore — a persisted status + done.
    assert.ok(!events.some((e) => e.type === 'error'), 'no transient error event');
    const status = events.find((e) => e.type === 'status');
    assert.ok(status, 'a status event was streamed');
    assert.equal(status.turnError, true);
    assert.match(status.text, /no GitHub repository/);
    assert.ok(events.some((e) => e.type === 'done'), 'the turn ends with done');

    // The user's message row was stored (pre-existing behavior)…
    assert.ok(capturedQueries.some((q) =>
      /INSERT INTO chat_session_messages/.test(q.sql) && /'user'/.test(q.sql)));
    // …and the failure is now a persisted 'system' row with turnError.
    const systemInsert = capturedQueries.find((q) =>
      /INSERT INTO chat_session_messages/.test(q.sql) && /'system'/.test(q.sql));
    assert.ok(systemInsert, 'a system status row was persisted');
    assert.match(systemInsert.params[1], /no GitHub repository/);
    assert.equal(JSON.parse(systemInsert.params[2]).turnError, true);
  } finally {
    t.mock.timers.runAll();
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
