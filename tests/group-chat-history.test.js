const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

function setup(scope) {
  const requests = [];
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    window: {}, URLSearchParams, location: { search: '' },
    setTimeout, clearTimeout, AbortController,
    document: { getElementById: () => null },
    fetch: (url, init) => new Promise((resolve, reject) => {
      const req = { url, resolve, reject };
      // #4640: a first page's fetch carries an abort signal, so a request
      // that never answers is given up on. The stub honours it the way the
      // browser's own fetch would.
      if (init && init.signal && typeof init.signal.addEventListener === 'function') {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      }
      requests.push(req);
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/group-chat.js'), 'utf8'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'first-app';
  gc._demoParam = () => '';
  gc.render = gc.renderThread = gc.scrollToBottom = () => {};
  const state = () => scope === 'general' ? gc : gc._threadState('issue', 1868);
  const load = () => scope === 'general' ? gc.loadHistory() : gc.loadThreadHistory('issue', 1868);
  const reply = (index, messages) => requests[index].resolve({ ok: true, json: async () => ({ messages }) });
  const ids = () => Array.from(state().messages, m => m.id);
  return { gc, requests, state, load, reply, ids };
}

for (const scope of ['general', 'thread']) {
  test(`${scope}: overlapping initial loads display A B C only once`, async () => {
    const h = setup(scope);
    const first = h.load();
    const second = h.load();
    assert.equal(h.requests.length, 1);
    h.reply(0, [{ id: 1, content: 'A' }, { id: 2, content: 'B' }, { id: 3, content: 'C' }]);
    await Promise.all([first, second]);
    assert.deepEqual(h.ids(), [1, 2, 3]);
  });

  test(`${scope}: history overlaps live messages without losing their latest content`, async () => {
    const h = setup(scope);
    const pending = h.load();
    h.state().messages.push({ id: 3, content: 'edited live' }, { id: 4, content: 'new live' });
    h.reply(0, [{ id: 1 }, { id: 2 }, { id: '3', content: 'old history' }]);
    await pending;
    assert.deepEqual(h.ids(), [1, 2, 3, 4]);
    assert.equal(h.state().messages[2].content, 'edited live');
  });

  test(`${scope}: repeated earlier-page actions preserve order and raw page cursor`, async () => {
    const h = setup(scope);
    const initial = h.load();
    h.reply(0, Array.from({ length: 50 }, (_, i) => ({ id: 51 + i })));
    await initial;
    const page = h.load();
    const repeated = h.load();
    assert.equal(h.requests.length, 2);
    assert.match(h.requests[1].url, /before=51/);
    h.reply(1, [{ id: 49 }, { id: 50 }, { id: 51 }]);
    await Promise.all([page, repeated]);
    assert.deepEqual(h.ids(), Array.from({ length: 52 }, (_, i) => 49 + i));
    assert.equal(h.state().hasMore, false);
    assert.equal(scope === 'general' ? h.gc.oldestMessageId : h.state().oldestId, 49);
  });

  for (const failure of ['http', 'network', 'json']) {
    test(`${scope}: retries after ${failure} failure`, async () => {
      const h = setup(scope);
      const failed = h.load();
      if (failure === 'http') h.requests[0].resolve({ ok: false });
      if (failure === 'network') h.requests[0].reject(new Error('offline'));
      if (failure === 'json') h.requests[0].resolve({ ok: true, json: async () => { throw new Error('bad JSON'); } });
      await failed;
      const retry = h.load();
      assert.equal(h.requests.length, 2);
      h.reply(1, [{ id: 1 }]);
      await retry;
      assert.deepEqual(h.ids(), [1]);
    });
  }

  test(`${scope}: retired requests cannot populate or unlock a replacement conversation`, async () => {
    const h = setup(scope);
    const old = h.load();
    // Leave and return to the same app before the old request resolves.
    h.gc.disconnect();
    h.gc.appSlug = 'first-app';
    h.gc.messages = [];
    const current = h.load();
    h.reply(0, [{ id: 1 }]);
    await old;
    assert.deepEqual(h.ids(), []);
    await h.load();
    assert.equal(h.requests.length, 2);
    h.reply(1, [{ id: 2 }]);
    await current;
    assert.deepEqual(h.ids(), [2]);
  });
}

test('different threads can load independently', async () => {
  const h = setup('thread');
  const first = h.load();
  const other = h.gc.loadThreadHistory('proposal', 42);
  assert.equal(h.requests.length, 2);
  h.reply(1, [{ id: 2 }]);
  h.reply(0, [{ id: 1 }]);
  await Promise.all([first, other]);
  assert.deepEqual(h.ids(), [1]);
  assert.equal(h.gc._threadState('proposal', 42).messages[0].id, 2);
});

// #2992: a failed history request used to leave a reply thread on "Loading…"
// forever (and the general stream blank): nothing re-rendered it. These drive
// the real render()/renderThread() and read the lead each one publishes.
function setupPublished(scope) {
  const requests = [];
  const published = [];
  const host = { dataset: {}, scrollHeight: 0, scrollTop: 0 };
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    window: {}, URLSearchParams, location: { search: '' },
    document: { getElementById: (id) => (id === 'gc-messages' || id === 'gc-thread-messages' ? host : null) },
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/group-chat.js'), 'utf8'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'first-app';
  gc._demoParam = () => '';
  gc.scrollToBottom = () => {};
  gc.markRead = async () => {};
  gc._applyPendingReveal = () => {};
  gc._messageView = (m) => ({ id: m.id });
  sandbox.window.UsernodeReact = {
    groupChat: {
      mountTranscript() {},
      publishTranscript: (rows, key, lead) => published.push({ key, rows, lead }),
    },
  };
  const key = scope === 'general' ? 'main' : 'thread';
  if (scope === 'thread') gc.activeThread = { type: 'message', ref: 7 };
  const load = () => (scope === 'general' ? gc.loadHistory() : gc.loadThreadHistory('message', 7));
  const lead = () => published.filter((p) => p.key === key).at(-1)?.lead;
  return { gc, requests, load, lead };
}

for (const scope of ['general', 'thread']) {
  const errorText = scope === 'general' ? 'Couldn’t load messages.' : 'Couldn’t load this thread.';
  for (const failure of ['http', 'network']) {
    test(`${scope}: a ${failure} failure shows the error with Try again, and a retry clears it (#2992)`, async () => {
      const h = setupPublished(scope);
      if (scope === 'thread') h.gc.renderThread();
      const failed = h.load();
      if (scope === 'thread') assert.equal(h.lead().placeholder, 'Loading…');
      if (failure === 'http') h.requests[0].resolve({ ok: false, status: 500 });
      else h.requests[0].reject(new Error('offline'));
      await failed;
      assert.equal(h.lead().error, errorText, 'the failure is published');
      assert.equal(h.lead().placeholder, null, 'no longer "Loading…"');
      if (scope === 'general') assert.equal(h.lead().quiet, null, 'a failed load is not a quiet channel');

      // "Try again" is the same entry point the transcript's button calls.
      const retry = scope === 'general' ? h.gc.loadHistory() : h.gc.loadThreadHistoryForOpen();
      assert.equal(h.requests.length, 2);
      if (scope === 'thread') {
        assert.equal(h.lead().error, null, 'the retry goes back to Loading…');
        assert.equal(h.lead().placeholder, 'Loading…');
      }
      h.requests[1].resolve({ ok: true, json: async () => ({ messages: [{ id: 1, content: 'hi' }] }) });
      await (retry || Promise.resolve());
      await new Promise((r) => setImmediate(r));
      assert.equal(h.lead().error, null, 'a successful retry clears the error');
      assert.equal(h.lead().placeholder, null);
    });
  }
}

// A history page lands ABOVE the reader, so where the scroller ends up is
// measured against the rows it just added. The transcript's store is batched
// (features/group-chat/mount.ts): measured on the next line, the new rows
// were not in the scroller yet. The first page opened at its OLDEST message
// instead of the newest, and every earlier page threw the reader to the top
// of what had just loaded (iOS has no scroll anchoring to hide it). The fake
// below commits a publish only when it is flushed; a batched one lands after
// the measurement, the way React's next commit does.
const ROW_PX = 100;
function setupScroll(scope) {
  const requests = [];
  const host = { dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 300 };
  const flushes = [];
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    window: {}, URLSearchParams, location: { search: '' },
    document: { getElementById: (id) => (id === 'gc-messages' || id === 'gc-thread-messages' ? host : null) },
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/group-chat.js'), 'utf8'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'first-app';
  gc._demoParam = () => '';
  gc.markRead = async () => {};
  gc._applyPendingReveal = () => {};
  gc._messageView = (m) => ({ id: m.id });
  const commit = (rows) => { host.scrollHeight = rows.length * ROW_PX; };
  sandbox.window.UsernodeReact = {
    groupChat: {
      mountTranscript() {},
      publishTranscript: (rows, key, lead, opts) => {
        flushes.push(!!(opts && opts.flush));
        if (opts && opts.flush) commit(rows);
        else setImmediate(() => commit(rows));
      },
    },
  };
  if (scope === 'thread') gc.activeThread = { type: 'message', ref: 7 };
  const load = () => (scope === 'general' ? gc.loadHistory() : gc.loadThreadHistory('message', 7));
  const page = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i }));
  return { gc, host, requests, load, page, flushes };
}

