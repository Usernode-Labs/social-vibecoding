'use strict';

// Where your work in progress is (#2779 follow-up).
//
// Four lists said four different things about the same work: the Workshop
// listed a paused session, Messages and the bell hid it, Recents never listed
// sessions at all, and the platform mark's menu listed nothing. The rules are
// one set now, and "paused" is the platform's bookkeeping rather than a state
// anybody is shown or asked to manage:
//
//   1. PAUSED IS NEVER SHOWN AND NEVER ASKED FOR. A session pauses by itself a
//      few idle minutes after it was used, the least recently used one pauses
//      when new work needs its slot, and opening or messaging a session
//      resumes it. No list hides it, no label names it, no error asks the
//      user to pause something.
//   2. A CONVERSATION STANDS FOR THE CHANGES IT STARTED: they are opened
//      through it, and not listed again beside it.
//   3. The platform mark's menu offers up to three of your in-progress items
//      on the app it is about, conversations first; Recents lists agent
//      sessions on its one clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const model = loadTsx('frontend/src/features/app-context/continue-model.ts');
const recents = loadTsx('frontend/src/features/nav/recents.ts');

const conversation = (over = {}) => ({
  id: 7, title: 'Dark mode', status: 'open', lastActivityAt: '2026-09-24T10:00:00Z',
  focusApp: { slug: 'notes' }, activeChange: { appSlug: 'notes', status: 'paused', title: 'Dark mode toggle' },
  ...over,
});
test('the mark\'s Continue rows: agent sessions only, newest first, paused like any other', () => {
  const rows = model.continueRows('notes', [
    conversation(),
    conversation({ id: 8, title: null, lastActivityAt: '2026-09-24T11:00:00Z', activeChange: { appSlug: 'notes', status: 'active', title: null }, busy: true }),
    conversation({ id: 11, title: null, lastActivityAt: '2026-09-24T12:00:00Z', activeChange: null }),
    conversation({ id: 9, activeChange: { appSlug: 'recipes', status: 'active', title: 'x' } }),
    conversation({ id: 10, status: 'archived' }),
    conversation({ id: 12, lastActivityAt: '2026-09-24T09:00:00Z', activeChange: null, doneUnseen: true }),
  ], 5);
  assert.deepEqual(rows.map((r) => r.key), ['agent:8', 'agent:7', 'agent:12']);
  assert.deepEqual(rows.map((r) => r.href), ['#messages/agent/8', '#messages/agent/7', '#messages/agent/12'],
    'a conversation opens itself');
  assert.equal(rows[0].title, 'Agent session', 'an untitled conversation still says what it is');
  assert.ok(!rows.some((r) => r.key === 'agent:11'), 'one nothing was said in yet is not work in progress');
  assert.equal(rows[1].detail, 'In progress', 'a paused change reads as the work in progress it is');
  assert.deepEqual(rows.map((r) => r.activity), ['working', null, 'done'], 'each with the lists\' mark');
  assert.equal(model.continueRows('notes', [conversation(), conversation({ id: 2 }), conversation({ id: 3 }), conversation({ id: 4 })]).length, 3,
    'three at most by default');
  assert.deepEqual(model.continueRows(null, [conversation()]), [], 'no app, no rows');
  assert.doesNotMatch(read('frontend/src/features/app-context/continue-model.ts'), /improve/i, 'classic changes are the Workshop\'s, one row up');
});

test('the mark\'s menu: the app\'s own rows first, then Continue, after mount only, with "See all sessions"', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /const continuing = mounted && view !== 'about'/, 'never in the prerender: the hydrating render matches it');
  assert.match(sheet, /if \(open && window\.App\?\.user\) void loadAgentSessions\(\);/,
    'for any signed-in viewer: the flag never hides a conversation that exists');
  const at = (id) => sheet.indexOf(`id="${id}"`);
  assert.ok(at('app-menu-row-workshop') < at('app-menu-row-discussion')
    && at('app-menu-row-discussion') < at('app-menu-row-about')
    && at('app-menu-row-about') < at('app-menu-continue'),
    'Go to workshop, the discussion and About are the app\'s section; Continue follows them');
  assert.match(sheet, /id="app-menu-continue-all"[\s\S]{0,200}label="See all sessions"[\s\S]{0,200}setMessagesFilter\('agents'\)/);
  assert.match(sheet, /<AgentActivityMark activity=\{row\.activity\} \/>/);
  assert.doesNotMatch(sheet, /See all your work|continue-change/);
});

