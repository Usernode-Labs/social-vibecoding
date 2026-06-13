// Frontend tests for the notification drawer's "Show older notifications"
// control (#279).
//
// History: the drawer once rendered a passive "Scroll for older…" hint;
// the grouped/collapsed list rarely overflows the panel, so scrolling did
// nothing and the hint misled users. A first pass swapped it for a button
// wired to loadMore() — but that only PREFETCHED rows that then folded
// invisibly into collapsed groups, so clicking made the button vanish with
// no new rows. This suite covers the real fix: the footer now REVEALS the
// next batch of older notifications (expanding backlog groups + growing
// their per-group reveal cap), fetching another page only when nothing
// loaded remains hidden, and it stays visible while older content is still
// hidden.
//
// We extract the REAL functions/methods from the shipped source (so the
// tests can't drift from what runs) and exercise them against stubs.
//
// Run with: node --test tests/notifications-loadmore.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'notifications.js'),
  'utf8'
);
const MIGRATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
  'utf8'
);

// GROUP_LEAF_CAP as shipped — the reveal increment + the "hidden older"
// threshold the fix keys off.
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

// Rebuild renderLoadMore() (a top-level function) as a callable closing
// over an injected Notifications stub, so we test the exact shipped markup.
function buildRenderLoadMore(notificationsStub) {
  const m = SRC.match(/function renderLoadMore\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'renderLoadMore() definition found in notifications.js');
  return new Function('Notifications', `${m[0]}\nreturn renderLoadMore();`)(
    notificationsStub
  );
}

const buildHasHiddenOlder = () =>
  new Function('Notifications', 'GROUP_LEAF_CAP', methodBody('_hasHiddenOlder'));
const buildRevealLoadedHidden = () =>
  new Function('Notifications', 'GROUP_LEAF_CAP', methodBody('_revealLoadedHidden'));
const buildShowOlder = () =>
  new Function('Notifications', `return (async function(){${methodBody('showOlder')}\n})();`);

// ── renderLoadMore() / footer visibility ────────────────────────────────

test('footer is absent only when there are no more pages AND nothing hidden', () => {
  const html = buildRenderLoadMore({ hasMore: false, _hasHiddenOlder: () => false });
  assert.equal(html, '', 'no footer when everything older is already on screen');
});

test('footer renders a clickable "Show older notifications" button when hasMore', () => {
  const html = buildRenderLoadMore({ hasMore: true, _hasHiddenOlder: () => false });
  assert.match(html, /Show older notifications/, 'honest, actionable label');
  assert.match(html, /data-loadmore/, 'carries the click-target hook');
  assert.match(html, /id="notifications-loadmore"/, 'keeps the loading-state id');
  assert.match(html, /^<button/, 'is a real button, not a passive div');
});

test('footer persists when hasMore is false but loaded leaves are still hidden', () => {
  const html = buildRenderLoadMore({ hasMore: false, _hasHiddenOlder: () => true });
  assert.match(html, /Show older notifications/,
    'does not vanish while a collapsed backlog is still hidden (#279)');
});

test('the misleading "Scroll for older" copy is gone', () => {
  assert.doesNotMatch(SRC, /Scroll for older/, 'no passive scroll hint remains');
});

// ── footer wiring ───────────────────────────────────────────────────────

test('_renderList wires the footer button to showOlder with stopPropagation', () => {
  const m = SRC.match(/\[data-loadmore\][\s\S]*?addEventListener\('click'[\s\S]*?\}\);/);
  assert.ok(m, 'a click handler is bound to the [data-loadmore] footer');
  assert.match(m[0], /e\.stopPropagation\(\)/, 'stops propagation so the drawer is not dismissed');
  assert.match(m[0], /Notifications\.showOlder\(\)/, 'drives the reveal-older path');
});

test('_renderLoadingState makes the footer non-interactive while loading', () => {
  const m = SRC.match(/_renderLoadingState\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(m, '_renderLoadingState() definition found');
  assert.match(m[0], /Loading…/, 'swaps the label to a loading cue');
  assert.match(m[0], /disabled\s*=\s*true/, 'disables the button mid-fetch');
});

test('the scroll handler also reveals (not just prefetches)', () => {
  const m = SRC.match(/addEventListener\('scroll'[\s\S]*?\}\);/);
  assert.ok(m, 'scroll listener found');
  assert.match(m[0], /Notifications\.showOlder\(\)/, 'near-bottom scroll calls showOlder');
});

// ── _hasHiddenOlder() ───────────────────────────────────────────────────

