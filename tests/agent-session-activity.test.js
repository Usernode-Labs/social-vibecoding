'use strict';

// What an agent session is doing, marked in every list (#2779 follow-up).
//
//   1. A SPINNER while its turn runs (the lease is held, which covers a scout
//      or a build the turn dispatched), and a GREEN DOT once a turn finished
//      after the owner last read the conversation. Nothing otherwise.
//   2. The same mark in Recents, the platform mark's Continue rows and
//      Messages, from the same two fields the server sends (busy, doneUnseen).
//   3. The lists follow it live: a turn starting or ending, or the
//      conversation being read in another tab, pushes `agent_session_changed`
//      to the owner, and the list is read again (once per burst). Reading the
//      conversation marks it seen before the read answers, and the list's own
//      entry follows the conversation on screen at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('working is a spinner, finished-unseen a green dot, and nothing else is marked', () => {
  const { agentActivity } = loadTsx('frontend/src/features/agent-session/activity.ts');
  assert.equal(agentActivity({ busy: true }), 'working');
  assert.equal(agentActivity({ busy: true, doneUnseen: true }), 'working', 'working wins: it is not done yet');
  assert.equal(agentActivity({ busy: false, doneUnseen: true }), 'done');
  assert.equal(agentActivity({ busy: false, doneUnseen: false }), null);
  assert.equal(agentActivity(null), null);

  const { AgentActivityMark } = loadTsx('frontend/src/features/agent-session/activity-mark.tsx');
  const working = renderToHtml(createElement(AgentActivityMark, { activity: 'working' }));
  assert.match(working, /role="img" aria-label="Working" title="Working" data-agent-activity="working"/);
  assert.match(working, /<svg[^>]*class="h-3\.5 w-3\.5 animate-spin/);
  const done = renderToHtml(createElement(AgentActivityMark, { activity: 'done' }));
  assert.match(done, /aria-label="Finished"[^>]*data-agent-activity="done"[^>]*class="[^"]*rounded-full bg-green-500/,
    'the live-app dot\'s green');
  assert.equal(renderToHtml(createElement(AgentActivityMark, { activity: null })), '');
});

test('Recents, the mark\'s Continue rows and Messages all draw it', () => {
  const recents = loadTsx('frontend/src/features/nav/recents.ts');
  const items = recents.buildRecents({
    apps: [], conversations: [], discussions: [], agents: [],
    agentSessions: [
      { id: 1, title: 'Busy', status: 'open', lastActivityAt: '2026-09-24T12:00:00Z', busy: true },
      { id: 2, title: 'Done', status: 'open', lastActivityAt: '2026-09-24T11:00:00Z', doneUnseen: true },
      { id: 3, title: 'Idle', status: 'open', lastActivityAt: '2026-09-24T10:00:00Z' },
    ],
  });
  assert.deepEqual(items.map((i) => [i.key, i.activity]), [
    ['agent-session:1', 'working'], ['agent-session:2', 'done'], ['agent-session:3', null],
  ]);
  const row = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(row, /\{item\.activity \? <AgentActivityMark activity=\{item\.activity\} className="platform-recent-activity" \/> : null\}/);
  assert.match(row, /aria-label=\{`\$\{KIND_NAMES\[item\.kind\]\}: \$\{item\.label\}\$\{loaded\}\$\{doing\}\$\{unread\}`\}/,
    'and the row\'s name says it');

  const messages = read('frontend/src/features/messages/index.tsx');
  const mayorRow = messages.slice(messages.indexOf('function MayorSessionRow('), messages.indexOf('function AgentChatThread('));
  assert.match(mayorRow, /<AgentActivityMark activity=\{agentActivity\(session\)\} \/>/, 'where a conversation\'s unread count goes');
  assert.match(read('frontend/src/features/app-context/app-context-sheet.tsx'), /<AgentActivityMark activity=\{row\.activity\} \/>/);
});

test('a burst of pushes is one read of the list, and the open conversation keeps its list entry current', async () => {
  const requests = [];
  let listDone = true;
  const session = (over) => ({
    id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, activeChange: null,
    busy: false, doneUnseen: listDone, lastActivityAt: null, createdAt: null, ...over,
  });
  // A signed-in member: the list waits for a viewer the endpoint will answer
  // (QA 2026-09-24 Q35, lib/platform-viewer.ts), which is `App.user`.
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {}, user: { id: 1 } }, UsernodeReact: {} };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url) => {
    requests.push(url);
    const body = url.startsWith('/api/agent-sessions?') || url === '/api/agent-sessions'
      ? { sessions: [session({ doneUnseen: listDone })], nextBefore: null }
      : /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
        : /\/actions$/.test(url) ? { actions: [] }
          : { session: session({ doneUnseen: false }), turn: null };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    await store.loadAgentSessions();
    assert.equal(store.getAgentSessionState().sessions[0].doneUnseen, true, 'finished while you were away');

    // Opening it reads it: the list's entry is the fresh one, dot gone.
    await store.openAgentSession({ id: 7, host: 'messages' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getAgentSessionState().sessions[0].doneUnseen, false, 'the list follows the conversation on screen');

    const lists = () => requests.filter((u) => /^\/api\/agent-sessions(\?|$)/.test(u)).length;
    const before = lists();
    store.agentSessionListChanged();
    store.agentSessionListChanged();
    store.agentSessionListChanged();
    assert.equal(lists(), before, 'not at once');
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(lists(), before + 1, 'one read for the burst');
    assert.equal(window.UsernodeReact.agentSession.listChanged, store.agentSessionListChanged, 'what app.js calls');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the push reaches the lists, and reading the conversation marks it seen before it answers', () => {
  const app = read('public/js/app.js');
  assert.match(app, /case 'agent_session_changed':[\s\S]{0,300}window\.UsernodeReact\?\.agentSession\?\.listChanged\?\.\(data\);/);
  const route = read('src/routes/agent-sessions.js');
  const get = route.slice(route.indexOf("router.get('/api/agent-sessions/:id'"));
  const seen = get.indexOf('agentSessions.markSeen(pool, { userId: req.user.id, id: req.params.id })');
  assert.ok(seen > 0 && seen < get.indexOf('agentSessions.getAgentSession('), 'seen first, so the answer carries no dot');
  assert.match(get.slice(0, 1600), /if \(cleared\) \{\s+require\('\.\.\/services\/ws'\)\.pushToUser\(req\.user\.id, \{ type: 'agent_session_changed'/,
    'the owner\'s other tabs clear their dot too');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS last_done_at TIMESTAMPTZ;/);
  assert.match(schema, /ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;/);
});
