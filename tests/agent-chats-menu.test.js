'use strict';

// Where a person reaches their agent chats from (#4729, and the
// first-session run-through of 5 Oct 2026 before it): the mark's menu lists
// no agent entries any more — the section (its heading, Build it now, the
// session rows and "Show more") moved whole to Messages, whose Agents list
// is their one home. What stays pinned here:
//
//   1. THE SIGNAL. GET /api/agent-sessions says `started`: whether the viewer
//      has ever had an agent session, archived ones included, read with one
//      EXISTS only when the page is empty. The store keeps it, and the first
//      message of a new session sets it at once. It gates Messages' Agents
//      list's "Show archived" group now, the way it gated the menu's section
//      before: never shown to a viewer who has built nothing, and never
//      taken back in the document.
//   2. THE MENU HAS NOTHING OF THEIRS. No section, no Build it now, and
//      nothing in the prerender either; starting one is Messages' "+".
//   3. THE OTHER DOORS are still there for somebody who has none: the hub's
//      ⋯, a request's Build it now, Messages' new chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const STORE = 'frontend/src/features/agent-session/store.ts';
const SHEET = 'frontend/src/features/app-context/app-context-sheet.tsx';

const listed = (id) => ({
  id, title: `Session ${id}`, status: 'open', lastActivityAt: '2026-10-05T10:00:00Z',
  focusApp: null, activeChange: null,
});

