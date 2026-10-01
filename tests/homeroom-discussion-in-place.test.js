'use strict';

// #3494: HOMEROOM'S DISCUSSION IS IN PLACE, UNDER THE PAGE'S OWN HEADER.
//
// Every project's Discussion tab draws its channel inside the page, under the
// community's header and tabs. Homeroom's channel is #general, a conversation
// of the Messages store rather than an app chat, so its tab was a door: it
// opened #general on the Messages screen, which swapped the header, the tabs
// and the community's colour for Messages' own (#3491). Now the tab turns like
// every other project's, and the room is Messages' own thread mounted in the
// page (EmbeddedConversation), holding the store's one route while the page is
// on screen. Pinned here:
//
//   1. THE STORE: `embed` opens the thread without opening Messages (`open`
//      stays false, so the screen's chrome, Back and the router hear nothing),
//      realtime still reaches it, a reply thread opens beside it without an
//      address, Messages takes the store back by routing, and `release` gives
//      it back only while it still holds it (executed against the real store).
//   2. ONE COPY: the hidden Messages screen draws no thread while the page
//      does, and the page's copy draws no header of Messages' own.
//   3. THE PAGE: the tab turns (no door), and the room is mounted only while
//      #app-view is the screen on show (executed against the real component).
//
// Run with: node --test tests/homeroom-discussion-in-place.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const PD_PATH = 'frontend/src/features/dev-board/workshop/project-discussion.tsx';
const PD = read(PD_PATH);

const GENERAL = 1;
const PAGE = '#app/usernode-2d5619/workshop';

function install() {
  const reads = [];
  const chrome = [];
  global.window = {
    location: { hash: PAGE, search: '' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 390,
    App: {
      user: { id: 1, username: 'me' },
      setHeaderTitle(title) { chrome.push(`title:${title}`); },
      setBackIcon(kind) { chrome.push(`back:${kind}`); },
    },
    Notifications: { markConversationRead() {}, markConversationThreadRead() {} },
  };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.history = { replaceState(_s, _t, url) { window.location.hash = String(url); } };
  global.fetch = async (url, init = {}) => {
    const address = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST') return json({});
    if (address === `/api/conversations/${GENERAL}`) {
      reads.push('conversation');
      return json({ conversation: {
        id: GENERAL, kind: 'channel', title: 'general', channelKey: 'general', membershipStatus: 'member',
        members: [], memberCount: 12, canSend: true,
      } });
    }
    if (address.startsWith(`/api/conversations/${GENERAL}/messages?`)) {
      reads.push('messages');
      return json({ messages: [
        { id: 41, conversationId: GENERAL, sender: { id: 2, username: 'ada' }, content: 'Hello, #general', createdAt: '2026-09-30T10:00:00Z' },
      ], next_before: null });
    }
    if (address.startsWith('/api/conversations')) {
      return json({ conversations: [{ id: GENERAL, kind: 'channel', title: 'general', channelKey: 'general', membershipStatus: 'member' }] });
    }
    return json({ discussions: [] });
  };
  return { reads, chrome };
}

function uninstall() {
  delete global.window;
  delete global.fetch;
  delete global.localStorage;
  delete global.history;
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

function snapshotOf(store) {
  let snap = null;
  const Probe = () => { snap = store.useMessagesSnapshot(); return null; };
  renderToHtml(createElement(Probe));
  return snap;
}

test('#3494: the page embeds #general without opening Messages, and realtime still reaches it', async () => {
  const { reads, chrome } = install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    store.embed(GENERAL);
    await settle();
    let snap = snapshotOf(store);
    assert.equal(snap.route.embedded, true);
    assert.equal(snap.route.open, false, 'Messages is not open: it is not the screen on show');
    assert.equal(snap.route.conversationId, GENERAL);
    assert.equal(snap.active?.id, GENERAL, 'the thread is loaded');
    assert.equal(snap.messages.length, 1);
    assert.equal(store.isOpen(), false, 'the router and Improve hear that Messages is closed');
    assert.equal(store.handleBack(), false, 'Back is the page\'s, not a level of Messages');
    assert.deepEqual(chrome, [], 'and nothing writes the header');
    assert.equal(window.location.hash, PAGE, 'the page keeps its address');

    // A message lands in the room: the embedded thread re-reads it.
    reads.length = 0;
    store.handleEvent({ type: 'conversation_message_created', conversationId: GENERAL });
    await settle();
    assert.ok(reads.includes('messages'), 'realtime reaches the room in the page');

    // Embedding the room it already holds does nothing.
    reads.length = 0;
    store.embed(GENERAL);
    await settle();
    assert.deepEqual(reads, [], 'no second load');
  } finally {
    uninstall();
  }
});

test('#3494: a reply thread opens beside the room in the page, with no address of its own', async () => {
  install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    store.embed(GENERAL);
    await settle();
    store.openThread(41);
    assert.equal(snapshotOf(store).route.threadRootId, 41);
    assert.equal(window.location.hash, PAGE, 'opening it does not navigate to Messages');
    store.closeThread();
    assert.equal(snapshotOf(store).route.threadRootId, null);
    assert.equal(window.location.hash, PAGE, 'and closing it does not rewrite the page\'s address');
    assert.equal(snapshotOf(store).route.embedded, true, 'the room stays open');
  } finally {
    uninstall();
  }
});

