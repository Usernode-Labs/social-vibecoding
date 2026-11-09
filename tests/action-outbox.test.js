'use strict';

// Votes and reactions made with no connection wait on the device and go once
// it is back (offline follow-up, 2 Nov 2026). Offline, or on a network that
// connects but passes nothing, a vote came back "Your vote did not go
// through" and a reaction with the browser's own "Load failed": the person
// had to remember to do it again. What this pins:
//
//   1. frontend/src/lib/action-outbox.ts: records kept per account in
//      IndexedDB, a newer one under the same key replacing the older, sent
//      oldest first only while the shell is online with a confirmed session,
//      each answer announced; no answer keeps the rest for later, a refusal
//      drops its record.
//   2. AppView.castVote keeps a vote with no answer and leaves it on the
//      card; _actionSent hears how it went. A vote that reached the server
//      another way drops the kept one; sign-out clears them all.
//   3. Reactions name the state they want (`on`), so a repeat is harmless,
//      and one with no answer is kept and drawn at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const OUTBOX = 'frontend/src/lib/action-outbox.ts';

/** Just enough IndexedDB for the outbox: one database, one store keyed by `key`. */
function fakeIndexedDb() {
  const rows = new Map();
  const later = (fn) => setImmediate(fn);
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {};
      const store = {
        put(value) { rows.set(value.key, structuredClone(value)); later(() => tx.oncomplete?.()); },
        delete(key) { rows.delete(key); later(() => tx.oncomplete?.()); },
        clear() { rows.clear(); later(() => tx.oncomplete?.()); },
        getAll() {
          const request = {};
          later(() => { request.result = [...rows.values()].map((value) => structuredClone(value)); request.onsuccess?.(); });
          return request;
        },
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  return {
    rows,
    open() {
      const request = { result: db };
      later(() => request.onsuccess?.());
      return request;
    },
  };
}

const answer = (status, data = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

/** A window with a signed-in viewer, a probe and a server whose answers the test picks. */
function harness({ viewer = 7 } = {}) {
  const events = new EventTarget();
  const sent = [];
  const outcomes = [];
  const timers = [];
  let reply = () => Promise.resolve(answer(200));
  let offline = false;
  const win = {
    App: { user: { id: viewer }, _sessionFromSnapshot: false },
    Offline: { isOffline: () => offline },
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    fetch: (url, init) => {
      sent.push({ url, method: init.method, body: JSON.parse(init.body) });
      return reply(url, init);
    },
  };
  win.addEventListener('usernode:action-outbox', (event) => outcomes.push(event.detail));
  const idb = fakeIndexedDb();
  const engine = loadTsx(OUTBOX);
  const outbox = engine.createActionOutbox(win, idb, 50);
  return {
    engine, outbox, win, idb, sent, outcomes, timers,
    answer: (fn) => { reply = fn; },
    goOffline: (value) => { offline = value; },
  };
}

const vote = (id, side, epoch = 3) => ({ key: `vote:${id}`, kind: 'vote', url: `/api/sessions/${id}/vote`, body: { vote: side, expectedEpoch: epoch } });

test('records are kept per account, a newer one replacing an older under the same key', async () => {
  const { engine } = harness();
  const { sendable, actionRecord, refusal, MAX_ACTIONS, MAX_ACTION_AGE_MS } = engine;
  assert.equal(MAX_ACTION_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  const now = Date.UTC(2026, 10, 2);
  const mine = Array.from({ length: MAX_ACTIONS + 2 }, (_, i) => ({ ...vote(i + 1, 'yes'), viewer: 7, savedAt: now - 1000 * (200 - i) }));
  const theirs = { ...vote(900, 'no'), viewer: 8, savedAt: now };
  const stale = { ...vote(901, 'yes'), viewer: 7, savedAt: now - MAX_ACTION_AGE_MS - 1 };
  const foreign = { ...vote(902, 'yes'), viewer: 7, savedAt: now, url: 'https://elsewhere.example/api/x' };
  const { keep, drop } = sendable([theirs, ...mine.slice().reverse(), stale, foreign], 7, now);
  assert.equal(keep.length, MAX_ACTIONS);
  assert.deepEqual(keep.map((item) => item.key), mine.slice(2).map((item) => item.key), 'oldest first');
  assert.deepEqual(drop.sort(), ['vote:1', 'vote:2', 'vote:900', 'vote:901', 'vote:902'].sort());
  assert.equal(actionRecord({ ...vote(1, 'yes'), kind: 'reaction', viewer: 7, savedAt: now }), null, 'a key names its kind');
  // Kept for later: no answer that is about the action.
  for (const status of [401, 408, 429, 500, 502, 503]) assert.equal(refusal(status), false, String(status));
  // The server's no: dropped.
  for (const status of [400, 403, 404, 409, 410, 422]) assert.equal(refusal(status), true, String(status));
});

test('a pass sends oldest first, announces each answer, and a refusal drops only its own record', async () => {
  const h = harness();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
  assert.equal(await h.outbox.queue(vote(11, 'yes')), true);
  await tick();
  assert.equal(await h.outbox.queue(vote(12, 'yes')), true);
  await tick();
  assert.equal(await h.outbox.queue(vote(11, 'no')), true, 'a No after a Yes on the same change');
  h.answer((url) => Promise.resolve(url.includes('/12/') ? answer(409, { error: 'This change was updated.', approvalEpoch: 4 }) : answer(200, { ok: true })));
  await h.outbox.flush();
  assert.deepEqual(h.sent.map((item) => [item.url, item.body.vote]), [
    ['/api/sessions/12/vote', 'yes'],
    ['/api/sessions/11/vote', 'no'],
  ], 'the newer record replaced the older, and goes in the order it was made');
  assert.deepEqual(h.outcomes.map((item) => [item.outcome, item.record.key, item.status]), [
    ['refused', 'vote:12', 409],
    ['sent', 'vote:11', 200],
  ]);
  assert.equal(h.outcomes[0].data.error, 'This change was updated.', 'the server\'s words ride along');
  assert.equal(h.outcomes[1].record.viewer, 7);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.idb.rows.size, 0);
});

test('no answer keeps the rest for later, in order, and tries again on a slow loop', async () => {
  const h = harness();
  await h.outbox.queue(vote(21, 'yes'));
  await h.outbox.queue(vote(22, 'yes'));
  for (const fail of [
    () => Promise.reject(new TypeError('Load failed')),
    () => new Promise(() => {}), // a network that passes nothing: the send's own limit
    () => Promise.resolve(answer(503)),
    () => Promise.resolve(answer(401)),
  ]) {
    h.sent.length = 0;
    h.answer(fail);
    await h.outbox.flush();
    assert.deepEqual(h.sent.map((item) => item.url), ['/api/sessions/21/vote'], 'the first is tried, and the pass stops');
    assert.equal(h.outcomes.length, 0);
    assert.deepEqual([...h.idb.rows.keys()], ['vote:21', 'vote:22']);
  }
  assert.equal(h.timers.length, 1, 'one retry waiting, however many passes stopped');
  assert.equal(h.timers[0].ms, h.engine.ACTION_RETRY_MS);
  h.answer(() => Promise.resolve(answer(200)));
  h.sent.length = 0;
  h.timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.sent.map((item) => item.url), ['/api/sessions/21/vote', '/api/sessions/22/vote']);
});

test('nothing is sent offline, before the session is confirmed, or for another account', async () => {
  const h = harness();
  await h.outbox.queue(vote(31, 'yes'));
  h.goOffline(true);
  await h.outbox.flush();
  h.goOffline(false);
  h.win.App._sessionFromSnapshot = true;
  await h.outbox.flush();
  assert.deepEqual(h.sent, []);
  h.win.App._sessionFromSnapshot = false;
  h.win.App.user = { id: 8 };
  await h.outbox.flush();
  assert.deepEqual(h.sent, [], 'another account sends nothing of this one\'s');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.idb.rows.size, 0, 'and the first read under it deleted it');

  h.win.App.user = null;
  assert.equal(await h.outbox.queue(vote(32, 'yes')), false, 'nobody signed in: nothing kept, and the caller says it was not sent');
  const none = harness();
  const bare = none.engine.createActionOutbox(none.win, null);
  assert.equal(await bare.queue(vote(33, 'yes')), false, 'no storage: the same');
});