for (const scope of ['general', 'thread']) {
  test(`${scope}: the first page opens at its newest message, measured after its rows commit`, async () => {
    const h = setupScroll(scope);
    if (scope === 'thread') h.gc.renderThread();
    const first = h.load();
    h.requests[0].resolve({ ok: true, json: async () => ({ messages: h.page(51, 50) }) });
    await first;
    assert.equal(h.host.scrollHeight, 50 * ROW_PX, 'the rows were in the scroller when it was measured');
    assert.equal(h.host.scrollTop, 50 * ROW_PX, 'pinned to the bottom, not left at the oldest row');
    assert.equal(h.flushes.at(-1), true, 'the history publish is flushed');
  });

  test(`${scope}: an earlier page keeps the reader on the message they were reading`, async () => {
    const h = setupScroll(scope);
    if (scope === 'thread') h.gc.renderThread();
    const first = h.load();
    h.requests[0].resolve({ ok: true, json: async () => ({ messages: h.page(51, 50) }) });
    await first;
    // The reader scrolls up to the top of the loaded page and asks for more.
    h.host.scrollTop = 0;
    const earlier = h.load();
    h.requests[1].resolve({ ok: true, json: async () => ({ messages: h.page(21, 30) }) });
    await earlier;
    assert.equal(h.host.scrollHeight, 80 * ROW_PX);
    assert.equal(h.host.scrollTop, 30 * ROW_PX, 'offset by exactly the height the new rows added');
  });
}

