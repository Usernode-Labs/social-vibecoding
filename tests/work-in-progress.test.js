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
//   3. The platform mark's menu lists no agent entries any more (#4729):
//      Agent chats — its heading, Build it now, the session rows and "Show
//      more" — moved whole to Messages, whose Agents list is their one home,
//      with the archived ones folded behind "Show archived" at its foot;
//      Messages' "+" still starts one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const conversation = (over = {}) => ({
  id: 7, title: 'Dark mode', status: 'open', lastActivityAt: '2026-09-24T10:00:00Z',
  focusApp: { slug: 'notes' }, activeChange: { appSlug: 'notes', status: 'paused', title: 'Dark mode toggle' },
  ...over,
});

test('#3073: only the newest read of the list is published, so an older answer cannot stop a spinner', async () => {
  const answers = [];
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {}, user: { id: 1 } }, UsernodeReact: {} };
  globalThis.fetch = (url) => new Promise((resolve) => {
    answers.push((sessions) => resolve({ ok: true, status: 200, json: async () => ({ sessions, nextBefore: null }) }));
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    const first = store.loadAgentSessions();
    const second = store.loadAgentSessions();
    answers[1]([conversation({ busy: true })]);
    await second;
    answers[0]([conversation({ busy: false })]);
    await first;
    assert.equal(store.getAgentSessionState().sessions[0].busy, true, 'the older answer, landing last, is dropped');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('#3071: a menu row writes its address before the menu closes, so closing cannot take it back', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const fn = sheet.slice(sheet.indexOf('function followThenDismiss('), sheet.indexOf('function MenuRow('));
  assert.match(fn, /e\.preventDefault\(\);\s*\/\/[^\n]*\n\s*if \(window\.location\.hash !== href\) window\.location\.hash = href;\s*AppContext\.dismissForNav\(\);/,
    'the address first, synchronously; then the release, which finds the page off its record');
  assert.match(fn, /if \(e\.defaultPrevented \|\| e\.nativeEvent\.defaultPrevented \|\| e\.button !== 0 \|\| e\.metaKey/,
    'a click the side panel took, or a modified one, only closes the menu');
  const row = sheet.slice(sheet.indexOf('function MenuRow('), sheet.indexOf('export function AppsSwitcherSheet('));
  assert.match(row, /if \(onClick\) \{ onClick\(e\); return; \}\s*followThenDismiss\(e, href\);/,
    'every plain row');
});

test('the mark\'s menu lists no agent entries: Agent chats moved whole to Messages (#4729)', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // A menu that lists an inbox's CONTENTS was the decay this file's header
  // warns of. Agent chats — its heading, Build it now, the session rows and
  // "Show more" — left whole, and Messages' Agents list is their one home.
  assert.doesNotMatch(sheet, /app-menu-sessions/, 'no Agent chats section');
  assert.doesNotMatch(sheet, /improve-row-new-session/, 'and no Build it now row');
  assert.doesNotMatch(sheet, /function AgentChats|<AgentChats/, 'no section component left');
  assert.doesNotMatch(sheet, /continueRows|continue-model/, 'the model that fed it went with it');
  // The app's own rows keep their order and now close the list: About is
  // the last of them, with the agent section that followed gone.
  const menu = sheet.slice(sheet.indexOf('export function AppsSwitcherSheet('));
  const at = (needle) => menu.indexOf(needle);
  assert.ok(at('id="app-menu-row-workshop"') > -1 && at('id="app-menu-row-about"') > -1
    && at('id="app-menu-row-workshop"') < at('id="app-menu-row-about"'),
    'Go to community and About are the app\'s section, and the list ends there');
  // Starting a new agent chat is Messages' "+", whose "Build it now" choice
  // has opened one since B8.
  assert.match(read('frontend/src/features/messages/index.tsx'), /startAgentSession\(\{ entry: 'messages' \}\)/);
  // The catalog entries the menu's rows read are gone with them.
  assert.throws(() => message('agent:appContext.agentChats.heading'), undefined, 'the heading is no longer in the catalog');
  assert.throws(() => message('agent:appContext.agentChats.buildNow'));
  assert.throws(() => message('agent:appContext.agentChats.showMore'));
});

// #4417: "Recents lists open agent sessions on its one clock" went with the
// rail's Recents: agent sessions are listed in Messages (the Agents filter),
// which is their one home since #4729.

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
  assert.match(devChat, /key: 'free', label: PlatformI18n\.t\('devchat:sessions\.action\.free'\)/, 'a promoted session can still free its worker');
  assert.equal(message('devchat:sessions.action.free'), 'Free worker');
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
  assert.equal((sessions.match(/sessionLifecycle\.freeUserSlot\(/g) || []).length, 3,
    'create, clone and resume all free a slot the same way (fork is retired, #2779)');
  assert.match(read('src/routes/proposal-handoff.js'), /sessionLifecycle\.freeUserSlot\(/);
  assert.match(read('src/services/connector-limits.js'), /lifecycle\.freeUserSlot\(\{ pool, userId: user\.id \}\)/);
});

test('a message to a paused session is refused, and never resumes it first (#3976)', () => {
  // It used to resume the session and then run the turn (#2779 follow-up).
  // Every paused row the chat route can load is now refused: an agent
  // session's change names its conversation, and a classic session is
  // read-only. Neither is resumed first, because a resume spends a slot and
  // may pause another of the user's sessions for a message that is refused.
  const sessions = read('src/routes/sessions.js');
  const chat = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/chat'"));
  const chatBody = chat.slice(0, chat.indexOf('\n  router.', 1));
  assert.doesNotMatch(chatBody, /resumePausedSession\(/, 'a message resumes nothing');
  const notFound = chat.indexOf("error: 'Active session not found'");
  assert.match(chat.slice(0, notFound), /status = 'paused'\s+AND is_headless = FALSE AND source IS DISTINCT FROM 'imported'/);
  assert.match(chat.slice(0, notFound), /pausedRows\[0\]\.agent_session_id != null\) \{\s+return res\.status\(409\)/,
    'a change an agent session owns is refused, naming its conversation');
  assert.match(chat.slice(0, notFound),
    /pausedRows\.length && classicSessions\.isClassicSession\(pausedRows\[0\]\)\) \{\s+return res\.status\(409\)\.json\(classicSessions\.refusal\(\)\)/,
    'a classic one is refused as read-only');
  // The resume route and sync-main keep the one implementation.
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/resume'"));
  assert.match(route.slice(0, 600), /await resumePausedSession\(\{ pool, config, user: req\.user, sessionId \}\)/,
    'one implementation for the route and sync-main');
  const syncMain = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/sync-main'"));
  assert.match(syncMain.slice(0, 2000), /session\.status === 'paused'[\s\S]{0,200}resumePausedSession/);
  assert.equal(typeof require('../src/routes/sessions').resumePausedSession, 'function');
});

test('an agent session\'s finished run opens the conversation from the bell and from an alert', () => {
  const notifications = read('src/services/notifications.js');
  assert.equal((notifications.match(/cs\.agent_session_id,/g) || []).length, 3, 'every notification read carries it');
  assert.match(notifications, /agentSessionId: isConversation \? null : \(row\.agent_session_id \|\| null\)/);
  const client = read('frontend/src/features/notifications/notifications.js');
  // #3181: a change that stopped before finishing opens the same place.
  assert.match(client, /const sessionTurnEnd = item\.kind === 'session_done' \|\| item\.kind === 'session_stalled';/);
  assert.match(client, /sessionTurnEnd && item\.agentSessionId[\s\S]{0,200}#messages\/agent\//);
  assert.match(client, /n\.agentSessionId \? t\('notifications:row\.session\.agentFinished'\) : t\('notifications:row\.session\.finished'\)/);
  assert.deepEqual([message('notifications:row.session.agentFinished'), message('notifications:row.session.finished')],
    ['The coding agent finished', 'Session finished']);
  assert.match(read('public/js/dev-alerts.js'), /if \(info && info\.agentSessionId\) return `#messages\/agent\/\$\{info\.agentSessionId\}`;/);
  assert.equal(typeof require('../src/services/session-bus').subscriberCount, 'function');
});

test('opening the conversation answers its changes\' finished rows, however the user got there', async () => {
  const { markReadForAgentSession } = require('../src/services/notifications');
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rowCount: 2 }; } };
  assert.equal(await markReadForAgentSession(pool, 4, 12), 2);
  assert.match(calls[0].sql, /n\.kind IN \('session_done', 'session_stalled'\) AND n\.read_at IS NULL\s+AND n\.session_id = cs\.id AND cs\.agent_session_id = \$2/);
  assert.deepEqual(calls[0].params, [4, 12]);
  assert.equal(await markReadForAgentSession(pool, 4, null), 0, 'nothing to answer without a conversation');
  const route = read('src/routes/agent-sessions.js');
  const get = route.slice(route.indexOf("router.get('/api/agent-sessions/:id'"));
  assert.match(get.slice(0, 2400), /notifications\.markReadForAgentSession\(pool, req\.user\.id, session\.id\)/);
});