test('a page that starts with records waiting announces them once, as queued, for that viewer only', async () => {
  // Offline rerun, 2 Nov 2026: a kept vote's button must say it is on its
  // way after the app is closed and opened again before the connection is back.
  const h = harness();
  await h.outbox.queue(vote(51, 'yes'));
  await h.outbox.queue({ key: 'reaction:9:👍', kind: 'reaction', url: '/api/conversations/1/messages/9/reactions', body: { emoji: '👍', on: true } });
  await h.outbox.announceKept();
  assert.deepEqual(h.outcomes.map((item) => [item.outcome, item.record.key]), [['queued', 'vote:51'], ['queued', 'reaction:9:👍']]);
  await h.outbox.announceKept();
  assert.equal(h.outcomes.length, 2, 'once per page');
  assert.deepEqual(h.sent, [], 'announcing sends nothing');
  const other = harness({ viewer: 8 });
  await other.outbox.queue(vote(52, 'no'));
  other.win.App.user = { id: 9 };
  await other.outbox.announceKept();
  assert.deepEqual(other.outcomes, [], 'another account hears nothing of this one\'s');
});

test('a dropped or cleared record is never sent', async () => {
  const h = harness();
  await h.outbox.queue(vote(41, 'yes'));
  await h.outbox.queue(vote(42, 'yes'));
  h.outbox.drop('vote:41');
  await h.outbox.flush();
  assert.deepEqual(h.sent.map((item) => item.url), ['/api/sessions/42/vote']);
  await h.outbox.queue(vote(43, 'yes'));
  h.outbox.clear();
  h.sent.length = 0;
  await h.outbox.flush();
  assert.deepEqual(h.sent, []);
});

