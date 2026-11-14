'use strict';

// Which thread (frontend/src/features/ai/where.ts, 14 Nov 2026).
//
// Main Chat, the person's one direct conversation with Homeroom bot drawn as
// a single mixed timeline, is gone: every conversation with the bot is a
// thread. Some doors still know only the old Main Chat address, a message, or
// a project's first version. The server says which thread each is
// (GET /api/ai/where), and the tab lands there:
//
//   #homeroom-bot/main            the person's "Earlier chat" thread (their
//                                 old Main Chat messages), else a new chat
//   #homeroom-bot/main/m/<id>     the thread that message is in, at it,
//   #homeroom-bot/m/<id>          else the page itself
//   a project's first version     its first-version thread, else the page
//
// The address is rewritten in place (no step for Back), only while it is
// still the one asked, and nothing here can route twice. And the chat the
// thread opens in is mounted threads only: the conversation's own stream is
// never read or marked read (frontend/src/features/messages/store.ts).
//
// Run with: node --test tests/ai-where.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const WHERE = 'frontend/src/features/ai/where.ts';
const plain = (v) => JSON.parse(JSON.stringify(v));

/** The module over a fake window: what it asked the server, wrote to the bar and asked the tab. */
function load({ hash = '#homeroom-bot/main', search = '', answer = {}, status = 200, fails = false } = {}) {
  const seen = { fetched: [], replaced: [], tab: [], fresh: [], went: [], closed: 0 };
  const location = { hash, search, pathname: '/' };
  const had = { window: globalThis.window, fetch: globalThis.fetch, history: globalThis.history };
  globalThis.window = { location, UsernodeReact: {} };
  globalThis.history = {
    state: { kept: true },
    replaceState(state, _title, url) {
      seen.replaced.push(url);
      location.hash = url.slice(url.indexOf('#'));
    },
  };
  globalThis.fetch = async (url) => {
    seen.fetched.push(url);
    if (fails) throw new Error('offline');
    return { ok: status === 200, status, json: async () => answer };
  };
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const mod = loadTsx(WHERE, {
    stubs: {
      './door': {
        ...door,
        askBotTab: (at) => seen.tab.push(plain(at)),
        askBotNew: (fresh) => seen.fresh.push(fresh),
        askBotClose: () => { seen.closed += 1; },
        goBotAddress: (href) => seen.went.push(href),
      },
    },
  });
  const host = globalThis.window.UsernodeReact;
  const restore = () => {
    globalThis.window = had.window;
    globalThis.fetch = had.fetch;
    globalThis.history = had.history;
  };
  return { mod, seen, location, host, restore };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the question and the answer: a message, a project\'s first version, or nothing but Earlier chat', () => {
  const { mod, restore } = load();
  try {
    assert.equal(mod.wherePath(null), '/api/ai/where');
    assert.equal(mod.wherePath({ message: 71 }), '/api/ai/where?message=71');
    assert.equal(mod.wherePath({ project: 'run-club', firstVersion: true }), '/api/ai/where?project=run-club&firstVersion=1');
    assert.equal(mod.wherePath({ project: 'run-club' }), '/api/ai/where', 'a project alone asks nothing: only its first version has a thread of its own');
    assert.equal(mod.wherePath({ message: 71, project: 'run-club', firstVersion: true }), '/api/ai/where?message=71', 'a message is the narrower question');
    assert.equal(mod.wherePath({ message: -1 }), '/api/ai/where', 'nothing that is not an id');
    assert.equal(mod.wherePath({ project: '../x', firstVersion: true }), '/api/ai/where', 'nor a slug the platform would not mint');
    assert.equal(mod.wherePath({ message: 71 }, true), '/api/ai/where?message=71&demo=1', 'a staging preview\'s flag rides along');
    assert.deepEqual(plain(mod.cleanWhere({ rootId: 60, earlierRootId: 12 })), { rootId: 60, earlierRootId: 12 });
    assert.deepEqual(plain(mod.cleanWhere({ rootId: '60', earlierRootId: 0 })), { rootId: null, earlierRootId: null });
    assert.deepEqual(plain(mod.cleanWhere(null)), { rootId: null, earlierRootId: null });
  } finally { restore(); }
});

