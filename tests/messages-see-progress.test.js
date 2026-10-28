'use strict';

// #6008: SEE PROGRESS ON A REQUEST BESIDE THE WORKSHOP LANDS ON THE REQUEST.
//
// The press moved the person to the chat with Homeroom bot, but two things
// left it looking empty: the Workshop's side panel (portalled, fixed, over
// everything) stayed up covering the reply pane, and the reply pane was
// always opened beside a chat loaded at its newest page — so a request whose
// card was older than that page was nowhere on screen.
//
//   1. The panel closes: AppView.openBotChatFromRequest and
//      GroupChat.openBotChat dispatch `usernode:workshop-side-close` before
//      they hand over, and workshop.tsx listens for it and clears sideItem
//      (which runs the panel's own cleanup, as ✕ does).
//   2. The chat opens on the request: openBotRequest keeps the reply thread
//      (`openThreadAt`) only when the chat as loaded holds the card, and
//      otherwise opens the message itself (`openAddress(messageAddress…)`),
//      the path that reads a window around it. Pinned below against the real
//      store, not only as source text.
//
// Run with: node --test tests/messages-see-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const STORE = read('frontend/src/features/messages/store.ts');
const APP_VIEW = read('public/js/app-view.js');
const GROUP_CHAT = read('public/js/group-chat.js');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');

const BOT = 502;
const SLUG = 'neuroboost-d05f3d';
const CARD = 1200;
const ASK = 1234;

/** The named function's own source, up to the next blank-line-preceded `},` or 1600 chars. */
function body(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `${header} is in the file`);
  return src.slice(start, start + 1600);
}

// ── 1. The Workshop's side panel closes first ───────────────────────────

test('the request page\'s See progress closes the side panel before it hands over', () => {
  const fn = body(APP_VIEW, 'openBotChatFromRequest(issueNumber) {');
  const close = fn.indexOf("new CustomEvent('usernode:workshop-side-close')");
  assert.ok(close >= 0, 'dispatches usernode:workshop-side-close');
  assert.ok(close < fn.indexOf('messages.openBotRequest('), 'before it opens the chat');
});

test('a bot card\'s See progress (the panel\'s thread) closes it too', () => {
  const fn = body(GROUP_CHAT, 'openBotChat(issueNumber) {');
  const close = fn.indexOf("new CustomEvent('usernode:workshop-side-close')");
  assert.ok(close >= 0, 'dispatches usernode:workshop-side-close');
  assert.ok(close < fn.indexOf('messages.openBotRequest('), 'before it opens the chat');
});

test('the Workshop closes its panel when it hears the event', () => {
  assert.match(WORKSHOP, /window\.addEventListener\('usernode:workshop-side-close', onLeave\)/);
  assert.match(WORKSHOP, /window\.removeEventListener\('usernode:workshop-side-close', onLeave\)/);
  const listener = WORKSHOP.indexOf("addEventListener('usernode:workshop-side-close'");
  const effect = WORKSHOP.lastIndexOf('useEffect(', listener);
  const upTo = WORKSHOP.indexOf('}, []);', listener);
  assert.match(WORKSHOP.slice(effect, upTo), /setSideItem\(null\)/, 'clears the panel\'s item, which runs its cleanup');
});

// ── 2. The chat opens on the request ────────────────────────────────────

test('openBotRequest keeps the reply thread only when the chat holds the card', () => {
  assert.match(STORE, /state\.active\?\.id === conversationId\s*\n\s*&& state\.messages\.some\(\(item\) => item\.id === track\.rootId\)/,
    'the loaded check reads the chat on screen and its messages');
  assert.match(STORE, /openThreadAt\(track\.rootId, focus\);/, 'the card is in the chat: the thread stays the destination');
  assert.match(STORE, /openAddress\(messageAddress\(conversationId, focus \|\| track\.rootId\)\);/,
    'otherwise the chat opens at the message, which reads a window around it');
});

/** A fresh window/document/fetch, before the store is bundled. */
function environment(routes) {
  const hash = { value: '#workshop' };
  globalThis.window = {
    App: { user: { id: 7, username: 'ada' } },
    get location() { return { search: '', hash: hash.value, set hash(next) { hash.value = next; } }; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout, clearTimeout,
  };
  globalThis.document = {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    querySelector: () => null,
  };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
    const body = key ? routes[key] : null;
    return body === null || body === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => body };
  };
  return hash;
}

const BOT_ROW = {
  conversations: [{
    id: BOT, kind: 'direct', homeroomBot: true, title: 'Homeroom bot',
    lastActivityAt: '2026-10-26T10:00:00Z', unreadCount: 0,
  }],
};

const message = (id) => ({
  id, conversationId: BOT, content: `message ${id}`, createdAt: '2026-10-26T10:00:00Z',
  sender: { id: 11, username: 'homeroom-bot' },
});

const work = {
  tracks: [{ state: 'building', step: 'build', appSlug: SLUG, issueNumber: 8, rootId: CARD, askId: ASK, title: 'Add logic exercises' }],
};

/** Open the store on the bot chat, whose loaded page holds `messages`. */
async function openChatOn(messages) {
  const hash = environment({
    [`/api/conversations/${BOT}/messages`]: { messages, focus: null, nextBefore: null, nextAfter: null },
    [`/api/conversations/${BOT}`]: { conversation: { ...BOT_ROW.conversations[0] } },
    '/api/conversations/homeroom-bot/work': work,
    '/api/conversations': BOT_ROW,
  });
  const store = loadTsx('frontend/src/features/messages/store.ts');
  store.route(BOT);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { store, hash };
}

test('a card older than the chat\'s page: the chat opens at the message', async () => {
  const { store, hash } = await openChatOn([message(1300), message(1301)]);
  await store.openBotRequest(SLUG, 8);
  assert.equal(hash.value, `#messages/${BOT}/m/${ASK}`, 'the message waiting on the person, not the newest page');
});

test('a card in the chat: the reply thread opens beside it, as before', async () => {
  const { store, hash } = await openChatOn([message(CARD), message(1301)]);
  await store.openBotRequest(SLUG, 8);
  assert.equal(hash.value, `#messages/${BOT}/thread/${CARD}`, 'the thread is the destination');
});
