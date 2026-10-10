// #4650: a search or filter on All items reaches past the Done cards the
// board had already loaded. While the filters are on, the board back-fills
// older merged history through the SAME keyset pager a manual "Show more"
// uses (loadMoreMerged), bounded to 10 batches of 50, so Done's search covers
// older completed work without anyone pressing "Show more" repeatedly.
//
// The harness is tests/board-pagination-refresh.test.js's: app-view.js in a
// vm context, a stubbed fetch serving a paged /merged (server default 20,
// `limit` honoured), and paint entry points stubbed. The board model itself
// is read through the real `_kanbanView()`, whose Done column is `cols`
// key 'done'.
//
// Run with: node --test tests/board-search-done-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const row = (id, title) => ({
  id, row_type: 'pr', pr_number: id, pr_title: title || `Change ${id}`,
  created_at: new Date(Date.UTC(2026, 8, 14) + id * 1000).toISOString(),
});
const key = item => `${item.row_type || 'pr'}:${item.id}`;
const completed = r => r.completed_at || r.merged_at || r.payload?.appliedAt || r.created_at;
const compare = (a, b) => Date.parse(completed(b)) - Date.parse(completed(a))
  || (b.row_type === 'close_issue' ? 0 : 1) - (a.row_type === 'close_issue' ? 0 : 1)
  || b.id - a.id;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Bounded wait so a test whose premise never arrives FAILS instead of hanging.
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await sleep(5);
  }
  return true;
};