test('where an old address lands: a thread, a new chat or the page', () => {
  const { mod, restore } = load();
  try {
    const none = { rootId: null, earlierRootId: null };
    const at = (threadRootId, focusMessageId) => ({ threadRootId, focusMessageId });
    // Main Chat itself: the thread its messages were moved under, else a new chat.
    assert.deepEqual(plain(mod.oldMainLanding(at(null, null), { rootId: null, earlierRootId: 12 })), { thread: at(12, null) });
    assert.deepEqual(plain(mod.oldMainLanding(at(null, null), none)), { fresh: true });
    // A message: the thread it is in, at it; one that starts a thread is the thread itself.
    assert.deepEqual(plain(mod.oldMainLanding(at(null, 71), { rootId: 60, earlierRootId: 12 })), { thread: at(60, 71) });
    assert.deepEqual(plain(mod.oldMainLanding(at(null, 60), { rootId: 60, earlierRootId: 12 })), { thread: at(60, null) });
    assert.deepEqual(plain(mod.oldMainLanding(at(null, 71), { rootId: null, earlierRootId: 12 })), { page: true },
      'a message in no thread is the page itself, never Earlier chat by guess');
    // An address that already names its thread needs no answer.
    assert.deepEqual(plain(mod.oldMainLanding(at(5, 9), none)), { thread: at(5, 9) });
  } finally { restore(); }
});

test('#homeroom-bot/main opens Earlier chat, rewriting the address in place', async () => {
  const { mod, seen, location, host, restore } = load({ hash: '#homeroom-bot/main', answer: { rootId: null, earlierRootId: 12 } });
  try {
    assert.equal(typeof host.ai.openOld, 'function', 'the router\'s half is published for app.js');
    host.ai.openOld('#homeroom-bot/main');
    await settle();
    assert.deepEqual(seen.fetched, ['/api/ai/where']);
    assert.deepEqual(seen.replaced, ['/#homeroom-bot/thread/12'], 'replaceState: no hashchange, no second pass through the router, no step for Back');
    assert.equal(location.hash, '#homeroom-bot/thread/12');
    assert.deepEqual(seen.tab, [{ threadRootId: 12, focusMessageId: null }], 'and the page is asked for the thread, once');
    assert.deepEqual(seen.fresh, []);
    assert.deepEqual(seen.went, [], 'never by assigning the hash');
  } finally { restore(); }
});

test('#homeroom-bot/main with no Earlier chat opens a new chat on the page\'s own address', async () => {
  const { mod, seen, location, restore } = load({ hash: '#homeroom-bot/main?project=garden', answer: { rootId: null, earlierRootId: null } });
  try {
    mod.openOldMain('#homeroom-bot/main');
    await settle();
    assert.deepEqual(seen.replaced, ['/#homeroom-bot?project=garden'], 'the chips\' filter rides along');
    assert.equal(seen.fresh.length, 1, 'New chat, as its button opens it');
    assert.deepEqual(seen.tab, []);
    assert.equal(location.hash, '#homeroom-bot?project=garden');
  } finally { restore(); }
});

test('a message named without its thread opens the thread it is in, at it; in none, the page', async () => {
  const found = load({ hash: '#homeroom-bot/main/m/71', answer: { rootId: 60, earlierRootId: 12 } });
  try {
    found.mod.openOldMain('#homeroom-bot/main/m/71');
    await settle();
    assert.deepEqual(found.seen.fetched, ['/api/ai/where?message=71']);
    assert.deepEqual(found.seen.replaced, ['/#homeroom-bot/thread/60/m/71']);
    assert.deepEqual(found.seen.tab, [{ threadRootId: 60, focusMessageId: 71 }]);
  } finally { found.restore(); }
  // The newer spelling, which the tab's own search rows use for a message whose thread is not named.
  const bare = load({ hash: '#homeroom-bot/m/71', search: '?demo=1', answer: { rootId: 60, earlierRootId: null } });
  try {
    bare.mod.openOldMain('#homeroom-bot/m/71');
    await settle();
    assert.deepEqual(bare.seen.fetched, ['/api/ai/where?message=71&demo=1']);
    assert.deepEqual(bare.seen.replaced, ['/?demo=1#homeroom-bot/thread/60/m/71'], 'the page\'s own query stays');
  } finally { bare.restore(); }
  const lost = load({ hash: '#homeroom-bot/main/m/71', answer: { rootId: null, earlierRootId: 12 } });
  try {
    lost.mod.openOldMain('#homeroom-bot/main/m/71');
    await settle();
    assert.deepEqual(lost.seen.replaced, ['/#homeroom-bot']);
    assert.deepEqual(lost.seen.tab, []);
    assert.deepEqual(lost.seen.fresh, [], 'the page itself: nothing is opened for a message that is nowhere');
  } finally { lost.restore(); }
});