test('the shell sends on the connection coming back, and clears on sign-out', () => {
  const src = read(OUTBOX);
  assert.match(src, /window\.addEventListener\('online', flush\);/);
  assert.match(src, /window\.addEventListener\('usernode:network-changed', flush\);/);
  assert.match(src, /window\.addEventListener\('usernode:offline-change', \(event\) => \{\s+if \(\(event as CustomEvent<\{ offline\?: boolean \}>\)\.detail\?\.offline === false\) flush\(\);/);
  assert.match(src, /document\.addEventListener\('sv:session', \(\) => \{ void outbox\.announceKept\(\)\.then\(flush, flush\); \}\);/,
    'who is signed in is known: what is waiting is said first, then sent');
  assert.match(src, /bridge\.actionOutbox = outbox;/);
  assert.match(read('frontend/src/main.tsx'), /bootStep\('installActionOutbox', \(\) => installActionOutbox\(\)\);/);
  assert.match(read('public/js/app.js'), /window\.UsernodeReact\?\.actionOutbox\?\.clear\?\.\(\);/, 'App._dropCachedSession');
});

test('a vote with no answer is kept and stays on the card; one answered another way drops it', () => {
  const src = read('public/js/app-view.js');
  const cast = src.slice(src.indexOf('  async castVote('), src.indexOf('  VOTE_SEND_TIMEOUT_MS:'));
  assert.match(cast, /const res = await AppView\._sendVote\(sessionId, body\);\s+answered = true;/);
  assert.match(cast, /if \(!answered && await AppView\._queueVote\(sessionId, body\)\) \{\s+queued = true;\s+window\.PlatformUI\?\.toast\?\.\(PlatformI18n\.t\('changes:vote\.toast\.queued'\)\);\s+return true;\s+\}\s+rollback\(\);/,
    'no rollback, no settle: the pending vote holds the card');
  assert.match(cast, /window\.UsernodeReact\?\.actionOutbox\?\.drop\?\.\(`vote:\$\{sessionId\}`\);/, 'a vote that landed drops the older kept one');
  // Offline rerun, 2 Nov 2026: a kept vote keeps its "Sending…" mark, or the
  // change page's Votes card offered Vote again for a vote waiting to go.
  assert.match(cast, /queued = true;\s+window\.PlatformUI\?\.toast\?\.\(PlatformI18n\.t\('changes:vote\.toast\.queued'\)\);/);
  assert.match(cast, /if \(!queued\) AppView\._publishVoteSending\(`castVote:\$\{sessionId\}`, null\);/);
  const undo = src.slice(src.indexOf('  async retractVote('), src.indexOf('  async retractVote(') + 6000);
  assert.match(undo, /window\.UsernodeReact\?\.actionOutbox\?\.drop\?\.\(`vote:\$\{sessionId\}`\);/, 'so does an undo');
  // The send has a limit: on a network that passes nothing it waited for minutes.
  assert.match(src, /VOTE_SEND_TIMEOUT_MS: 15000,/);
  assert.match(src, /setTimeout\(\(\) => ctrl\.abort\(\), AppView\.VOTE_SEND_TIMEOUT_MS\)/);
  // How it went, late.
  assert.match(src, /window\.addEventListener\('usernode:action-outbox', \(event\) => AppView\._actionSent\(event\.detail\)\);/);
  const late = src.slice(src.indexOf('  _actionSent(detail) {'), src.indexOf('  _actionSent(detail) {') + 2400);
  assert.match(late, /AppView\._publishVoteSaved\(sessionId, vote, record\.body\.expectedEpoch\);/);
  assert.match(late, /if \(detail\.outcome === 'queued'\) \{\s+if \(vote === 'yes' \|\| vote === 'no'\) AppView\._publishVoteSending\(`castVote:\$\{sessionId\}`, vote\);\s+return;\s+\}\s+AppView\._publishVoteSending\(`castVote:\$\{sessionId\}`, null\);/,
    'a waiting vote shows as on its way; an answered one, sent or refused, clears it');
  assert.match(late, /PlatformI18n\.t\('changes:vote\.toast\.queuedSent'\)/);
  assert.match(late, /PlatformI18n\.errorText\(data\) \|\| PlatformI18n\.t\('changes:vote\.toast\.queuedRefused'\)/);
  for (const id of ['changes:vote.toast.queued', 'changes:vote.toast.queuedSent', 'changes:vote.toast.queuedRefused']) {
    assert.ok(message(id), id);
  }
});

// ── Reactions ─────────────────────────────────────────────────────────────

function storeHarness(t, overrides = {}) {
  const saved = ['window', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  class MessagesApiError extends Error {
    constructor(status, text) { super(text); this.status = status; }
  }
  const ME = { id: 7, username: 'evan' };
  const dm = {
    id: 42, kind: 'direct', title: 'ana', untitled: false, membershipStatus: 'member', canSend: true,
    members: [{ ...ME, status: 'member' }, { id: 9, username: 'ana', status: 'member' }], unreadCount: 0, memberCount: 2,
    lastActivityAt: '2026-11-02T12:00:00Z',
  };
  const row = {
    id: 5, conversationId: 42, sender: { id: 9, username: 'ana' }, content: 'hello', createdAt: '2026-11-02T12:00:00Z',
    reactions: [{ emoji: '👍', count: 1, reacted: false, users: ['ana'] }], attachments: [], objects: [],
  };
  const reacts = [];
  const queued = [];
  const api = {
    MessagesApiError,
    strictId: (value) => (Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [dm],
    getConversation: async () => dm,
    listMessages: async () => ({ messages: [row], nextBefore: null }),
    markRead: async () => {},
    keptConversations: () => null,
    keptConversation: () => null,
    reactionPath: (c, m) => `/api/conversations/${c}/messages/${m}/reactions`,
    reactionsOf: (data) => data.reactions,
    toggleReaction: async (...args) => { reacts.push(args); throw new TypeError('Load failed'); },
    ...overrides,
  };
  let keep = true;
  const outbox = {
    ACTION_OUTBOX_EVENT: 'usernode:action-outbox',
    actionOutbox: () => ({ queue: async (record) => { queued.push(record); return keep; }, drop: () => {} }),
  };
  let snapshot = null;
  const react = { useSyncExternalStore: (_subscribe, get) => { snapshot = get; return get(); } };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => null });
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react, '../../lib/action-outbox': outbox } });
  store.useMessagesSnapshot();
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return { store, api, reacts, queued, state: () => snapshot(), flush, refuseKeeping: () => { keep = false; }, MessagesApiError };
}