test('#3494: Messages takes the store back by routing, and release gives back only what the page holds', async () => {
  install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    store.embed(GENERAL);
    await settle();
    // The Messages tab: the router routes the bare list.
    store.route(null, null, null, {});
    await settle();
    let snap = snapshotOf(store);
    assert.equal(snap.route.open, true);
    assert.ok(!snap.route.embedded, 'a route replaces the embedded one');
    // The page leaving now must not close Messages under the reader.
    store.release(GENERAL);
    snap = snapshotOf(store);
    assert.equal(snap.route.open, true, 'release is a no-op once Messages holds the store');
    // While Messages is up the page cannot take it.
    store.embed(GENERAL);
    assert.ok(!snapshotOf(store).route.embedded, 'embed waits for Messages to close');
    // #general on the Messages screen, by its own address: the same room, opened there.
    store.route(GENERAL, null, null, {});
    await settle();
    snap = snapshotOf(store);
    assert.equal(snap.route.open, true);
    assert.equal(snap.active?.id, GENERAL);
    store.close();
    store.embed(GENERAL);
    await settle();
    assert.equal(snapshotOf(store).route.embedded, true, 'back on the page, it embeds again');
    store.release(GENERAL);
    snap = snapshotOf(store);
    assert.ok(!snap.route.embedded && !snap.route.open && !snap.route.conversationId, 'release closes the page\'s room');
  } finally {
    uninstall();
  }
});

test('#3494: exactly one copy of the thread is drawn, and the page\'s has no header of Messages\' own', () => {
  const thread = SCREEN.slice(SCREEN.indexOf('function ConversationThread('), SCREEN.indexOf('function ThreadActivityRow('));
  assert.match(thread, /function ConversationThread\(\{ embedded = false \}: \{ embedded\?: boolean \} = \{\}\)/);
  // Before any other kind of thread: the store's route says which copy draws.
  const gate = thread.indexOf('if (!!snap.route.embedded !== embedded) {');
  assert.ok(gate > 0 && gate < thread.indexOf('if (snap.route.appSlug) return <AppDiscussionThread'), 'the gate comes first');
  assert.match(thread, /\{embedded \? null : <ThreadHeader \/>\}/, 'the page\'s own header names the room');
  assert.match(thread, /messages-thread-\$\{kind\}\$\{embedded \? ' messages-thread-embedded' : ''\}/);
  // The hidden Messages screen draws no reply thread for the page's room either.
  assert.match(SCREEN, /\{snap\.route\.conversationId && snap\.route\.threadRootId && !snap\.route\.embedded \? <ReplyThreadPanel \/> : null\}/);
  // The page's copy holds the store only while it is on screen, and gives it back.
  const embedded = SCREEN.slice(SCREEN.indexOf('export function EmbeddedConversation('), SCREEN.indexOf('export function MessagesScreen('));
  assert.match(embedded, /if \(!active \|\| messagesOpen\) return undefined;\s*embed\(conversationId\);\s*return \(\) => release\(conversationId\);/);
  assert.match(embedded, /\{here \? <ConversationThread embedded \/> : null\}/);
  assert.match(embedded, /\{here && snap\.route\.threadRootId \? <ReplyThreadPanel \/> : null\}/);
});