test('an answer that comes after the reader moved on is dropped, and a read that fails falls back to a new chat or the page', async () => {
  const moved = load({ hash: '#homeroom-bot/main', answer: { rootId: null, earlierRootId: 12 } });
  try {
    moved.mod.openOldMain('#homeroom-bot/main');
    moved.location.hash = '#messages';
    await settle();
    assert.deepEqual(moved.seen.replaced, []);
    assert.deepEqual(moved.seen.tab, []);
  } finally { moved.restore(); }
  for (const how of [{ fails: true }, { status: 404 }, { status: 500 }]) {
    const down = load({ hash: '#homeroom-bot/main', ...how });
    try {
      down.mod.openOldMain('#homeroom-bot/main');
      await settle();
      assert.deepEqual(down.seen.replaced, ['/#homeroom-bot'], JSON.stringify(how));
      assert.equal(down.seen.fresh.length, 1, 'a server from before the route, or no network: a new chat, never an error');
    } finally { down.restore(); }
  }
  // An address that already names a thread asks nobody.
  const named = load({ hash: '#homeroom-bot/main/thread/5' });
  try {
    named.mod.openOldMain('#homeroom-bot/main/thread/5');
    await settle();
    assert.deepEqual(named.seen.fetched, []);
    assert.deepEqual(named.seen.tab, [{ threadRootId: 5, focusMessageId: null }]);
  } finally { named.restore(); }
});

test('a project\'s first-version thread, and a message from a door that is not an address', async () => {
  const first = load({ answer: { rootId: 44, earlierRootId: 12 } });
  try {
    await first.mod.openFirstVersion('run-club');
    assert.deepEqual(first.seen.fetched, ['/api/ai/where?project=run-club&firstVersion=1']);
    assert.deepEqual(first.seen.went, ['#homeroom-bot/thread/44']);
    await first.mod.openBotMessage(71);
    assert.equal(first.seen.went[1], '#homeroom-bot/thread/44/m/71');
  } finally { first.restore(); }
  const none = load({ answer: { rootId: null, earlierRootId: 12 } });
  try {
    await none.mod.openFirstVersion('run-club');
    assert.deepEqual(none.seen.went, ['#homeroom-bot'], 'the Homeroom bot page when it has none: never Earlier chat, which is not about this project');
    await none.mod.openFirstVersion(null);
    assert.equal(none.seen.went[1], '#homeroom-bot');
    assert.equal(none.seen.fetched.length, 1, 'no project, nothing asked');
    await none.mod.openBotMessage(null);
    assert.equal(none.seen.went[2], '#homeroom-bot');
  } finally { none.restore(); }
});

// ── The chat a thread opens in is mounted threads only ───────────────────