test('_hasHiddenOlder is true when a group has more loaded items than its cap', () => {
  const hasHidden = buildHasHiddenOlder();
  const stub = {
    revealed: new Map(),
    _groupByApp: () => [{ key: 'a', items: new Array(GROUP_LEAF_CAP + 5) }],
  };
  assert.equal(hasHidden(stub, GROUP_LEAF_CAP), true);
});

test('_hasHiddenOlder is false for small groups within the cap', () => {
  const hasHidden = buildHasHiddenOlder();
  const stub = {
    revealed: new Map(),
    _groupByApp: () => [{ key: 'a', items: new Array(3) }],
  };
  assert.equal(hasHidden(stub, GROUP_LEAF_CAP), false,
    'a few-item collapsed group does not count as older content');
});

// ── _revealLoadedHidden() ───────────────────────────────────────────────

test('_revealLoadedHidden expands backlog groups and bumps their reveal cap', () => {
  const reveal = buildRevealLoadedHidden();
  let saved = 0;
  const stub = {
    expanded: new Set(),
    revealed: new Map(),
    _saveExpanded: () => { saved++; },
    _groupByApp: () => [
      { key: 'big', items: new Array(GROUP_LEAF_CAP + 5) }, // hidden older
      { key: 'small', items: new Array(2) },                // fully visible
    ],
  };
  const changed = reveal(stub, GROUP_LEAF_CAP);
  assert.equal(changed, true, 'reports that something was revealed');
  assert.ok(stub.expanded.has('big'), 'expands the collapsed backlog group');
  assert.equal(stub.revealed.get('big'), GROUP_LEAF_CAP * 2, 'grows the reveal cap by one page');
  assert.ok(!stub.expanded.has('small'), 'leaves fully-visible groups untouched');
  assert.equal(saved, 1, 'persists the expansion');
});

test('_revealLoadedHidden returns false when nothing is hidden', () => {
  const reveal = buildRevealLoadedHidden();
  const stub = {
    expanded: new Set(),
    revealed: new Map(),
    _saveExpanded: () => {},
    _groupByApp: () => [{ key: 'a', items: new Array(2) }],
  };
  assert.equal(reveal(stub, GROUP_LEAF_CAP), false);
});

// ── showOlder() ─────────────────────────────────────────────────────────

test('showOlder reveals loaded-hidden leaves and does NOT fetch', async () => {
  const showOlder = buildShowOlder();
  const calls = [];
  const stub = {
    loading: false,
    hasMore: true,
    _revealLoadedHidden: () => { calls.push('reveal'); return true; },
    _renderList: () => { calls.push('render'); },
    loadMore: async () => { calls.push('loadMore'); },
  };
  await showOlder(stub);
  assert.deepEqual(calls, ['reveal', 'render'], 'reveals then renders, no fetch');
});

test('showOlder fetches the next page only when nothing loaded is hidden', async () => {
  const showOlder = buildShowOlder();
  const calls = [];
  let revealCalls = 0;
  const stub = {
    loading: false,
    hasMore: true,
    _revealLoadedHidden: () => { revealCalls++; calls.push('reveal'); return false; },
    _renderList: () => { calls.push('render'); },
    loadMore: async () => { calls.push('loadMore'); },
  };
  await showOlder(stub);
  assert.deepEqual(calls, ['reveal', 'loadMore', 'reveal', 'render'],
    'reveal(empty) → fetch → reveal fresh rows → render');
  assert.equal(revealCalls, 2);
});

test('showOlder is a no-op while a fetch is already in flight', async () => {
  const showOlder = buildShowOlder();
  const calls = [];
  const stub = {
    loading: true,
    hasMore: true,
    _revealLoadedHidden: () => { calls.push('reveal'); return true; },
    _renderList: () => { calls.push('render'); },
    loadMore: async () => { calls.push('loadMore'); },
  };
  await showOlder(stub);
  assert.deepEqual(calls, [], 'does nothing while loading');
});

// ── staging seed ────────────────────────────────────────────────────────

test('staging seed adds a >100-row backlog so the footer appears in previews', () => {
  const fn = MIGRATE_SRC.match(
    /async function seedStagingNotifications\([\s\S]*?\n\}/
  );
  assert.ok(fn, 'seedStagingNotifications() found in migrate.js');
  const body = fn[0];

  // Strictly staging-gated (no-op in production).
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'seed is staging-gated');

  // The backlog must clear the 100-row first page so hasMore is true.
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