test('Recents lists open agent sessions on its one clock', () => {
  const items = recents.buildRecents({
    apps: [],
    conversations: [{ id: 3, kind: 'direct', title: 'x', lastActivityAt: '2026-09-24T09:30:00Z', unreadCount: 0, peer: { id: 2, username: 'bo' } }],
    discussions: [],
    agents: [],
    agentSessions: [
      { id: 7, title: 'Dark mode', status: 'open', lastActivityAt: '2026-09-24T10:00:00Z' },
      { id: 8, title: null, status: 'open', lastActivityAt: null, createdAt: '2026-09-24T08:00:00Z', activeChange: { id: 41 } },
      { id: 10, title: null, status: 'open', lastActivityAt: '2026-09-24T12:00:00Z', activeChange: null },
      { id: 9, title: 'Old', status: 'archived', lastActivityAt: '2026-09-24T11:00:00Z' },
    ],
  });
  assert.deepEqual(items.map((i) => [i.key, i.href]), [
    ['agent-session:7', '#messages/agent/7'],
    ['conversation:3', '#messages/3'],
    ['agent-session:8', '#messages/agent/8'],
  ]);
  assert.equal(items[2].label, 'New session');
  assert.ok(!items.some((i) => i.key === 'agent-session:10'), 'an empty one is not history');
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list, /if \(viewer\) void loadAgentSessions\(\);/);
});

test('Messages and the bell list paused sessions, and a conversation\'s change opens the conversation', () => {
  const improve = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(improve, /isParked/, 'no list filters paused work out');
  assert.doesNotMatch(improve, /return 'Paused'/, 'and no row says "Paused"');
  assert.match(improve, /href: session\.agent_session_id\s*\? `#messages\/agent\/\$\{session\.agent_session_id\}`/);
});

test('"paused" is shown nowhere, and nobody is asked to pause or resume anything', () => {
  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  assert.equal(transcript.changeStatusLabel('paused'), 'In progress');
  assert.doesNotMatch(read('frontend/src/features/messages/index.tsx'), /'Parked'/);
  assert.doesNotMatch(read('public/js/app-view.js'), /label: 'paused'/, 'no paused chip on the Workshop card');
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /key: 'pause', label: 'Pause'/);
  assert.doesNotMatch(devChat, /key: 'resume', label: 'Resume'/);
  assert.match(devChat, /key: 'free', label: 'Free worker'/, 'a promoted session can still free its worker');
  for (const file of ['src/routes/sessions.js', 'src/routes/proposal-handoff.js', 'src/services/connector-limits.js']) {
    assert.doesNotMatch(read(file), /Pause or archive one first|Pause one first/, `${file} never asks the user to pause`);
  }
  const prompt = read('src/services/mayor/agent-prompt.js');
  assert.doesNotMatch(prompt, /parking/);
  assert.match(prompt, /change\.status === 'paused' \? 'active'/, 'the Mayor is never told a change is paused');
});