test('threads only: the conversation\'s own stream is never read, drawn or marked read', async () => {
  const calls = [];
  const conversation = { id: 77, kind: 'direct', homeroomBot: true, membershipStatus: 'member', members: [], unreadCount: 3, title: 'Homeroom bot' };
  const api = new Proxy({
    strictId: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null),
    async listConversations() { calls.push('listConversations'); return { conversations: [conversation] }; },
    async getConversation(id) { calls.push(`getConversation:${id}`); return conversation; },
    async listThread(id, rootId) {
      calls.push(`listThread:${id}:${rootId}`);
      return { root: { id: rootId, sender: { id: 2, bot: true }, content: 'Hello', createdAt: 'now' }, messages: [], nextBefore: null, discussion: null, firstUnreadId: null };
    },
    keptConversations: () => null,
    keptConversation: () => null,
    MessagesApiError: class extends Error {},
  }, { get: (t, k) => (k in t ? t[k] : (...args) => { calls.push(`UNEXPECTED ${String(k)}`); throw new Error(`api.${String(k)} must not be called: ${JSON.stringify(args)}`); }) });
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api } });
  store.embed(77, { threadRootId: 139, focusMessageId: null }, { threadsOnly: true });
  await settle(); await settle();
  assert.ok(calls.includes('getConversation:77'), 'who is in it: the thread pane\'s gate and its typing line');
  assert.ok(calls.includes('listThread:77:139'), 'and the one thread the route names');
  assert.deepEqual(calls.filter((c) => /^UNEXPECTED|listMessages|markRead/.test(c)), [], 'no page of the stream, and nothing marked read for it');
  assert.equal(store.loadedMessages().length, 0);
  // A message event re-reads the open thread, never the stream.
  calls.length = 0;
  store.handleEvent({ type: 'conversation_message_created', conversationId: 77, threadRootId: 139 });
  await settle(); await settle();
  assert.ok(calls.includes('listThread:77:139'));
  assert.deepEqual(calls.filter((c) => /^UNEXPECTED|listMessages|getConversation|markRead/.test(c)), []);

  const src = read('frontend/src/features/messages/store.ts');
  assert.match(src, /if \(state\.route\.threadsOnly && state\.route\.embedded && state\.route\.conversationId === conversationId\) \{\s+await loadThreadsOnly\(conversationId, force\);\s+return;\s+\}/,
    'before anything of the stream is asked for');
  const fn = src.slice(src.indexOf('async function loadThreadsOnly('), src.indexOf('/** The conversation as the inbox knows it'));
  assert.doesNotMatch(fn, /listMessages|readMainWhenThere|markFor\(|unreadMark/);
  const screen = read('frontend/src/features/messages/index.tsx');
  const embedded = screen.slice(screen.indexOf('export function EmbeddedConversation('), screen.indexOf('function BotThreadsSync('));
  const only = embedded.slice(embedded.indexOf('if (threadsOnly) {'), embedded.indexOf('  return (\n    <div className={`messages-layout messages-layout-embedded${here'));
  assert.doesNotMatch(only, /ConversationThread|ChannelLoading/, 'no copy of the conversation is mounted, hidden or not');
  // What the conversation's own transcript kept current for its threads is kept by the thread.
  assert.match(screen, /const newsKey = thread \? newestBotMessageId\(thread\.messages\) : null;[\s\S]{0,200}<BotWorkSync conversationId=\{conversationId\} newsKey=\{newsKey\} \/>\s+<BotActivitySync conversationId=\{conversationId\} newsKey=\{newsKey\} \/>/);
  // Main Chat's own card is gone with it.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/messages/welcome-back.tsx')));
  assert.doesNotMatch(screen, /WelcomeBack|MainChatContext|mainChat/);
  assert.doesNotMatch(read('frontend/locales/en/messages.json'), /"welcome\.|Main Chat/);
});

test('a quote goes to the thread its message is in, into that thread\'s own box', () => {
  const src = read('frontend/src/features/messages/store.ts');
  const fn = src.slice(src.indexOf('function applyPendingQuote('), src.indexOf('/** The app-channel message link last revealed'));
  assert.match(fn, /const message = thread\.root\?\.id === wanted\.messageId \? thread\.root : thread\.messages\.find\(\(item\) => item\.id === wanted\.messageId\);/);
  assert.match(fn, /setReply\(scopeKey\(wanted\.conversationId, thread\.rootId\), message\);/, 'the thread\'s box, never one with no thread');
  assert.match(src, /firstUnreadId: same && current && current\.firstUnreadId !== undefined \? current\.firstUnreadId : page\.firstUnreadId,\s+\},\s+\}\);\s+applyPendingQuote\(\);/, 'once the thread has drawn it');
});

