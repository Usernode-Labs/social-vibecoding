'use strict';

// #2813: agent threads open BESIDE the Messages list on a desktop.
//
// DMs, groups and app channels already opened in the pane next to the
// conversation list. The two agent kinds did not: a global agent chat went
// to its own screen (`#chat/<id>`) and an app's dev session to the app view
// (`#app/<slug>/dev/sessions/<id>`), so picking one took the list away.
//
// What is pinned here, each a way the feature quietly comes undone:
//
//   1. THE ROWS LINK TO THE INBOX'S OWN ADDRESSES, `#messages/agent/<id>`
//      and `#messages/session/<slug>/<id>`, and the store validates both.
//   2. A PHONE KEEPS ITS FULL-SCREEN BEHAVIOUR: the router swaps those
//      addresses in place (replaceState, then routes the new one) for the
//      screens they always led to there, and
//      records the session's origin so its chevron comes back to the inbox.
//   3. ONE THREAD IS OPEN — an agent thread clears a conversation and a
//      discussion, and hides the list on a phone like any other thread.
//   4. THE GLOBAL CHAT IS ONE PANEL ON TWO SURFACES, told which one is
//      drawing it, so its New / delete / Close write inbox addresses in the
//      pane and the hidden screen does not draw a second transcript.
//   5. THE DEV SESSION IS MOUNTED, NOT RE-IMPLEMENTED: a constant host that
//      AppView fills with the same session view the app view shows, and
//      that is retired only while no app view has taken over.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const CHAT_SCREEN = read('frontend/src/features/global-chat/index.tsx');
const CHAT_STORE = read('frontend/src/features/global-chat/store.ts');
const APP = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');

const store = loadTsx('frontend/src/features/messages/store.ts');

test('agent threads have inbox addresses, and a phone has the full-screen ones', () => {
  const chat = { kind: 'chat', id: '5f0c2a1e-8d7b-4c2a-9e11-0b6f3f3c9a10' };
  const session = { kind: 'session', slug: 'notes-ab12', id: 42 };
  assert.equal(store.agentThreadAddress(chat), `#messages/agent/${chat.id}`);
  assert.equal(store.agentThreadAddress(session), '#messages/session/notes-ab12/42');
  assert.equal(store.fullScreenAddress(chat), `#chat/${chat.id}`);
  assert.equal(store.fullScreenAddress(session), '#app/notes-ab12/dev/sessions/42');
});

test('the store validates an agent thread out of the address bar', () => {
  assert.deepEqual(store.validAgentThread({ kind: 'chat', id: ' abc-1 ' }), { kind: 'chat', id: 'abc-1' });
  assert.deepEqual(
    store.validAgentThread({ kind: 'session', slug: 'notes-ab12', id: 7 }),
    { kind: 'session', slug: 'notes-ab12', id: 7 },
  );
  for (const bad of [
    null,
    { kind: 'chat', id: '' },
    { kind: 'chat', id: '../settings' },
    { kind: 'session', slug: 'notes', id: 0 },
    { kind: 'session', slug: 'notes', id: 2_147_483_648 },
    { kind: 'session', slug: '<b>', id: 3 },
    { kind: 'other', id: 'x' },
  ]) {
    assert.equal(store.validAgentThread(bad), null, JSON.stringify(bad));
  }
});

test('one thread is open: an agent thread yields to a conversation or a discussion', () => {
  assert.match(STORE, /const nextAgent = nextId \|\| nextSlug \? null : validAgentThread\(agent\);/);
  // #2387: a reply thread and a message link ride on the route too, and
  // are cleared with it.
  assert.match(STORE, /route: \{ open: true, conversationId: nextId, appSlug: nextSlug, agent: nextAgent, threadRootId: nextRoot, focusMessageId: nextFocus \}/);
  assert.match(STORE, /route: \{ open: false, conversationId: null, appSlug: null, agent: null, threadRootId: null, focusMessageId: null \}/);
  // On a phone the list hides behind an agent thread as behind any other.
  assert.match(SCREEN, /snap\.route\.conversationId \|\| snap\.route\.appSlug \|\| snap\.route\.agent \? 'hidden md:flex' : 'flex'/);
  assert.match(STORE, /const onThread = !!state\.route\.conversationId \|\| !!state\.route\.appSlug \|\| !!state\.route\.agent;/);
});