test('#3494: the Discussion tab turns for Homeroom too, and mounts #general while the page is on screen', () => {
  // No door: the tab, the hub card's Open and a cold `?ws=discussion` all turn the page.
  assert.doesNotMatch(LANDER, /discussionElsewhere|openDiscussionElsewhere/);
  assert.match(LANDER, /const openTab = \(next: TabKey\) => \{\s*setTab\(next\);\s*callAppView\('_setWorkshopTab', next\);/);
  assert.doesNotMatch(PD, /location\.hash|location\.replace|_setWorkshopTab/, 'the tab never navigates away');

  const seen = [];
  const EmbeddedConversation = (props) => { seen.push(props); return createElement('div', { 'data-stub-room': String(props.conversationId) }); };
  const { ProjectDiscussion, generalRoom } = loadTsx(PD_PATH, { stubs: { '../../messages': { EmbeddedConversation } } });
  const general = { channel: { handle: 'general', href: '#messages/1', post_url: '/api/conversations/1/messages', unread_count: 0 } };
  assert.equal(generalRoom(general), 1, '#general is conversation 1');
  assert.equal(generalRoom({ channel: { handle: 'garden', href: '#messages/app/garden' } }), null, 'an app\'s own channel is the group chat\'s');
  assert.equal(generalRoom({ channel: { handle: 'general', href: '#messages/1/thread/4' } }), null, 'only a bare conversation address');
  assert.equal(generalRoom({ channel: { handle: 'general', href: '#messages/0' } }), null);
  assert.equal(generalRoom({ channel: null }), null);
  assert.equal(generalRoom(null), null);

  const html = renderToHtml(createElement(ProjectDiscussion, { slug: 'usernode-2d5619', name: 'Homeroom', data: general }));
  assert.match(html, /<section class="dev-ws-discussion" data-ws-discussion="" data-ws-discussion-room="general" aria-label="Homeroom discussion"><div data-stub-room="1"><\/div><\/section>/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conversationId, 1);
  assert.equal(seen[0].active, false, 'not on screen until the router has revealed #app-view');
  assert.match(PD, /<EmbeddedConversation conversationId=\{room\} active=\{onShow\} \/>/);
  assert.match(PD, /const onShow = screen === 'app-view' && !!tab;/, 'on show: the project page, not the running app behind it');
  assert.doesNotMatch(html, /data-ws-discussion-elsewhere|data-ws-discussion-open/, 'no door');

  // A project's own channel is still the group chat's pane.
  const own = renderToHtml(createElement(ProjectDiscussion, {
    slug: 'garden', name: 'Garden', data: { channel: { handle: null, href: '#messages/app/garden', post_url: '/api/apps/garden/messages' } },
  }));
  assert.match(own, /<section class="dev-ws-discussion" data-ws-discussion="" aria-label="Garden discussion"><div class="dev-ws-discussion-host"><\/div><\/section>/);
});

test('#3494: the room fills the tab edge to edge, as a project\'s own chat does', () => {
  const CSS = read('public/css/app.css');
  assert.match(CSS, /\.dev-ws-discussion > \.messages-layout \{ flex: 1 1 auto; height: auto; min-height: 0; \}/);
  assert.match(CSS, /\.messages-layout-embedded > \.messages-thread-pane,\s*\.messages-layout-embedded > \.messages-reply-pane \{ margin: 0; \}/);
  // After the Messages strip's own margins, so equal specificity lands on these.
  assert.ok(CSS.indexOf('.messages-layout-embedded > .messages-thread-pane') > CSS.lastIndexOf('.messages-layout.messages-has-reply-thread > .messages-thread-pane'));
});
