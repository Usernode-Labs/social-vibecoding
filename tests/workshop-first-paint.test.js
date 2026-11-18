// #6826: the Workshop draws before the Done list arrives, and a project
// opened earlier in the session draws its last board at once.
//
// Measured 18 Nov 2026 on production: opening a community's Workshop showed
// grey placeholders until EVERY board read answered, and the slowest was the
// Done list (`/merged?results=failing`, 1.3 to 2 s). Coming back to a project
// opened a minute before started from the skeleton again, because the open's
// reset drops every cache.
//
// So a whole load publishes in two phases — everything but `/merged`, which
// the Overview, the open items and the votes do not need, then `/merged`,
// which fills the Done column, "live this week", What happened and Recently
// live — and each project's last board is kept in memory for the session,
// drawn at once on a revisit and replaced by the fresh answer.
//
// Run with: node --test tests/workshop-first-paint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');

function makeAppView(over) {
  const o = over || {};
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
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const view = sandbox.__AppView;
  // The sandbox's `App`, for the tests that sign another person in.
  view.App = sandbox.App;
  return view;
}

/** A board's own answers, with `/merged` held until the caller lets it go. */
function gatedMerged() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/merged')) {
      await gate;
      return {
        ok: true,
        json: async () => ({
          merged: [{ id: 1, row_type: 'pr', pr_number: 1, status: 'promoted', title: 'Shipped one', merged_at: '2026-06-01T00:00:00Z' }],
          total: 1,
          hasMore: false,
          shipped: { week: 2, prevWeek: 1, prevWeekToDate: 1 },
        }),
      };
    }
    if (u.includes('/github-issues')) {
      return { ok: true, json: async () => ({ issues: [{ number: 7, title: 'Open one', updatedAt: '2026-06-01T00:00:00Z' }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return { fetch, calls, release: () => release() };
}

const doneCol = (AppView) => AppView._kanbanView().cols.find((c) => c.key === 'done');

test('the board draws from everything but the Done list, which fills in after', async () => {
  const { fetch, release } = gatedMerged();
  const AppView = makeAppView({ fetch });
  AppView.appData = { slug: 'demo-app' };

  const load = AppView._loadDevData();
  // Let the core reads settle while `/merged` is still held open.
  for (let i = 0; i < 20 && !AppView._devCoreReady; i += 1) await new Promise((r) => setTimeout(r, 0));

  assert.equal(AppView._devCoreReady, true, 'the core of the board published');
  assert.equal(AppView._devDataReady, false, 'the visit has not loaded whole');
  assert.equal(AppView._devMergedReady, false);

  const v = AppView._workshopView();
  assert.equal(v.loading, false, 'the Workshop draws — no whole-page skeleton');
  assert.equal(v.mergedPending, true, 'the finished-work parts say they are still waiting');
  assert.equal(v.dashboard.everShipped, null, 'has it ever shipped is unknown, not "no"');
  assert.equal(v.dashboard.open, 1, 'the open work is already counted');

  const k = AppView._kanbanView();
  assert.equal(k.loading, false, 'the board is not on its placeholders');
  assert.equal(doneCol(AppView).pending, true, 'the Done column alone is waiting');
  assert.equal(k.cols.find((c) => c.key === 'issues').pending, undefined, 'the others are not');

  release();
  assert.equal(await load, true);

  assert.equal(AppView._devDataReady, true);
  assert.equal(AppView._devMergedReady, true);
  const after = AppView._workshopView();
  assert.equal(after.mergedPending, false);
  assert.equal(after.dashboard.shippedWeek, 2, 'live this week comes from the Done list');
  assert.equal(after.dashboard.everShipped, true);
  assert.equal(doneCol(AppView).pending, false);
  assert.equal(doneCol(AppView).count, 1);
});

test('a failed Done read leaves the rest of the board on screen', async () => {
  const fetch = async (url) => (String(url).includes('/merged')
    ? { ok: false, json: async () => ({}) }
    : { ok: true, json: async () => ({}) });
  const AppView = makeAppView({ fetch });
  AppView.appData = { slug: 'demo-app' };

  assert.equal(await AppView._loadDevData(), false, 'the load as a whole failed');
  assert.equal(AppView._devCoreReady, true, 'but what it did publish stays');
  assert.equal(AppView._devDataReady, false);
  const v = AppView._workshopView();
  assert.equal(v.loading, false, 'the opened work is not put back behind a skeleton');
  assert.equal(v.mergedPending, true, 'the finished-work parts keep their placeholders');
  assert.equal(doneCol(AppView).pending, true);
});

test('a revisit draws the remembered board before any read answers', async () => {
  const AppView = makeAppView();
  AppView._ghIssues = [{ number: 7, title: 'Remembered one', updatedAt: '2026-06-01T00:00:00Z' }];
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [{ id: 1, row_type: 'pr', pr_number: 1, status: 'promoted', merged_at: '2026-06-01T00:00:00Z' }];
  AppView._mergedCtx = { majority: 1, activeUsers: 2 };
  AppView._mergedTotal = 1;
  AppView._workshopThemes = { slug: 'demo-app', themes: [{ id: 't1', name: 'Theme' }], at: Date.now() };
  AppView._devDataReady = true;
  AppView._rememberBoard('demo-app');

  // Leaving and coming back: the open's reset, then the memory.
  AppView._resetDevDataFlags();
  AppView._resetMergedPagination();
  assert.equal(AppView._workshopView().loading, true, 'without memory it would be a skeleton');
  assert.equal(AppView._restoreBoardMemory('demo-app'), true);

  assert.equal(AppView._devDataRemembered, 'demo-app', 'drawn from memory, not read');
  assert.equal(AppView._devDataReady, false, 'the visit has still not read anything');
  const v = AppView._workshopView();
  assert.equal(v.loading, false, 'the board draws at once');
  assert.equal(v.mergedPending, false, 'a remembered board has its Done list too');
  assert.equal(v.dashboard.open, 1);
  assert.equal(AppView._kanbanView().cols.find((c) => c.key === 'done').count, 1);
  assert.equal(AppView._workshopThemes.slug, 'demo-app', 'its themes came back with it');

  // The fresh answer replaces it, and the memory stops being what is drawn.
  AppView.appData = { slug: 'demo-app' };
  await AppView._loadDevData();
  assert.equal(AppView._devDataRemembered, null, 'what is on screen is read now');
  assert.equal(AppView._devDataReady, true);
});

test('the memory is per person, capped, and never a second person\'s board', () => {
  const AppView = makeAppView();
  AppView._devDataReady = true;
  for (const slug of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) AppView._rememberBoard(slug);
  assert.equal(AppView._devBoardMemory.size, AppView.DEV_BOARD_MEMORY_MAX, 'bounded');
  assert.equal(AppView._devBoardMemory.has('1:a'), false, 'the oldest went');
  assert.equal(AppView._devBoardMemory.has('1:i'), true, 'the newest is held');

  // Another person signing in on the same device sees their own board only.
  AppView._devDataRemembered = null;
  AppView.App.user = { id: 2 };
  assert.equal(AppView._restoreBoardMemory('a'), false);
  assert.equal(AppView._devDataRemembered, null);
});

test('two calls in flight for one project\'s themes cost one read', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const AppView = makeAppView({
    fetch: async () => { calls += 1; await gate; return { ok: true, json: async () => ({ themes: [] }) }; },
  });
  const first = AppView._loadWorkshopThemes('demo-app');
  const second = AppView._loadWorkshopThemes('demo-app');
  assert.equal(calls, 1, 'the open\'s load and the early paint share one read');
  assert.equal(second, first, 'the second call is handed the first one\'s promise');
  release();
  await first;
  // Answered: the throttle (60s) then holds the next call back as before.
  await AppView._loadWorkshopThemes('demo-app');
  assert.equal(calls, 1);
});

test('a whole board load stamps the gap a live burst waits out', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'demo-app' };
  AppView._boardFullAt = 0;
  void AppView._loadDevData();
  assert.ok(AppView._boardFullAt > 0, 'the open\'s own load counts as a whole load');
});

test('a correction for /merged re-reads merged alone', async () => {
  const { fetch, calls, release } = gatedMerged();
  const AppView = makeAppView({ fetch });
  AppView.App.currentTab = 'dev';
  AppView.App.currentSubTab = 'forum';
  AppView.appData = { slug: 'demo-app' };
  AppView._devDataReady = true;
  AppView._devCoreReady = true;
  AppView._devMergedReady = true;
  release();

  const run = AppView.refreshDevData('api-update', { urls: new Set(['https://x/api/apps/demo-app/merged?results=failing']) });
  await run;
  const paths = calls.map((u) => u.split('?')[0]);
  assert.deepEqual(paths, ['/api/apps/demo-app/merged'], 'one read, the one the correction named');
});

test('a correction re-reads the parts its URLs name, not the whole board', () => {
  const AppView = makeAppView();
  const parts = (urls) => Array.from(AppView._partsForApiUrls(urls) || []).sort();
  assert.deepEqual(parts(['/api/apps/x/merged?results=failing']), ['merged']);
  assert.deepEqual(parts(['/api/apps/x/github-issues', '/api/apps/x/issues?kinds=governance']), ['issues']);
  assert.deepEqual(parts(['/api/apps/x/promoted?results=failing']), ['promoted']);
  assert.deepEqual(parts(['/api/apps/x/board-order']), ['order']);
  assert.deepEqual(parts(['/api/me/active-sessions?results=failing']), ['sessions']);
  assert.deepEqual(parts(['/api/apps/x/topic-categories']), ['categories']);
  assert.deepEqual(parts(['/api/apps/x/merged', '/api/apps/x/promoted']), ['merged', 'promoted']);
  assert.equal(AppView._partsForApiUrls(['/api/apps/x/community']), null, 'an unknown read is no narrower question');
});
