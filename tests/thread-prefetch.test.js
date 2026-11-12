// #6604: the reads a thread page starts when it OPENS, rather than after its
// root post has painted.
//
//   - prefetchThread(slug, n) starts `/threads/<n>` at once, once per path;
//   - its answer starts each listed change's own row read
//     (`/proposals/<id>`) before any of them renders;
//   - peekThread answers with the settled payload, so the page's first render
//     has the data;
//   - readChangeDetail joins an in-flight read of the same row, and starts
//     the vote roster ALONGSIDE the row rather than after it.
//
// Run with: node --test tests/thread-prefetch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function withGlobals(fetchImpl, fn) {
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const calls = [];
  global.window = {
    addEventListener() {}, removeEventListener() {},
    AppView: {
      appData: { slug: 'demo' },
      _demoQS: () => '',
      _invalidateVoteRoster() {},
      _loadVoteRoster() { return Promise.resolve(); },
    },
  };
  global.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      global.fetch = previousFetch;
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
    });
}

test('a prefetched thread is read once, and its changes start reading at once', async () => {
  await withGlobals(
    (url) => {
      if (/\/threads\/41$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            thread: { id: 3 },
            items: [
              { type: 'request', number: 41, id: 41 },
              { type: 'change', id: 501, status: 'promoted', number: 12 },
            ],
          }),
        });
      }
      if (/\/proposals\/501/.test(url)) {
        return Promise.resolve({ ok: true, json: async () => ({ proposal: { id: 501, status: 'promoted' } }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    },
    async (calls) => {
      const { prefetchThread, peekThread, threadPath } = loadTsx(
        'frontend/src/features/dev-board/topic/thread-items.tsx');
      const first = prefetchThread('demo', 41);
      const again = prefetchThread('demo', 41);
      assert.equal(first, again, 'the same path joins the read already in flight');
      const payload = await first;
      assert.equal(payload.thread.id, 3);
      // Its changes were read from the ids it lists, not after a render.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls.map((c) => c.url), [
        '/api/apps/demo/threads/41',
        '/api/apps/demo/proposals/501?results=failing',
      ]);
      assert.equal(peekThread(threadPath('demo', 41)), payload, 'the page\'s first render can take it');
    },
  );
});

test('readChangeDetail joins an in-flight read and starts the roster with it', async () => {
  const row = deferred();
  await withGlobals(
    () => row.promise,
    async (calls) => {
      const { readChangeDetail } = loadTsx(
        'frontend/src/features/dev-board/topic/topic-head.tsx');
      const signal = new AbortController().signal;
      const item = { id: 77, status: 'promoted' };
      const a = readChangeDetail(item, false, signal);
      const b = readChangeDetail(item, false, signal);
      assert.equal(calls.length, 1, 'one read answers both callers');
      assert.equal(calls[0].url, '/api/apps/demo/proposals/77?results=failing');
      row.resolve({ ok: true, json: async () => ({ proposal: { id: 77, status: 'promoted' } }) });
      const [rowA, rowB] = await Promise.all([a, b]);
      assert.equal(rowA.id, 77);
      assert.equal(rowB.id, 77);
    },
  );
});

test('the vote roster starts alongside the row read, not after it', async () => {
  const row = deferred();
  const roster = [];
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  global.window = {
    addEventListener() {}, removeEventListener() {},
    AppView: {
      appData: { slug: 'demo' },
      _demoQS: () => '',
      _invalidateVoteRoster(id) { roster.push(`stale:${id}`); },
      _loadVoteRoster(id) { roster.push(`read:${id}`); return Promise.resolve(); },
    },
  };
  global.fetch = () => row.promise;
  try {
    const { readChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
    const pending = readChangeDetail({ id: 88, status: 'merged' }, false, new AbortController().signal);
    // The row is still on the wire; the roster is already asked for.
    assert.deepEqual(roster, ['read:88'], 'the roster read starts with the row');
    row.resolve({ ok: true, json: async () => ({ proposal: { id: 88, status: 'merged' } }) });
    await pending;
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});