// A NEW CHAT ASKED FOR BY A LINK IS NOT CLOSED BY ITS OWN NAVIGATION. A link
// to `#homeroom-bot/new…` (a project's Workshop row) fires popstate and then
// hashchange, and the router runs on each. Where the page already knew the
// bot's chat it opened the new chat on the first pass and wrote its own
// address in place (`#homeroom-bot`, with its filter); the second pass read
// that bare address as the tab pressed and closed it again, so the row
// landed on the lists alone. Only a browser shows the two passes, so this
// drives the door the way the router does, with the event it is handling.
test('a link to a new chat: the second pass of its own navigation does not close it', () => {
  const had = { window: globalThis.window };
  const location = { hash: '', search: '', pathname: '/' };
  globalThis.window = { location, UsernodeReact: {}, event: undefined };
  try {
    const door = loadTsx('frontend/src/features/ai/door.ts', {
      stubs: { react: { useSyncExternalStore: (_subscribe, get) => get() } },
    });
    const ai = globalThis.window.UsernodeReact.ai;
    const asked = () => plain(door.useBotTabAsk());
    const asking = 'http://homeroom.test/?demo=1#homeroom-bot/new?project=run-club-1a2b3c';

    // Pass one (popstate): the router hands the address over, and the page
    // opens the new chat and puts its own address in the bar.
    location.hash = '#homeroom-bot/new?project=run-club-1a2b3c';
    globalThis.window.event = { type: 'popstate' };
    ai.openNew(location.hash);
    const first = asked();
    assert.deepEqual(first.fresh, { project: 'run-club-1a2b3c', builder: 'homeroom' });
    location.hash = '#homeroom-bot?project=run-club-1a2b3c';

    // Pass two (hashchange, for the same navigation): the router sees a bare
    // tab address and asks to close. That ask is dropped.
    globalThis.window.event = { type: 'hashchange', newURL: asking };
    ai.closeColumn();
    assert.deepEqual(asked(), first, 'the new chat stays asked for: nothing closed it');

    // The tab pressed afterwards is a navigation of its own, and closes it.
    location.hash = '#homeroom-bot';
    globalThis.window.event = { type: 'hashchange', newURL: 'http://homeroom.test/?demo=1#homeroom-bot' };
    ai.closeColumn();
    assert.equal(asked().close, true, 'the tab pressed still closes the column');
    assert.equal(asked().seq, first.seq + 1);

    // With the address in the bar already the page's own, the tab pressed
    // runs the router with no event at all.
    ai.openNew('#homeroom-bot/new');
    globalThis.window.event = undefined;
    ai.closeColumn();
    assert.equal(asked().close, true);

    // The rule itself: only a hashchange, only one that went to a new chat,
    // and only once the address has been replaced.
    assert.equal(door.isNewChatEcho({ type: 'hashchange', newURL: asking }, '#homeroom-bot?project=run-club-1a2b3c'), true);
    assert.equal(door.isNewChatEcho({ type: 'hashchange', newURL: asking }, '#homeroom-bot/new?project=run-club-1a2b3c'), false,
      'the address still asks for the new chat: the page has not taken it, and the router asks again');
    assert.equal(door.isNewChatEcho({ type: 'popstate', newURL: asking }, '#homeroom-bot'), false);
    assert.equal(door.isNewChatEcho({ type: 'hashchange', newURL: 'http://homeroom.test/#homeroom-bot/thread/5' }, '#homeroom-bot'), false);
    assert.equal(door.isNewChatEcho({ type: 'hashchange' }, '#homeroom-bot'), false);
    assert.equal(door.isNewChatEcho(null, '#homeroom-bot'), false);

    // A thread asked for after the new chat is the last ask: a bare address
    // then is the tab pressed, whatever event carries it.
    ai.openNew('#homeroom-bot/new');
    ai.openAt({ threadRootId: 5, focusMessageId: null });
    globalThis.window.event = { type: 'hashchange', newURL: asking };
    ai.closeColumn();
    assert.equal(asked().close, true, 'only the pass that follows a new chat\'s own ask is dropped');
  } finally { globalThis.window = had.window; }
  const src = read('frontend/src/features/ai/door.ts');
  assert.match(src, /export function askBotClose\(\): void \{\n\s+if \(asked\?\.fresh && typeof window !== 'undefined'\n\s+&& isNewChatEcho\(window\.event as \{ type\?: string; newURL\?: unknown \} \| undefined, window\.location\.hash\)\) return;\n\s+seq \+= 1;/);
});
