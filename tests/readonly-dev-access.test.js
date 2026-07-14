// #621: read-only Dev tab access for non-collaborators.
//
// Covers:
//   1. guardLevelFor — reads (GET/HEAD) map to the 'view' level, every
//      other method keeps the 'collab' bar.
//   2. sessionCollabGuard / issueCollabGuard over HTTP — on a
//      collab-private + view-public app a non-collaborator passes GET but
//      404s on POST; on a fully view-private app both 404.
//   3. ws.handleMessage — mutating message types (chat/edit/react/typing)
//      from a non-collaborator are dropped before any write; a member's
//      chat message still reaches the INSERT.
//   4. Source guards pinning the per-route 'view' downgrades in
//      chat/sessions/votes/issues/topic-attributes/board-order and the
//      view-level WS connect gate, so a refactor can't silently re-raise
//      (or worse, silently lower) a gate.
//
// Run with: node --test tests/readonly-dev-access.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const appAccess = require('../src/services/app-access');

// ── 1. guardLevelFor ────────────────────────────────────────────────────

test('guardLevelFor: GET/HEAD read at view level, writes stay collab', () => {
  assert.equal(appAccess.guardLevelFor({ method: 'GET' }), 'view');
  assert.equal(appAccess.guardLevelFor({ method: 'HEAD' }), 'view');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(appAccess.guardLevelFor({ method }), 'collab');
  }
});

// ── 2. Guards over HTTP ─────────────────────────────────────────────────
//
// Stub pool keyed on query shape (same spirit as tests/app-access.test.js):
// session/issue id 1 belongs to the invite-only app (collab-private,
// view-public), id 2 to the fully private app. No app_collaborators rows,
// so the test user is a plain outsider.
const INVITE_ONLY = { id: 10, collab_visibility: 'private', view_visibility: 'public' };
const FULLY_PRIVATE = { id: 20, collab_visibility: 'private', view_visibility: 'private' };

