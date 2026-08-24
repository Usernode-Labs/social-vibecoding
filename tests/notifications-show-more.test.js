// Frontend tests for how the notification drawer reaches OLDER notifications.
//
// History, and why this file has now changed sides twice (#279, #1385):
//
//   1. The drawer had a global bottom-of-list control — first a passive
//      "Scroll for older…" hint, then a "Show older notifications" button,
//      then a reveal-all-collapsed-groups handler. All three confused people,
//      and #279 removed the global control entirely.
//   2. Older notifications were then reached ONLY by expanding an app group
//      and clicking that group's own "Show more →", which revealed
//      already-loaded leaves and fell through to loadMore() for older pages.
//   3. #1385 flattened the list. There are no groups to expand, so step 2's
//      control had nowhere to live — and it was the only caller of loadMore()
//      in the codebase, so removing it without a replacement would have
//      stranded server pagination on page one.
//
// So a foot-of-list pager is back. That is not step 1 repeating itself: what
// #279 actually killed was a SCROLL-DRIVEN reveal of rows that were loaded but
// deliberately hidden, on a collapsed layout where "older" was ambiguous
// (hidden inside a fold? or not yet fetched?). This one is an explicit button,
// it hides nothing, and on a flat list "older" has exactly one meaning. The
// assertions below still pin every piece of the scroll machinery as gone.
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
// #1191 slice 6 moved the drawer's markup out of the controller and into this
// component, so the "what does the list render" assertions read it instead.
const LIST_SRC = fs.readFileSync(
  path.join(
    __dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications-list.tsx'
  ),
  'utf8'
);
const MIGRATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
  'utf8'
);

// The "X is gone" assertions below are about CODE, not prose: several comments
// in these files deliberately NAME the thing they replaced, and that history is
// the most useful part of them. So strip comments before asserting absence —
// the same distinction AGENTS.md draws for the AdminUI registry, where prose in
// comments is explicitly fine and only code mentions are policed.
//
// Only whole-line `//` comments are stripped, so a `https://` inside a string
// survives; block comments include JSX's `{/* … */}`, which collapses to `{}`.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = codeOnly(SRC);
const LIST_CODE = codeOnly(LIST_SRC);

/** The #notifications-list scroller, comments stripped. */
function listBlock() {
  const m = LIST_CODE.match(/id="notifications-list"[\s\S]*?\n {6}<\/div>/);
  assert.ok(m, 'the #notifications-list container found');
  return m[0];
}

// Pull a 2-space-indented object method's body out of the source so we can
// rebuild it as a standalone callable closing over injected stubs.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

// ── the SCROLL-driven machinery stays gone ──────────────────────────────