// #4640: the side panel's discussion never loaded when its first history
// request was either dropped by a cache swap (connect / refreshAfterBlock) or
// left on the wire forever.
const DRAIN = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

test('thread: a load whose cache was swapped mid-flight re-runs for the open thread', async () => {
  const h = setup('thread');
  h.gc.activeThread = { type: 'issue', ref: 1868 };
  const first = h.load();
  assert.equal(h.requests.length, 1);
  // The refreshAfterBlock-style swap: every per-thread cache is dropped while
  // the fetch is on the wire.
  h.gc.threads = new Map();
  h.reply(0, [{ id: 1 }]);
  await first;
  assert.equal(h.requests.length, 2, 'a second load runs for the state the open thread reads');
  h.reply(1, [{ id: 2 }]);
  await DRAIN();
  assert.equal(h.gc._threadState('issue', 1868).loaded, true);
  assert.deepEqual(h.ids(), [2]);
});

test('thread: a load whose cache was swapped mid-flight does not re-run for a thread nobody is reading', async () => {
  const h = setup('thread');
  const first = h.load();
  h.gc.threads = new Map();
  h.reply(0, [{ id: 1 }]);
  await first;
  await DRAIN();
  assert.equal(h.requests.length, 1, 'no load runs for a thread that is not open');
});

test('thread: a first page that never answers gives up after the timeout and offers Try again', async () => {
  const h = setup('thread');
  h.gc.activeThread = { type: 'issue', ref: 1868 };
  // Shorten the 20 s first-page timer the way the spec's test row describes.
  h.gc.THREAD_FIRST_PAGE_TIMEOUT_MS = 20;
  const load = h.load(); // the fetch stub never answers on its own
  await new Promise((r) => setTimeout(r, 80));
  await load;
  const st = h.gc._threadState('issue', 1868);
  assert.equal(st.failed, true, 'the state records the failure');
  assert.equal(st.loading, false);
  assert.equal(st.loaded, false);
  // "Try again" is the same entry point the transcript's button calls.
  const retry = h.gc.loadThreadHistoryForOpen();
  assert.equal(h.requests.length, 2);
  h.reply(1, [{ id: 1 }]);
  await retry;
  await DRAIN();
  assert.equal(st.loaded, true);
  assert.deepEqual(h.ids(), [1]);
});

test('thread: resyncLoaded re-reads an open thread that is neither loaded nor loading', async () => {
  const h = setup('thread');
  h.gc.activeThread = { type: 'issue', ref: 1868 };
  // An idle state: mounted, its first page neither in hand nor on the wire
  // (a failed one reads the same to _resyncThread). resyncLoaded is what a
  // reconnect runs.
  const st = h.gc._threadState('issue', 1868);
  assert.equal(st.loaded, false);
  assert.equal(st.loading, false);
  h.gc.resyncLoaded();
  const threadReq = h.requests.find((r) => r.url.includes('thread_type=issue'));
  assert.ok(threadReq, 'the open thread is re-read on the resync');
  // The resync's own general-stream read rides along; answer it too.
  h.requests.find((r) => !r.url.includes('thread_type='))
    .resolve({ ok: true, json: async () => ({ messages: [] }) });
  threadReq.resolve({ ok: true, json: async () => ({ messages: [{ id: 1 }] }) });
  await DRAIN();
  assert.equal(st.loaded, true);
  assert.deepEqual(h.ids(), [1]);
});