function guardStubPool() {
  return {
    async query(sql, params = []) {
      if (/FROM app_collaborators/.test(sql)) return { rows: [] };
      if (/FROM chat_sessions cs JOIN apps a/.test(sql) || /FROM issues i JOIN apps a/.test(sql)) {
        const id = params[0];
        if (id === 1) return { rows: [INVITE_ONLY] };
        if (id === 2) return { rows: [FULLY_PRIVATE] };
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 99, username: 'outsider' }; next(); });
  const pool = guardStubPool();
  app.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));
  app.use('/api/issues/:id', appAccess.issueCollabGuard(pool));
  app.all('/api/sessions/:id/thing', (_req, res) => res.json({ ok: true }));
  app.all('/api/issues/:id/thing', (_req, res) => res.json({ ok: true }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('sessionCollabGuard: outsider reads an invite-only app, cannot write', async () => {
  const get = await fetch(`${base}/api/sessions/1/thing`);
  assert.equal(get.status, 200);
  const post = await fetch(`${base}/api/sessions/1/thing`, { method: 'POST' });
  assert.equal(post.status, 404);
});

test('sessionCollabGuard: fully view-private app 404s reads and writes', async () => {
  const get = await fetch(`${base}/api/sessions/2/thing`);
  assert.equal(get.status, 404);
  const post = await fetch(`${base}/api/sessions/2/thing`, { method: 'POST' });
  assert.equal(post.status, 404);
});

test('issueCollabGuard: same read/write split as the session guard', async () => {
  assert.equal((await fetch(`${base}/api/issues/1/thing`)).status, 200);
  assert.equal((await fetch(`${base}/api/issues/1/thing`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/issues/2/thing`)).status, 404);
  assert.equal((await fetch(`${base}/api/issues/2/thing`, { method: 'POST' })).status, 404);
});

// ── 3. WS write gate ────────────────────────────────────────────────────

const { handleMessage } = require('../src/services/ws');

// Pool that records every statement. App 10 is collab-private/view-public;
// user 5 is a member, user 99 is not.
function wsStubPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push(sql);
      if (/SELECT id, collab_visibility, view_visibility FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: 10, collab_visibility: 'private', view_visibility: 'public' }] };
      }
      if (/FROM app_collaborators/.test(sql)) {
        const [, userId] = params;
        return { rows: userId === 5 ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO chat_messages/.test(sql)) {
        return { rows: [{ id: 1234, created_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    },
  };
}

test('ws: mutating messages from a non-collaborator are dropped before any write', async () => {
  for (const msg of [
    { type: 'chat', content: 'hi' },
    { type: 'edit', messageId: 1, content: 'x' },
    { type: 'react', messageId: 1, emoji: '👍' },
    { type: 'typing' },
  ]) {
    const pool = wsStubPool();
    const client = { ws: { send() {}, readyState: 1 }, user: { id: 99, username: 'outsider' }, appId: 10, appSlug: 'inv' };
    await handleMessage(pool, client, msg);
    assert.equal(pool.queries.some((q) => /INSERT|UPDATE|DELETE/i.test(q)), false,
      `expected no writes for dropped ${msg.type}`);
  }
});

test('ws: a member chat message still reaches the insert', async () => {
  const pool = wsStubPool();
  const client = { ws: { send() {}, readyState: 1 }, user: { id: 5, username: 'member' }, appId: 10, appSlug: 'inv' };
  // Downstream fan-out (notifications/events) is best-effort and partly
  // mocked away; the assertion is only that the gate let the write start.
  try { await handleMessage(pool, client, { type: 'chat', content: 'hello' }); } catch { /* fan-out noise */ }
  assert.equal(pool.queries.some((q) => /INSERT INTO chat_messages/.test(q)), true);
});

// ── 4. Source guards for the per-route downgrades ───────────────────────

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test("chat history route reads at 'view' level", () => {
  const chat = src('src/routes/chat.js');
  const messagesRoute = chat.slice(chat.indexOf("'/api/apps/:slug/messages'"));
  assert.match(messagesRoute.slice(0, 2500), /req\.user, 'view'/);
  // The composer's mention typeahead stays collab-only.
  const mentions = chat.slice(chat.indexOf("'/api/apps/:slug/mention-suggestions'"));
  assert.match(mentions.slice(0, 1200), /req\.user, 'collab'/);
});

test("session/proposal/issue/board list routes read at 'view' level", () => {
  const cases = [
    ['src/routes/sessions.js', "'/api/apps/:slug/sessions'"],
    ['src/routes/sessions.js', "'/api/apps/:slug/shared-sessions'"],
    ['src/routes/votes.js', "'/api/apps/:slug/promoted'"],
    ['src/routes/votes.js', "'/api/apps/:slug/merged'"],
    ['src/routes/votes.js', "'/api/apps/:slug/proposals/:id'"],
    ['src/routes/issues.js', "'/api/apps/:slug/issues'"],
    ['src/routes/issues.js', "'/api/apps/:slug/github-issues'"],
    ['src/routes/issues.js', "'/api/apps/:slug/github-issues/:number/comments'"],
    ['src/routes/topic-attributes.js', "router.get('/api/apps/:slug/topics"],
    ['src/routes/board-order.js', "router.get('/api/apps/:slug/board-order'"],
  ];
  for (const [file, marker] of cases) {
    const text = src(file);
    const idx = text.indexOf(marker);
    assert.notEqual(idx, -1, `${marker} not found in ${file}`);
    assert.match(text.slice(idx, idx + 1200), /req\.user, 'view'/,
      `${marker} in ${file} should gate at 'view'`);
  }
});

test('mutating slug routes keep their collab gate', () => {
  const cases = [
    ['src/routes/sessions.js', "router.post('/api/apps/:slug/sessions'"],
    ['src/routes/issues.js', "router.post('/api/apps/:slug/issues'"],
    ['src/routes/board-order.js', "router.post('/api/apps/:slug/board-order'"],
    ['src/routes/topic-attributes.js', "router.post('/api/apps/:slug/topics"],
  ];
  for (const [file, marker] of cases) {
    const text = src(file);
    const idx = text.indexOf(marker);
    assert.notEqual(idx, -1, `${marker} not found in ${file}`);
    assert.match(text.slice(idx, idx + 1200), /req\.user, 'collab'/,
      `${marker} in ${file} should gate at 'collab'`);
  }
});

test('ws connect gate admits view-level users and re-checks writes per message', () => {
  const ws = src('src/services/ws.js');
  assert.match(ws, /checkAppAccess\(pool, app, user, 'view'\)/);
  assert.match(ws, /WRITE_MSG_TYPES = new Set\(\['chat', 'edit', 'react', 'typing'\]\)/);
  assert.match(ws, /canWriteChat/);
});