test('a reaction names the state it wants; with no answer it is kept and drawn at once', async (t) => {
  const h = storeHarness(t);
  h.store.messagesController.route(42);
  await h.flush();
  await h.store.react(5, '👍');
  assert.deepEqual(h.reacts.map((args) => args.slice(1)), [[5, '👍', true]], 'on: the viewer had not reacted with it');
  assert.deepEqual(h.queued, [{
    key: 'reaction:5:👍', kind: 'reaction', url: '/api/conversations/42/messages/5/reactions', body: { emoji: '👍', on: true },
  }]);
  const drawn = h.state().messages.find((item) => item.id === 5).reactions;
  assert.deepEqual(drawn, [{ emoji: '👍', count: 2, reacted: true, users: ['ana', 'evan'] }]);
  // A second tap while still offline takes it back, and replaces the kept one.
  await h.store.react(5, '👍');
  assert.deepEqual(h.queued[1].body, { emoji: '👍', on: false });
  assert.equal(h.queued[1].key, 'reaction:5:👍');
  assert.deepEqual(h.state().messages.find((item) => item.id === 5).reactions, [{ emoji: '👍', count: 1, reacted: false, users: ['ana'] }]);
  // Nowhere to keep it: said in words, never the browser's.
  h.refuseKeeping();
  await assert.rejects(h.store.react(5, '🎉'), (error) => error.message === message('messages:row.error.reaction'));
});

test('a reaction the server refused is its word, not kept', async (t) => {
  const h = storeHarness(t);
  h.api.toggleReaction = async () => { throw new h.MessagesApiError(409, 'That message was deleted.'); };
  h.store.messagesController.route(42);
  await h.flush();
  await assert.rejects(h.store.react(5, '👍'), /That message was deleted\./);
  assert.deepEqual(h.queued, []);
});

test('the reaction route reads `on`, and the client sends it with a limit', () => {
  assert.match(read('src/routes/conversations.js'), /const want = typeof req\.body\?\.on === 'boolean' \? req\.body\.on : null;\s+const result = await conversations\.toggleReaction\(pool, req\.user, id, messageId, req\.body\?\.emoji, want\);/);
  const service = read('src/services/conversations.js');
  assert.match(service, /async function toggleReaction\(pool, user, conversationId, messageId, rawEmoji, want = null\)/);
  assert.match(service, /ON CONFLICT \(message_id, user_id, emoji\) DO NOTHING/);
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /body: JSON\.stringify\(typeof on === 'boolean' \? \{ emoji, on \} : \{ emoji \}\),/);
  assert.match(api, /setTimeout\(\(\) => controller\.abort\(\), REACTION_SEND_TIMEOUT_MS\)/);
});