// The store with a server whose list answers `answer()` each time it is read.
function withList(answer) {
  globalThis.window = {
    location: { hash: '' },
    App: { setHeaderTitle() {}, user: { id: 1 } },
    UsernodeReact: {},
    PlatformUI: { toast() {} },
  };
  globalThis.fetch = async (url) => {
    if (url === '/api/agent-sessions') {
      return { ok: true, status: 200, json: async () => answer() };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return loadTsx(STORE);
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.fetch;
  delete globalThis.EventSource;
}

// ── 1. The signal ──────────────────────────────────────────────────────

test('a newcomer with no agent session: the menu has no Agent chats', async () => {
  try {
    const store = withList(() => ({ sessions: [], nextBefore: null, started: false }));
    assert.equal(store.agentChatsShown(store.getAgentSessionState()), false, 'before the list is read');
    await store.loadAgentSessions();
    const state = store.getAgentSessionState();
    assert.equal(state.sessionsLoaded, true);
    assert.equal(state.sessionsStarted, false);
    assert.equal(store.agentChatsShown(state), false, 'and after: nothing to show them');
  } finally {
    cleanup();
  }
});

test('somebody with a session, or whose sessions are all archived, has Agent chats', async () => {
  try {
    let answer = { sessions: [listed(1)], nextBefore: null, started: true };
    const store = withList(() => answer);
    await store.loadAgentSessions();
    assert.equal(store.agentChatsShown(store.getAgentSessionState()), true, 'an open session');
  } finally {
    cleanup();
  }
  try {
    const store = withList(() => ({ sessions: [], nextBefore: null, started: true }));
    await store.loadAgentSessions();
    const state = store.getAgentSessionState();
    assert.deepEqual(state.sessions, []);
    assert.equal(store.agentChatsShown(state), true, 'all archived: they have still built something themselves');
  } finally {
    cleanup();
  }
  try {
    // A server from before `started` existed: a listed session says it.
    const store = withList(() => ({ sessions: [listed(2)], nextBefore: null }));
    await store.loadAgentSessions();
    assert.equal(store.getAgentSessionState().sessionsStarted, true);
  } finally {
    cleanup();
  }
});

test('once shown it stays for the document, even if a later read lists nothing', async () => {
  try {
    let answer = { sessions: [listed(1)], nextBefore: null, started: true };
    const store = withList(() => answer);
    await store.loadAgentSessions();
    answer = { sessions: [], nextBefore: null, started: false };
    await store.loadAgentSessions();
    assert.equal(store.agentChatsShown(store.getAgentSessionState()), true,
      'a section that came and went under the viewer would be worse than either');
  } finally {
    cleanup();
  }
});

test('the first message of a first session shows Agent chats at once, with no reload or re-read', async () => {
  const session = {
    id: 7, title: null, status: 'open', focusApp: { id: 3, slug: 'notes-ab12', name: 'Notes' }, focusContext: { entry: 'issue' },
    agent: null, activeChange: null, busy: false, lastActivityAt: null, createdAt: null,
  };
  const win = {
    location: { hash: '#agent/new' },
    history: { state: null, replaceState: (_s, _u, url) => { win.location.hash = url; } },
    App: { restoreFromHash() {}, setHeaderTitle() {}, user: { id: 1 } },
    UsernodeReact: {},
    PlatformUI: { toast() {} },
  };
  const requests = [];
  globalThis.window = win;
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    const body = url.startsWith('/api/agent-sessions/draft')
      ? { draft: { focusApp: session.focusApp, focusContext: { entry: 'issue' } } }
      : url === '/api/agent-sessions' && init.method === 'POST' ? { session }
        : url === '/api/agent-sessions' ? { sessions: [], nextBefore: null, started: false }
          : /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
            : /\/actions$/.test(url) ? { actions: [] }
              : { session, turn: null };
    return { ok: true, status: 200, body: null, json: async () => body };
  });
  try {
    const store = loadTsx(STORE);
    await store.loadAgentSessions();
    assert.equal(store.agentChatsShown(store.getAgentSessionState()), false, 'a newcomer');
    // From another door: a request's Build it now opens an unsent
    // conversation (AppView.chooseIssueWork → Improve._startAgentSession).
    store.prepareAgentDraft({ slug: 'notes-ab12', issueNumber: 12, entry: 'issue' });
    await store.openAgentSession({ id: 'new', host: 'screen' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.agentChatsShown(store.getAgentSessionState()), false, 'an unsent conversation is not a session yet');
    const reads = requests.filter(([url, method]) => url === '/api/agent-sessions' && method === 'GET').length;
    await store.sendAgentMessage('Add dark mode');
    assert.ok(requests.some(([url, method]) => url === '/api/agent-sessions' && method === 'POST'), 'the session is created');
    const state = store.getAgentSessionState();
    assert.equal(state.sessionsStarted, true);
    assert.equal(store.agentChatsShown(state), true, 'and the menu has Agent chats from that moment');
    assert.equal(requests.filter(([url, method]) => url === '/api/agent-sessions' && method === 'GET').length, reads,
      'without waiting for the list to be read again');
  } finally {
    cleanup();
  }
});

test('the server says `started` from the page, or from one EXISTS when the page is empty', async () => {
  const agentSessions = require('../src/services/agent-sessions');
  const run = async ({ page, exists }) => {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push([sql, params]);
        if (/FROM agent_sessions s/.test(sql)) return { rows: page };
        if (/SELECT EXISTS \(SELECT 1 FROM agent_sessions WHERE user_id = \$1\) AS started/.test(sql)) return { rows: [{ started: exists }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const result = await agentSessions.listAgentSessions(pool, { userId: 4 });
    return { result, calls };
  };
  const row = { id: 7, user_id: 4, title: 't', title_source: 'auto', status: 'open' };

  let { result, calls } = await run({ page: [row], exists: false });
  assert.equal(result.started, true, 'a listed session says it');
  assert.equal(calls.length, 1, 'with no second read');

  ({ result, calls } = await run({ page: [], exists: true }));
  assert.equal(result.started, true, 'archived ones count');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], [4], 'the viewer\'s own, and nobody else\'s');

  ({ result, calls } = await run({ page: [], exists: false }));
  assert.equal(result.started, false, 'a newcomer');

  // The route hands the whole result on, `started` with it.
  assert.match(read('src/routes/agent-sessions.js'), /return res\.json\(\{ \.\.\.result, sessions \}\);/);
  // And the client reads it, falling back to a listed session.
  assert.match(read('frontend/src/features/agent-session/api.ts'),
    /return \{ sessions, started: body\.started === true \|\| sessions\.length > 0 \};/);
});

// ── 2. The menu has nothing of theirs ──────────────────────────────────

test('the mark\'s menu has no agent entries, in the prerender and after mount (#4729)', () => {
  const src = read(SHEET);
  assert.doesNotMatch(src, /app-menu-sessions|improve-row-new-session/,
    'no Agent chats section and no Build it now row');
  assert.doesNotMatch(src, /function AgentChats|<AgentChats/, 'no section component left');
  assert.doesNotMatch(src, /useAgentChatsShown|loadAgentSessions/,
    'and the sheet no longer reads the session list at all');
  // The prerender and the hydrating render agree: the app's own rows are
  // there, and nothing of the agent chats is.
  const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts');
  const html = renderToHtml(createElement(ui.AppsSwitcherSheet));
  assert.match(html, /id="app-menu-row-about"/, 'the app\'s own rows are there');
  assert.doesNotMatch(html, /app-menu-sessions|improve-row-new-session|Agent chats/);
  // The signal that gated the menu's section now gates Messages' Agents
  // list's "Show archived" group, in the list that is agent chats' home.
  const list = read('frontend/src/features/messages/index.tsx');
  assert.match(list, /const agentChatsShown = useAgentChatsShown\(\);/);
  assert.match(list, /const showArchivedToggle = mounted && !!agentChatsShown && snap\.filter === 'agents' && !deferredQuery\.trim\(\);/,
    'after mount (the hydrating render matches the prerender), for somebody who has had an agent session, on the Agents list, with no query: search does not cover the archived');
  const store = read(STORE);
  assert.match(store, /export function agentChatsShown\(current: Pick<AgentSessionState, 'sessionsStarted' \| 'sessions'>\): boolean \{\s*return current\.sessionsStarted \|\| current\.sessions\.length > 0;\s*\}/);
  assert.match(store, /export function useAgentChatsShown\(\): boolean \{\s*return useAgentSessionSelector\(agentChatsShown\);\s*\}/);
});

// ── 3. The other doors ─────────────────────────────────────────────────

test('a newcomer still has every other door to building it themselves', () => {
  const row = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(row, /data-plus="new-change"[\s\S]{0,300}title=\{t\('project:menu\.build\.title'\)\}[\s\S]{0,200}Improve\.startSession\(\)/, 'the hub\'s ⋯');
  assert.equal(message('project:menu.build.title'), 'Build it now');
  const view = read('public/js/app-view.js');
  assert.match(view, /label: PlatformI18n\.t\('changes:issue\.action\.buildNow'\),\s*title: PlatformI18n\.t\('changes:issue\.action\.buildNowTitle'\),\s*act: \{ fn: 'chooseIssueWork', args: \[n\] \}/, 'a request\'s own');
  assert.equal(message('changes:issue.action.buildNow'), 'Build it now');
  assert.equal(message('changes:issue.action.buildNowTitle'), 'Start an agent session on this request');
  assert.equal(message('messages:inbox.new.agent.label'), 'Build it now');
  assert.equal(message('messages:inbox.new.agent.hint'), 'Plan and build a change with a coding agent');
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /\{ key: 'agent', label: 'messages:inbox\.new\.agent\.label', hint: 'messages:inbox\.new\.agent\.hint' \}/, 'Messages\' new chat');
  // The tour no longer points a newcomer at the menu's row.
  assert.doesNotMatch(read('frontend/src/features/home/tour/tour-steps.ts'), /tap Build it now/);
  // Nor do the Workshop's notes: they name the hub's ⋯.
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.doesNotMatch(workshop, /Build it now in the Homeroom menu|Start a new change in the Homeroom menu/);
});