function fixture(rows = Array.from({ length: 170 }, (_, i) => row(i + 1))) {
  const state = { rows, calls: [], beforeResponse: null, repaints: 0 };
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    App: { user: { id: 3, username: 'viewer' }, currentApp: 'demo', currentTab: 'dev', currentSubTab: 'forum' },
    location: { search: '', hash: '' }, localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, alert: () => {},
    relTime: () => 'just now',
    escapeHtml: s => String(s == null ? '' : s),
    escapeAttr: s => String(s == null ? '' : s),
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async address => {
      const url = new URL(address, 'https://example.test');
      state.calls.push(url);
      if (url.pathname.endsWith('/merged')) {
        const sorted = state.rows.slice().sort(compare);
        const q = url.searchParams;
        const cursor = q.has('before') ? {
          completed_at: q.get('before_completed_at') || q.get('before'),
          id: Number(q.get('before_id')), row_type: q.get('before_type'),
        } : null;
        const remaining = cursor ? sorted.filter(r => compare(r, cursor) > 0) : sorted;
        const limit = Number(q.get('limit')) || 20;
        let data = { merged: remaining.slice(0, limit), hasMore: remaining.length > limit, total: sorted.length };
        data = plain(data);
        const override = state.beforeResponse && await state.beforeResponse(url, data);
        return override || { ok: true, json: async () => data };
      }
      if (url.pathname.endsWith('/board-search')) {
        return { ok: true, json: async () => ({ issues: [], sessions: [], gov: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.subject = AppView;`, sandbox);
  const av = sandbox.subject;
  av.appData = { slug: 'demo' };
  av._repaintDevBody = () => { state.repaints += 1; };
  av._loadWorkshopThemes = () => {};
  av._syncChecksPoll = () => {};
  const load = async () => { assert.equal(await av._loadDevData(), true); };
  // Wait out the fire-and-forget back-fill loop. Each paint schedules it on
  // a zero timer, so first yield until nothing is scheduled-or-running, then
  // re-check once more in case a just-fired timer started a loop.
  const settle = async () => {
    for (;;) {
      await sleep(10);
      const pager = av._mergedPager;
      if ((!pager || !pager.autoRunning) && !av._mergedLoadingMore) return;
    }
  };
  const doneColumn = view => view.cols.find(c => c.key === 'done');
  const backfillCalls = () => state.calls.filter(u =>
    u.pathname.endsWith('/merged') && u.searchParams.get('limit') === '50');
  return { av, state, sandbox, load, settle, doneColumn, backfillCalls };
}

test('a search back-fills older done pages and the old match reaches the Done column', async () => {
  const { av, state, load, settle, doneColumn, backfillCalls } = fixture();
  // The match sits past the first page and past the first back-fill batch:
  // page order is newest first, so id 80 lands in the third page fetched.
  state.rows.find(r => r.id === 80).pr_title = 'Transfer the balance between wallets';
  await load();
  assert.equal(av._merged.length, 20);
  av._kanbanFilters = { q: 'trans' };
  const view = av._kanbanView();
  assert.equal(doneColumn(view).rows.length, 0, 'before the back-fill, nothing older has arrived');
  await settle();
  assert.equal(av._merged.length, 170, 'all three older pages were appended');
  assert.equal(new Set(av._merged.map(key)).size, 170, 'no page was appended twice');
  const backfilled = backfillCalls();
  assert.equal(backfilled.length, 3, 'the initial load is not repeated and no batch is wasted');
  assert.ok(backfilled.every(u => u.searchParams.get('before')), 'back-fill pages follow the keyset cursor');
  const after = doneColumn(av._kanbanView());
  assert.equal(after.count, 1);
  assert.equal(after.rows.length, 1);
  assert.ok(JSON.stringify(after.rows[0].card).includes('80'), 'the Done column shows the older match');
});

test('no filter, or a one-letter search only, fetches nothing older', async () => {
  const { av, state, load, settle } = fixture();
  await load();
  const before = state.calls.filter(u => u.pathname.endsWith('/merged')).length;
  av._kanbanFilters = {};
  av._kanbanView();
  av._kanbanFilters = { q: 't' };
  av._kanbanView();
  await settle();
  assert.equal(state.calls.filter(u => u.pathname.endsWith('/merged')).length, before,
    'an unfiltered board and a one-letter search do not back-fill');
  assert.equal(av._merged.length, 20);
});

test('a non-`q` filter alone starts the back-fill even with no search text', async () => {
  const { av, state, load, settle, backfillCalls } = fixture();
  state.rows.find(r => r.id === 80).pr_title = 'Transfer the balance between wallets';
  await load();
  av._kanbanFilters = { assignee: 'viewer' };
  av._kanbanView();
  await settle();
  assert.ok(backfillCalls().length >= 1, 'a filter without a query still looks through older history');
  assert.equal(av._merged.length, 170);
});

test('the back-fill stops at its page cap and leaves Show more in place', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
  const { av, state, load, settle, doneColumn } = fixture(rows);
  await load();
  av._kanbanFilters = { q: 'change' };
  const view = av._kanbanView();
  await settle();
  assert.equal(av._mergedPager.autoPages, 10, 'at most MERGED_SEARCH_BACKFILL_PAGES batches ran');
  assert.equal(av._merged.length, 20 + 10 * 50);
  assert.equal(av._mergedHasMore, true, 'history beyond the cap is untouched');
  assert.equal(new Set(av._merged.map(key)).size, av._merged.length);
  const after = doneColumn(av._kanbanView());
  assert.equal(after.footer && after.footer.kind, 'loadMerged');
  assert.equal(after.footer.n, null, 'Show more stays at the foot of Done, uncounted');
  const laterCalls = state.calls.filter(u => u.pathname.endsWith('/merged')).length;
  av._kanbanView();
  await settle();
  assert.equal(state.calls.filter(u => u.pathname.endsWith('/merged')).length, laterCalls,
    'the cap holds: later paints with the same search fetch nothing more');
});

test('a failed batch stops the back-fill for the visit without a retry loop', async () => {
  const { av, state, load, settle, backfillCalls } = fixture();
  await load();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged') && url.searchParams.has('before')) return { ok: false };
  };
  av._kanbanFilters = { q: 'trans' };
  av._kanbanView();
  await settle();
  assert.equal(backfillCalls().length, 1, 'one failed attempt, no retry');
  assert.equal(av._mergedPager.autoFailed, true);
  assert.equal(av._merged.length, 20);
  state.beforeResponse = null;
  av._kanbanView();
  await settle();
  assert.equal(backfillCalls().length, 1, 'later paints with the same search fetch nothing more');
});

test('clearing the search stops the loop after the page in flight', async () => {
  const { av, state, load, settle, backfillCalls } = fixture();
  await load();
  const gate = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged') && url.searchParams.has('before')) {
      await gate.promise;
    }
    return null;
  };
  av._kanbanFilters = { q: 'trans' };
  av._kanbanView();
  assert.ok(await waitFor(() => backfillCalls().length), 'the in-flight page started');
  av._kanbanFilters = {};
  gate.resolve();
  await settle();
  assert.equal(backfillCalls().length, 1, 'no page is requested after the one in flight');
  assert.equal(av._merged.length, 70, 'the batch already on its way still lands');
  assert.ok(!av._mergedPager.autoFailed, 'clearing the search is not a failure');
});

test('two paints in a row run one loop at a time — no overlapping pages', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
  const { av, state, load, settle, backfillCalls } = fixture(rows);
  await load();
  const gate = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged') && url.searchParams.has('before')) await gate.promise;
    return null;
  };
  av._kanbanFilters = { q: 'change' };
  av._kanbanView();
  av._kanbanView();
  assert.ok(await waitFor(() => backfillCalls().length), 'the in-flight page started');
  assert.equal(backfillCalls().length, 1, 'the second paint did not start a second loop');
  gate.resolve();
  await settle();
  assert.equal(backfillCalls().length, 10, 'one bounded loop served both paints');
  assert.equal(new Set(av._merged.map(key)).size, av._merged.length);
});

test('loadMoreMerged with no arguments keeps manual paging on the default page size', async () => {
  const { av, load, backfillCalls } = fixture();
  await load();
  assert.equal(await av.loadMoreMerged(), true, 'a manual Load more still appends a page');
  assert.equal(av._merged.length, 40);
  assert.equal(backfillCalls().length, 0, 'the manual path carries no limit of its own');
  assert.equal(av._mergedPager.autoPages || 0, 0, 'manual pages are not counted against the back-fill cap');
  const { av: av2, load: load2 } = fixture(Array.from({ length: 10 }, (_, i) => row(i + 1)));
  await load2();
  assert.equal(av2._mergedHasMore, false);
  assert.equal(await av2.loadMoreMerged(), false, 'no more pages means false, not a crash');
});

test('manual paging is not billed as a back-fill failure when it is busy', async () => {
  const { av, state, load, settle, backfillCalls } = fixture();
  await load();
  const gate = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged') && url.searchParams.has('before')) await gate.promise;
    return null;
  };
  const manual = av.loadMoreMerged();
  const manualCall = () => state.calls.filter(u =>
    u.pathname.endsWith('/merged') && u.searchParams.has('before'));
  assert.ok(await waitFor(() => manualCall().length), 'the manual page started');
  av._kanbanFilters = { q: 'trans' };
  av._kanbanView();
  gate.resolve();
  await manual;
  assert.ok(!av._mergedPager.autoFailed,
    'a batch a manual Load more owned is not recorded as a back-fill failure');
  const before = backfillCalls().length;
  av._kanbanView();
  await settle();
  assert.ok(backfillCalls().length > before, 'a later paint carries the back-fill on');
});