test('the rows link to the inbox addresses and mark the open one', () => {
  assert.match(SCREEN, /const href = agentThreadAddress\(thread\);[\s\S]*?href=\{href\}\s*data-inbox-agent=\{chat\.id\}/);
  assert.match(SCREEN, /href: agentThreadAddress\(\{ kind: 'session', slug: session\.appSlug, id: session\.id \}\)/);
  assert.match(SCREEN, /active=\{open\?\.kind === 'chat' && open\.id === agent\.id\}/);
  assert.match(SCREEN, /active=\{open\?\.kind === 'session' && open\.id === session\.id\}/);
  // The row no longer records the session's origin itself: on a desktop the
  // session is not left for, and on a phone the router records it.
  assert.doesNotMatch(SCREEN, /onNavigate=\{\(\) => \{\s*if \(session\.kind === 'session'\) Improve\.enterSessionFrom/);
});

test('the router opens agent threads in the pane on a desktop and swaps them on a phone', () => {
  const at = APP.indexOf('const agent = App._messagesAgentThread(parts);');
  assert.ok(at > 0, 'the #messages route reads agent threads');
  const block = APP.slice(at, APP.indexOf('App.navigateToMessages(null, null, agent);', at));
  assert.match(block, /window\.matchMedia\('\(min-width: 768px\)'\)\.matches/);
  assert.match(block, /Improve\.enterSessionFrom\?\.\('#messages'\)/);
  assert.match(block, /history\.replaceState\(null, '', App\._rootUrl\(agent\.kind === 'chat'/);
  assert.match(block, /App\.restoreFromHash\(\);/);
  assert.match(block, /`#chat\/\$\{encodeURIComponent\(agent\.id\)\}`/);
  assert.match(block, /`#app\/\$\{encodeURIComponent\(agent\.slug\)\}\/dev\/sessions\/\$\{agent\.id\}`/);
  // #2387: a fourth argument carries a reply thread or a message link.
  assert.match(APP, /navigateToMessages\(conversationId, appSlug, agent, extras\) \{/);
  assert.match(APP, /messages\.route\?\.\(conversationId \|\| null, appSlug \|\| null, agent \|\| null, more\);/);
  assert.match(APP, /_messagesAgentThread\(parts\) \{[\s\S]*?parts\[1\] === 'agent'[\s\S]*?parts\[1\] === 'session'/);
});

test('the global chat is one panel on two surfaces, told which one is drawing it', () => {
  assert.match(CHAT_SCREEN, /export function GlobalChatPanel\(\{ embedded = false \}/);
  assert.match(CHAT_SCREEN, /\{snapshot\.host === 'messages' \? null : <GlobalChatPanel \/>\}/);
  assert.match(CHAT_SCREEN, /<Composer id=\{globalChatComposerId\(embedded \? 'messages' : 'screen'\)\} \/>/);
  // The prerendered screen is exactly what it was: the store starts on it.
  assert.match(CHAT_STORE, /open: false,\s*host: 'screen',/);
  assert.match(CHAT_STORE, /return host === 'messages' \? 'messages-agent-composer' : 'global-chat-composer';/);
  assert.match(CHAT_STORE, /`#messages\/agent\/\$\{encodeURIComponent\(threadId\)\}`/);
  assert.match(CHAT_STORE, /const target = threadAddress\(created\.thread\.id\);/);
  assert.match(CHAT_STORE, /window\.location\.hash = threadAddress\(nextThread\.id\);/);
  assert.match(CHAT_STORE, /classicPath \|\| \(state\.host === 'messages' \? '#messages' : '#home'\)/);

  assert.match(SCREEN, /openGlobalChat\(\{ threadId: id, host: 'messages' \}\)/);
  // Leaving the pane only undoes the pane's own open.
  assert.match(SCREEN, /if \(current\.open && current\.host === 'messages'\) deactivateGlobalChat\(\);/);
  assert.match(SCREEN, /<GlobalChatPanel embedded \/>/);
});

test('the dev session is mounted into a host, like a discussion', () => {
  assert.match(SCREEN, /view\.mountSessionInHost\(el, \{ slug, sessionId: id \}\)/);
  assert.match(SCREEN, /view\?\.unmountSessionHost\?\.\(el\);/);
  assert.match(SCREEN, /<div ref=\{host\} className="messages-session-host flex-1 min-h-0" hidden=\{phase === 'unavailable'\} \/>/);
  assert.match(SCREEN, /Open full view/);

  assert.match(APP_VIEW, /async mountSessionInHost\(host, \{ slug, sessionId \} = \{\}\) \{/);
  assert.match(APP_VIEW, /AppView\._reactDevBoard\(\)\?\.mountSessionShell\(host\);\s*const result = await AppView\.renderDevChatTab\(sessionId, \{ embedded: true \}\);/);
  // The container follows the pane only while no app view is up.
  assert.match(APP_VIEW, /if \(embedded && !\(typeof App !== 'undefined' && App\.currentApp\) && embedded\.isConnected\) \{/);
  // Teardown never undoes an app view that has taken over.
  const unmount = APP_VIEW.slice(APP_VIEW.indexOf('unmountSessionHost(host) {'));
  assert.match(unmount.slice(0, 600), /if \(typeof App !== 'undefined' && App\.currentApp\) return;[\s\S]*?DevChat\.reset\(\);/);
  // No Board to fall back to in the pane.
  assert.match(APP_VIEW, /if \(embedded\) return 'unavailable';/);
  // DevChat's work-order flow reads the session's app, not the app view's.
  assert.doesNotMatch(DEV_CHAT, /const slug = App\.currentApp;/);
  assert.match(DEV_CHAT, /_appSlug\(\) \{/);
});
