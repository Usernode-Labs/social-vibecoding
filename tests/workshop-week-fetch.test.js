// #4717: opening a past week's page fetches that week's history.
//
// `openWorkshopWeek` pages /merged (the same pager a manual "Show more"
// uses) until the loaded history reaches back past the week's Monday, and
// `_workshopView()` files every entry in the week's range — uncapped, split
// on the since-baseline — into the `week` the page draws. This suite drives
// the real AppView in a vm sandbox with a recording /merged endpoint,
// asserting:
//   • the loop pages 50 at a time and stops once the oldest row is older
//     than the week (or history runs out);
//   • a page that fails while history continues marks the week `failed`;
//   • `closeWorkshopWeek` (and a later open: a fresh seq) stops a loop that
//     is still running;
//   • `week` files entries by `created` or `t` in the range, uncapped, fresh
//     against seen on the baseline, and is null when no week is open.
//
// Run with: node --test tests/workshop-week-fetch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');

const WEEK = 7 * 86400000;
const monday = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * 86400000;
};

function makeAppView({ fetch } = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: 'demo-app', currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    // `_demoQS()` reads it on every request URL, so a sandbox without one
    // throws before the first fetch is issued.
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const av = sandbox.__AppView;
  av.appData = { slug: 'demo-app', can_collaborate: true };
  // The publish is the React bridge's; these tests read the state and the
  // view model directly.
  av._repaintDevBody = () => {};
  av._repaintDevBodyKeepingPosition = () => {};
  return av;
}

/** A completed row newest-first by `at`, keyed by id so paging is deterministic. */
const mergedRow = (id, at) => ({
  id, row_type: 'pr', pr_number: 500 - id, pr_title: `Change ${id}`,
  status: 'merged', chat_count: 0,
  merged_at: new Date(at).toISOString(),
  created_at: new Date(at - 3600000).toISOString(),
});

/** Seed the pager the way a loaded first page leaves it, and page the rest from `rows`. */
function seedMergedPager(av, state, rows, firstPage = 20) {
  const sorted = rows.slice().sort((a, b) => Date.parse(av._completedAt(b)) - Date.parse(av._completedAt(a)));
  state.rows = sorted;
  const page = sorted.slice(0, firstPage);
  av._merged = page;
  av._mergedCursor = av._mergedRowCursor(page[page.length - 1]);
  av._mergedHasMore = sorted.length > page.length;
  av._mergedTotal = sorted.length;
}

/** A /merged endpoint that pages `state.rows` with the keyset cursor, newest first. */
function mergedEndpoint(state, { limit = 20, failAfter = Infinity } = {}) {
  return async (address) => {
    state.calls.push(String(address));
    if (state.calls.length > failAfter) return { ok: false, json: async () => ({}) };
    const url = new URL(address, 'https://example.test');
    if (!url.pathname.endsWith('/merged')) return { ok: true, json: async () => ({}) };
    const cursor = url.searchParams.has('before')
      ? {
          completed_at: url.searchParams.get('before_completed_at'),
          created_at: url.searchParams.get('before'),
          id: Number(url.searchParams.get('before_id')),
          row_type: url.searchParams.get('before_type'),
        }
      : null;
    const ordered = state.rows.slice()
      .sort((a, b) => Date.parse(b.merged_at || b.created_at) - Date.parse(a.merged_at || a.created_at));
    let remaining = ordered;
    if (cursor) {
      remaining = ordered.filter((r) => Date.parse(r.merged_at) < Date.parse(cursor.completed_at)
        || (Date.parse(r.merged_at) === Date.parse(cursor.completed_at) && r.id < cursor.id));
    }
    const page = remaining.slice(0, Number(url.searchParams.get('limit')) || limit);
    return {
      ok: true,
      json: async () => ({ merged: page, hasMore: remaining.length > page.length, total: state.rows.length }),
    };
  };
}

// ── the fetch loop ─────────────────────────────────────────────────────

