// Frontend tests for the notification drawer's per-group "Show more →"
// pager (#279).
//
// History: the drawer once had a global bottom-of-list control to load
// older notifications — first a passive "Scroll for older…" hint, then a
// "Show older notifications" button, then a reveal-all-collapsed-groups
// handler. All three confused users on the grouped/collapsed layout, so
// the global control was removed entirely. Older notifications are now
// reached only by expanding an app group and clicking that group's own
// "Show more →" link, which reveals already-loaded leaves and falls
// through to loadMore() to fetch older pages on demand.
//
// We extract the REAL functions/methods from the shipped source (so the
// tests can't drift from what runs) and exercise them against stubs.
//
// Run with: node --test tests/notifications-show-more.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const MIGRATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
  'utf8'
);

// GROUP_LEAF_CAP as shipped — the reveal increment for "Show more →".
const GROUP_LEAF_CAP = (() => {
  const m = SRC.match(/const GROUP_LEAF_CAP\s*=\s*(\d+)/);
  assert.ok(m, 'GROUP_LEAF_CAP literal found');
  return Number(m[1]);
})();

// Pull a 2-space-indented object method's body out of the source so we can
// rebuild it as a standalone callable closing over injected stubs.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

// ── the global control is gone ──────────────────────────────────────────

test('no global "load older" control remains in source', () => {
  assert.doesNotMatch(SRC, /renderLoadMore/, 'renderLoadMore() removed');
  assert.doesNotMatch(SRC, /data-loadmore/, 'footer button hook removed');
  assert.doesNotMatch(SRC, /id="notifications-loadmore"/, 'footer markup removed');
  assert.doesNotMatch(SRC, /Show older notifications/, 'global button label removed');
});

test('the prior misleading "Scroll for older" copy is still gone', () => {
  assert.doesNotMatch(SRC, /Scroll for older/, 'no passive scroll hint remains');
});

test('no global reveal/scroll handlers remain', () => {
  assert.doesNotMatch(SRC, /showOlder/, 'showOlder() removed');
  assert.doesNotMatch(SRC, /_hasHiddenOlder/, '_hasHiddenOlder() removed');
  assert.doesNotMatch(SRC, /_revealLoadedHidden/, '_revealLoadedHidden() removed');
  assert.doesNotMatch(SRC, /_wireScroll/, '_wireScroll() removed');
  assert.doesNotMatch(SRC, /_renderLoadingState/, '_renderLoadingState() removed');
  assert.doesNotMatch(SRC, /addEventListener\('scroll'/, 'no scroll listener bound');
  assert.doesNotMatch(SRC, /LOAD_MORE_THRESHOLD/, 'unused scroll constant removed');
});

test('_renderList no longer appends a footer to the list markup', () => {
  const m = SRC.match(/list\.innerHTML\s*=\s*(entries\.join\([^\n;]+);/);
  assert.ok(m, 'the grouped-entries innerHTML assignment found');
  assert.match(m[1], /entries\.join\(APP_DIVIDER\)/, 'renders just the grouped entries');
  assert.doesNotMatch(m[1], /\+/, 'nothing concatenated after the entries (no footer)');
});

// ── the per-group "Show more →" pager still works ───────────────────────

// Rebuild _showMoreGroup(key) as a standalone callable over injected stubs.
function buildShowMoreGroup() {
  const body = methodBody('_showMoreGroup');
  return new Function('Notifications', 'GROUP_LEAF_CAP', 'key', body);
}

test('_showMoreGroup reveals already-loaded leaves without fetching', () => {
  const showMore = buildShowMoreGroup();
  const calls = [];
  const stub = {
    revealed: new Map(),                       // cap defaults to GROUP_LEAF_CAP
    hasMore: true,                             // would fetch if leaves were exhausted
    _groupByApp: () => [{ key: 'a', items: new Array(GROUP_LEAF_CAP + 5) }],
    _renderList: () => calls.push('render'),
    loadMore: () => calls.push('loadMore'),
  };
  showMore(stub, GROUP_LEAF_CAP, 'a');
  assert.equal(stub.revealed.get('a'), GROUP_LEAF_CAP * 2, 'bumps the reveal cap by one page');
  assert.deepEqual(calls, ['render'], 're-renders locally, does not fetch');
});

test('_showMoreGroup fetches the next page when loaded leaves are exhausted and hasMore', () => {
  const showMore = buildShowMoreGroup();
  const calls = [];
  const stub = {
    revealed: new Map([['a', GROUP_LEAF_CAP]]), // already showing all loaded leaves
    hasMore: true,
    _groupByApp: () => [{ key: 'a', items: new Array(GROUP_LEAF_CAP) }],
    _renderList: () => calls.push('render'),
    loadMore: () => calls.push('loadMore'),
  };
  showMore(stub, GROUP_LEAF_CAP, 'a');
  assert.equal(stub.revealed.get('a'), GROUP_LEAF_CAP * 2, 'raises the cap so fetched leaves show');
  assert.deepEqual(calls, ['loadMore'], 'fetches the next cross-app page on demand');
});

test('_showMoreGroup does nothing when nothing is loaded and the server is exhausted', () => {
  const showMore = buildShowMoreGroup();
  const calls = [];
  const stub = {
    revealed: new Map([['a', GROUP_LEAF_CAP]]),
    hasMore: false,
    _groupByApp: () => [{ key: 'a', items: new Array(GROUP_LEAF_CAP) }],
    _renderList: () => calls.push('render'),
    loadMore: () => calls.push('loadMore'),
  };
  showMore(stub, GROUP_LEAF_CAP, 'a');
  assert.deepEqual(calls, [], 'no reveal, no fetch — group fully shown');
});

test('renderGroup offers a "Show more →" button while the server has more pages', () => {
  // Source-level assertion: the expanded-group renderer must still emit a
  // per-group pager (data-group-showmore) in the hasMore branch.
  const m = SRC.match(/function renderGroup\([\s\S]*?\n\}/);
  assert.ok(m, 'renderGroup() found');
  assert.match(m[0], /else if \(Notifications\.hasMore\)/, 'has a hasMore fallthrough branch');
  assert.match(m[0], /data-group-showmore/, 'emits the per-group "Show more" control');
  assert.match(m[0], /Show more/, 'labels it "Show more"');
});

// ── staging seed (unchanged) ────────────────────────────────────────────

test('staging seed keeps the >100-row backlog so the per-group pager is exercisable', () => {
  const fn = MIGRATE_SRC.match(
    /async function seedStagingNotifications\([\s\S]*?\n\}/
  );
  assert.ok(fn, 'seedStagingNotifications() found in migrate.js');
  const body = fn[0];

  // Strictly staging-gated (no-op in production).
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'seed is staging-gated');

  // A deep single-app backlog (> GROUP_LEAF_CAP) makes the self-app group
  // show a "Show more →" a tester can page through.
  const countMatch = body.match(/BACKLOG_COUNT\s*=\s*(\d+)/);
  assert.ok(countMatch, 'BACKLOG_COUNT is defined');
  assert.ok(
    Number(countMatch[1]) > 100,
    `backlog (${countMatch[1]}) exceeds the 100-row first page`
  );

  // Idempotent: reboots must not duplicate the backlog.
  assert.match(body, /NOT EXISTS/, 'backlog inserts skip rows that already exist');
  // Obviously-fake, consistently-prefixed fixture content.
  assert.match(body, /\[staging fixture\] backlog notification/, 'rows are clearly labelled fixtures');
});