test('new work at the cap pauses the user\'s least recently used session instead of refusing', async () => {
  const lifecycle = require('../src/services/session-lifecycle');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  assert.deepEqual(await lifecycle.freeUserSlot({ pool, userId: 7 }), { freed: false });
  const pick = calls[0];
  assert.match(pick.sql, /WHERE user_id = \$1 AND status = 'active' AND id <> \$2/);
  assert.match(pick.sql, /ORDER BY last_activity_at ASC/);
  assert.deepEqual(pick.params, [7, 0, false], 'headless runs are not the user\'s to give up');
  await lifecycle.freeUserSlot({ pool, userId: 7, excludeSessionId: 41, includeHeadless: true });
  assert.deepEqual(calls[1].params, [7, 41, true]);
  assert.match(lifecycle.USER_SLOTS_BUSY, /busy finishing turns/);

  const sessions = read('src/routes/sessions.js');
  const create = sessions.slice(sessions.indexOf("router.post('/api/apps/:slug/sessions'"));
  assert.match(create.slice(0, 6000), /sessionLifecycle\.freeUserSlot\(\{ pool, userId: req\.user\.id \}\)/);
  assert.equal((sessions.match(/sessionLifecycle\.freeUserSlot\(/g) || []).length, 4,
    'create, clone, fork and resume all free a slot the same way');
  assert.match(read('src/routes/proposal-handoff.js'), /sessionLifecycle\.freeUserSlot\(/);
  assert.match(read('src/services/connector-limits.js'), /lifecycle\.freeUserSlot\(\{ pool, userId: user\.id \}\)/);
});

test('a message to a paused session resumes it, with every rule the resume route keeps', () => {
  const sessions = read('src/routes/sessions.js');
  const chat = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/chat'"));
  const resumeAt = chat.indexOf('await resumePausedSession({');
  assert.ok(resumeAt > 0 && resumeAt < chat.indexOf("error: 'Active session not found'"),
    'resumed before the session is looked for again, never refused as not found');
  assert.match(chat.slice(0, resumeAt), /status = 'paused'\s+AND is_headless = FALSE AND source IS DISTINCT FROM 'imported'/);
  assert.match(chat.slice(0, resumeAt), /pausedRows\[0\]\.agent_session_id != null\) \{\s+return res\.status\(409\)/,
    'a change an agent session owns is refused before anything is resumed');
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/resume'"));
  assert.match(route.slice(0, 600), /await resumePausedSession\(\{ pool, config, user: req\.user, sessionId \}\)/,
    'one implementation for the route and the chat');
  const syncMain = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/sync-main'"));
  assert.match(syncMain.slice(0, 2000), /session\.status === 'paused'[\s\S]{0,200}resumePausedSession/);
  assert.equal(typeof require('../src/routes/sessions').resumePausedSession, 'function');
});

test('an agent session\'s finished run opens the conversation from the bell and from an alert', () => {
  const notifications = read('src/services/notifications.js');
  assert.equal((notifications.match(/cs\.agent_session_id,/g) || []).length, 3, 'every notification read carries it');
  assert.match(notifications, /agentSessionId: isConversation \? null : \(row\.agent_session_id \|\| null\)/);
  const client = read('frontend/src/features/notifications/notifications.js');
  assert.match(client, /item\.kind === 'session_done' && item\.agentSessionId[\s\S]{0,200}#messages\/agent\//);
  assert.match(client, /n\.agentSessionId \? 'The coding agent finished' : 'Session finished'/);
  assert.match(read('public/js/dev-alerts.js'), /if \(info && info\.agentSessionId\) return `#messages\/agent\/\$\{info\.agentSessionId\}`;/);
  assert.equal(typeof require('../src/services/session-bus').subscriberCount, 'function');
});

test('opening the conversation answers its changes\' finished rows, however the user got there', async () => {
  const { markReadForAgentSession } = require('../src/services/notifications');
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rowCount: 2 }; } };
  assert.equal(await markReadForAgentSession(pool, 4, 12), 2);
  assert.match(calls[0].sql, /n\.kind = 'session_done' AND n\.read_at IS NULL\s+AND n\.session_id = cs\.id AND cs\.agent_session_id = \$2/);
  assert.deepEqual(calls[0].params, [4, 12]);
  assert.equal(await markReadForAgentSession(pool, 4, null), 0, 'nothing to answer without a conversation');
  const route = read('src/routes/agent-sessions.js');
  const get = route.slice(route.indexOf("router.get('/api/agent-sessions/:id'"));
  assert.match(get.slice(0, 2400), /notifications\.markReadForAgentSession\(pool, req\.user\.id, session\.id\)/);
});