test('#4717: opening a week pages merged history back to the week, 50 at a time', async () => {
  const state = { calls: [], rows: [] };
  const av = makeAppView({ fetch: mergedEndpoint(state) });
  // 100 rows spread over ten days: the loaded first page reaches ~5 days
  // back, so last week's Monday (7 days back) takes a second 50-row page.
  const thisMonday = monday(Date.now());
  const start = thisMonday - WEEK;
  const end = thisMonday;
  const rows = Array.from({ length: 100 }, (_, i) => mergedRow(i + 1, Date.now() - (i * 86400000) / 10));
  seedMergedPager(av, state, rows);

  await av.openWorkshopWeek(start, end);
  assert.equal(av._merged.length, 100, 'the loop paged until history reached past the week');
  assert.equal(av._workshopWeek.loading, false);
  assert.equal(av._workshopWeek.failed, false);
  assert.equal(av._workshopWeek.startMs, start);
  assert.deepEqual(state.calls.map((u) => new URL(u, 'https://example.test').searchParams.get('limit')),
    ['50', '50'], 'each page is the week fetch\'s own 50');
  // The cursors chain, and the pager is the manual one: the Done column sees
  // these rows too, as after a "Show more".
  const paged = state.calls.filter((u) => u.includes('before='));
  assert.equal(paged.length, 2);
  assert.ok(av._mergedPager.expanded, 'the manual pager is marked expanded');
});

test('#4717: the loop does not run for a week the loaded history already reaches', async () => {
  const state = { calls: [], rows: [] };
  const av = makeAppView({ fetch: mergedEndpoint(state) });
  const thisMonday = monday(Date.now());
  const rows = Array.from({ length: 5 }, (_, i) => mergedRow(i + 1, Date.now() - i * 3600000));
  seedMergedPager(av, state, rows, 5);
  av._mergedHasMore = false; // the whole (small) history is loaded

  await av.openWorkshopWeek(thisMonday - WEEK, thisMonday);
  assert.deepEqual(state.calls, [], 'no fetch: everything is here already');
  assert.equal(av._workshopWeek.loading, false);
  assert.equal(av._workshopWeek.failed, false);
});

test('#4717: a failed page while history continues marks the week failed', async () => {
  const state = { calls: [], rows: [] };
  const av = makeAppView({ fetch: mergedEndpoint(state, { failAfter: 1 }) });
  const thisMonday = monday(Date.now());
  const start = thisMonday - WEEK;
  const rows = Array.from({ length: 100 }, (_, i) => mergedRow(i + 1, Date.now() - (i * 86400000) / 10));
  seedMergedPager(av, state, rows);
  av._devDataReady = true;
  av._proposals = []; av._govProposals = []; av._mySessions = []; av._sharedSessions = [];

  await av.openWorkshopWeek(start, thisMonday);
  assert.equal(av._workshopWeek.failed, true, 'the page says some of the week could not be loaded');
  assert.equal(av._workshopWeek.loading, false);
  assert.ok(av._merged.length > 20, 'the rows that did land stay loaded');
  const v = av._workshopView();
  assert.equal(v.week.failed, true, 'the view model carries it to the page');
});

test('#4717: closing the week stops a loop that is still running', async () => {
  const state = { calls: [], rows: [] };
  let release;
  const gate = new Promise((r) => { release = r; });
  const base = mergedEndpoint(state);
  const av = makeAppView({
    fetch: async (address) => {
      if (state.calls.length === 1) await gate; // the first page hangs until the test lets it go
      return base(address);
    },
  });
  const thisMonday = monday(Date.now());
  const start = thisMonday - WEEK;
  const rows = Array.from({ length: 100 }, (_, i) => mergedRow(i + 1, Date.now() - (i * 86400000) / 10));
  seedMergedPager(av, state, rows);

  const opening = av.openWorkshopWeek(start, thisMonday);
  assert.equal(av._workshopWeek.loading, true, 'the page says loading while the first page is in flight');
  av.closeWorkshopWeek();
  assert.equal(av._workshopWeek, null, 'the state is gone at once');
  release();
  await opening;
  assert.equal(state.calls.length, 1, 'the running round finished; no further page was fetched');
});

