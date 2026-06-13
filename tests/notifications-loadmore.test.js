// Frontend tests for the notification drawer's "load older" footer (#279).
//
// The drawer used to render a passive "Scroll for older…" hint, but the
// grouped/collapsed list rarely overflows the panel, so scrolling did
// nothing and the hint misled users. The footer is now an explicit
// clickable "Show older notifications" button that drives the existing
// loadMore() pagination path.
//
// We extract the REAL renderLoadMore() from the shipped source (so the
// test can't drift from what renders) and exercise it against both
// hasMore states, plus assert the wiring/loading-state and the staging
// backlog seed via source checks.
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

// Pull the literal renderLoadMore() out of the source and rebuild it as a
// callable that closes over an injected Notifications stub, so we test the
// exact markup that ships.
function buildRenderLoadMore(notificationsStub) {
  const m = SRC.match(/function renderLoadMore\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'renderLoadMore() definition found in notifications.js');
  // Declare the extracted function, then return its invocation.
  return new Function('Notifications', `${m[0]}\nreturn renderLoadMore();`)(
    notificationsStub
  );
}

test('renderLoadMore returns nothing when there are no older pages', () => {
  const html = buildRenderLoadMore({ hasMore: false });
  assert.equal(html, '', 'no footer rendered when hasMore is false');
});

test('renderLoadMore renders a clickable "Show older notifications" button', () => {
  const html = buildRenderLoadMore({ hasMore: true });
  assert.match(html, /Show older notifications/, 'honest, actionable label');
  assert.match(html, /data-loadmore/, 'carries the click-target hook');
  assert.match(html, /id="notifications-loadmore"/, 'keeps the loading-state id');
  assert.match(html, /^<button/, 'is a real button, not a passive div');
});

test('the misleading "Scroll for older" copy is gone', () => {
  assert.doesNotMatch(SRC, /Scroll for older/, 'no passive scroll hint remains');
});

test('_renderList wires the footer button to loadMore with stopPropagation', () => {
  const m = SRC.match(/\[data-loadmore\][\s\S]*?addEventListener\('click'[\s\S]*?\}\);/);
  assert.ok(m, 'a click handler is bound to the [data-loadmore] footer');
  assert.match(m[0], /e\.stopPropagation\(\)/, 'stops propagation so the drawer is not dismissed');
  assert.match(m[0], /Notifications\.loadMore\(\)/, 'drives the existing loadMore path');
});

test('_renderLoadingState makes the footer non-interactive while loading', () => {
  const m = SRC.match(/_renderLoadingState\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(m, '_renderLoadingState() definition found');
  assert.match(m[0], /Loading…/, 'swaps the label to a loading cue');
  assert.match(m[0], /disabled\s*=\s*true/, 'disables the button mid-fetch');
});

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