test('no scroll-driven reveal machinery remains in source', () => {
  // #279's actual target. #1385's button is an explicit click, so none of
  // this comes back with it.
  assert.doesNotMatch(CODE, /renderLoadMore/, 'renderLoadMore() removed');
  assert.doesNotMatch(CODE, /data-loadmore/, 'old footer button hook removed');
  assert.doesNotMatch(CODE, /id="notifications-loadmore"/, 'old footer markup removed');
  assert.doesNotMatch(CODE, /Show older notifications/, 'old global button label removed');
  assert.doesNotMatch(CODE, /Scroll for older/, 'no passive scroll hint remains');
  assert.doesNotMatch(SRC, /\bshowOlder\s*\([^)]*\)\s*\{/, 'showOlder() removed');
  assert.doesNotMatch(CODE, /_hasHiddenOlder/, '_hasHiddenOlder() removed');
  assert.doesNotMatch(CODE, /_revealLoadedHidden/, '_revealLoadedHidden() removed');
  assert.doesNotMatch(CODE, /_wireScroll/, '_wireScroll() removed');
  assert.doesNotMatch(CODE, /_renderLoadingState/, '_renderLoadingState() removed');
  assert.doesNotMatch(SRC, /addEventListener\('scroll'/, 'no scroll listener bound');
  assert.doesNotMatch(CODE, /LOAD_MORE_THRESHOLD/, 'unused scroll constant removed');
});

// ── the list is FLAT (#1385) ────────────────────────────────────────────

test('every trace of the grouped layout is gone from both files', () => {
  for (const [name, src] of [['notifications.js', CODE], ['notifications-list.tsx', LIST_CODE]]) {
    assert.doesNotMatch(src, /_groupByApp/, `${name}: the grouping transform is gone`);
    assert.doesNotMatch(src, /groupView/, `${name}: the group descriptor is gone`);
    assert.doesNotMatch(src, /_toggleGroup/, `${name}: expand/collapse is gone`);
    assert.doesNotMatch(src, /_markGroupRead/, `${name}: per-group mark-read is gone`);
    assert.doesNotMatch(src, /_showMoreGroup/, `${name}: the per-group pager is gone`);
    assert.doesNotMatch(src, /data-group-(toggle|markread|showmore)/, `${name}: group hooks gone`);
    assert.doesNotMatch(src, /GROUP_LEAF_CAP/, `${name}: the per-group reveal cap is gone`);
  }
  // The persisted expansion set goes with it — including the storage key, so a
  // returning viewer's old localStorage entry is simply never read again.
  assert.doesNotMatch(CODE, /notif_expanded_groups_v1/, 'the expansion storage key is gone');
  assert.doesNotMatch(CODE, /_loadExpanded|_saveExpanded|_pruneExpanded|_foldAllGroups/,
    'the expansion lifecycle is gone');
});

test('_renderList publishes one row descriptor per notification, in feed order', () => {
  const body = methodBody('_renderList');
  // Straight `map(rowView)` over the filtered feed: no partition, no re-sort,
  // no entry wrapper. That IS the flat list.
  assert.match(body, /list:\s*Notifications\._bellItems\(\)\.map\(rowView\)/,
    'maps the feed straight to row descriptors');
  assert.doesNotMatch(body, /\{\s*type:\s*'(row|group)'/, 'no tagged entry wrapper survives');
  assert.doesNotMatch(body, /\.sort\(/, 'and does not reorder the feed');
});

test('the renderer maps rows directly, with no between-apps divider', () => {
  assert.match(listBlock(), /rows\.map\(/, 'renders one child per row');
  assert.doesNotMatch(LIST_CODE, /DIVIDER/,
    'the heavier between-apps divider is gone — rows carry their own border');
});

// ── the foot pager reaches loadMore() (#1385) ───────────────────────────

// Rebuild loadOlder() as a standalone callable over injected stubs.
function buildLoadOlder() {
  return new Function('Notifications', methodBody('loadOlder'));
}

test('loadOlder fetches the next page when the server has one', () => {
  const calls = [];
  const stub = { hasMore: true, loading: false, loadMore: () => calls.push('loadMore') };
  buildLoadOlder()(stub);
  assert.deepEqual(calls, ['loadMore'], 'pulls the next page');
});

test('loadOlder does nothing once the cursor is exhausted', () => {
  const calls = [];
  const stub = { hasMore: false, loading: false, loadMore: () => calls.push('loadMore') };
  buildLoadOlder()(stub);
  assert.deepEqual(calls, [], 'no fetch with nothing left to fetch');
});

test('loadOlder does not stack requests while a page is in flight', () => {
  const calls = [];
  const stub = { hasMore: true, loading: true, loadMore: () => calls.push('loadMore') };
  buildLoadOlder()(stub);
  assert.deepEqual(calls, [], 'a double-tap cannot queue a second page');
});

test('the pager renders inside the scroller and is wired to loadOlder', () => {
  const block = listBlock();
  // INSIDE the scroller, because it is the end of the list. Contrast the
  // older-toggle below, which is drawer chrome over what is already in hand.
  assert.match(block, /id="notifications-load-more"/, 'the pager sits after the rows');
  assert.match(block, /controller\(\)\?\.loadOlder\(\)/, 'wired to the controller');
  assert.match(block, /disabled=\{state\.loadingMore\}/, 'refuses clicks mid-flight');
  assert.match(block, /state\.canLoadMore/, 'offered only when a page exists');
  assert.match(block, /e\.stopPropagation\(\)/,
    'stops the click, or the re-render dismisses the drawer');
});

test('the older-toggle is a different control, and still outside the scroller', () => {
  // Two distinct affordances: this one reveals READ rows already fetched, the
  // pager goes and gets more from the server. Conflating them is the exact
  // ambiguity that made #279 remove the original global control.
  assert.match(LIST_CODE, /id="notifications-older-toggle"/, 'the older toggle exists…');
  assert.doesNotMatch(listBlock(), /notifications-older-toggle/,
    '…and sits outside the rows scroller');
});

// ── staging seed (unchanged) ────────────────────────────────────────────

test('staging seed keeps the >100-row backlog so the foot pager is exercisable', () => {
  const fn = MIGRATE_SRC.match(
    /async function seedStagingNotifications\([\s\S]*?\n\}/
  );
  assert.ok(fn, 'seedStagingNotifications() found in migrate.js');
  const body = fn[0];

  // Strictly staging-gated (no-op in production).
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'seed is staging-gated');

  // A backlog deeper than the 100-row first page is what makes `hasMore` true,
  // which is the only thing that renders the pager at all.
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