// ── the week the view files ────────────────────────────────────────────

test('#4717: _workshopView files the open week uncapped, fresh against seen on the baseline', () => {
  const av = makeAppView();
  av._devDataReady = true;
  const thisMonday = monday(Date.now());
  const start = thisMonday - WEEK; // last week
  const end = thisMonday;
  const baseline = start + 3600000; // an hour into last week
  av._workshopSince['demo-app'] = baseline;

  // 35 changes went live through last week — more than any cap — one older
  // one before it, and one this week. Two requests: one filed last week,
  // one filed long ago but worked on in it (its activity falls in range).
  const inWeek = Array.from({ length: 35 }, (_, i) => mergedRow(i + 1, start + 86400000 + i * 3600000));
  av._merged = [
    ...inWeek,
    mergedRow(900, start + 1800000), // in the week, before the baseline
    mergedRow(901, thisMonday + 3600000), // this week: outside the range
  ];
  av._mergedCtx = { majority: 1, activeUsers: 1 };
  av._mergedHasMore = false;
  av._mergedTotal = av._merged.length;
  av._ghIssues = [
    { number: 7, title: 'Filed last week', createdAt: new Date(start + 2 * 86400000).toISOString(), updatedAt: new Date(start + 2 * 86400000).toISOString(), lastMessageAt: null, headless: null },
    { number: 8, title: 'Old, worked on last week', createdAt: new Date(start - 10 * 86400000).toISOString(), updatedAt: new Date(start + 3.5 * 86400000).toISOString(), lastMessageAt: new Date(start + 3.5 * 86400000).toISOString(), headless: null },
    { number: 9, title: 'Filed this week', createdAt: new Date(thisMonday + 3600000).toISOString(), updatedAt: new Date(thisMonday + 7200000).toISOString(), lastMessageAt: null, headless: null },
  ];
  av._proposals = [];
  av._govProposals = [];
  av._mySessions = [];
  av._sharedSessions = [];

  av._workshopWeek = { slug: 'demo-app', startMs: start, endMs: end, loading: true, failed: false, seq: 1 };
  const v = av._workshopView();
  assert.ok(v.week, 'the open week is in the view');
  assert.equal(v.week.startMs, start);
  assert.equal(v.week.loading, true, 'the fetch state rides along');

  // Uncapped: every one of the 35 changes plus the two request entries.
  assert.equal(v.week.fresh.length, 37, 'everything after the baseline, not the first 30');
  assert.equal(v.week.seen.length, 1, 'the older change is the seen side');
  const seenKeys = v.week.seen.map((r) => r.key);
  assert.ok(seenKeys.every((k) => k.startsWith('week:')), 'week keys, so a row cannot collide with the since-list\'s');
  // The week's range decides: this week's change and request are not in
  // last week's page.
  assert.ok(!v.week.fresh.some((r) => r.card.title?.text === 'Filed this week'));
  assert.ok(!JSON.stringify(v.week).includes('Change 901'), 'a change that went live this week is not in last week');
  // Fresh against seen on the baseline: the change that went live half an
  // hour into the week moved before the last visit, so it is the seen side.
  assert.ok(v.week.seen.some((r) => JSON.stringify(r).includes('Change 900')), 'what moved before the last visit is seen');
  // Sorted newest first.
  const ats = v.week.fresh.map((r) => r.at);
  assert.deepEqual(ats.slice().sort((a, b) => b - a), ats, 'newest first');
  // `at` is clamped to now, so a server clock ahead cannot open tomorrow.
  assert.ok(ats.every((a) => a <= Date.now()));

  // No week open: the field is null, and the loading model carries it too.
  av._workshopWeek = null;
  assert.equal(av._workshopView().week, null);
  av._devDataReady = false;
  assert.equal(av._workshopView().week, null, 'the empty model carries week: null');
});