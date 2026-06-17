// Tests for the Dev list scroll-position memory helpers on AppView
// (public/js/app-view.js): the pure keying/clamping logic behind the
// "tapping into an item and coming Back lands where you left off"
// behavior. Mirrors the per-session chat scroll memory in dev-chat.js.
//
// app-view.js is a browser script, but it ships a CommonJS export guard
// at the bottom (and the lone top-level window.addEventListener is
// guarded), so requiring it in node returns the AppView object and the
// pure helpers run without a DOM. Same executable-helper style as
// tests/quick-replies.test.js.
//
// Run with: node --test tests/dev-feed-scroll-memory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const AppView = require('../public/js/app-view.js');

// Each test starts from a clean map so cases don't bleed into each other.
function reset() { AppView._savedFeedScroll = {}; }

test('a saved offset is returned for the matching slug', () => {
  reset();
  AppView._saveFeedScroll('cool-app', 420);
  assert.equal(AppView._getFeedScroll('cool-app'), 420);
});

test('a missing slug yields no restore (top)', () => {
  reset();
  AppView._saveFeedScroll('cool-app', 420);
  assert.equal(AppView._getFeedScroll('other-app'), 0);
  assert.equal(AppView._getFeedScroll('cool-app'), 420);
});

test('positions stay independent across slugs', () => {
  reset();
  AppView._saveFeedScroll('app-a', 100);
  AppView._saveFeedScroll('app-b', 800);
  assert.equal(AppView._getFeedScroll('app-a'), 100);
  assert.equal(AppView._getFeedScroll('app-b'), 800);
  // Re-saving one slug leaves the other untouched.
  AppView._saveFeedScroll('app-a', 250);
  assert.equal(AppView._getFeedScroll('app-a'), 250);
  assert.equal(AppView._getFeedScroll('app-b'), 800);
});

test('a non-positive or non-finite offset clears the saved value', () => {
  reset();
  AppView._saveFeedScroll('app-a', 300);
  AppView._saveFeedScroll('app-a', 0); // back at the top → forget
  assert.equal(AppView._getFeedScroll('app-a'), 0);

  AppView._saveFeedScroll('app-b', 300);
  AppView._saveFeedScroll('app-b', -5);
  assert.equal(AppView._getFeedScroll('app-b'), 0);

  AppView._saveFeedScroll('app-c', 300);
  AppView._saveFeedScroll('app-c', NaN);
  assert.equal(AppView._getFeedScroll('app-c'), 0);
});

test('a falsy slug is a no-op (topic/session views have none to key on)', () => {
  reset();
  AppView._saveFeedScroll('', 300);
  AppView._saveFeedScroll(null, 300);
  AppView._saveFeedScroll(undefined, 300);
  assert.deepEqual(AppView._savedFeedScroll, {});
});

test('clamp leaves an in-range offset untouched', () => {
  // scrollHeight 1000, clientHeight 400 → max scrollable offset 600.
  assert.equal(AppView._clampScrollTop(250, 1000, 400), 250);
  assert.equal(AppView._clampScrollTop(600, 1000, 400), 600);
});

test('a larger saved value is clamped to scrollHeight - clientHeight', () => {
  // Shorter rebuilt list (collapsed "Show more"): saved offset exceeds
  // the new max, so it lands at the bottom of the available content.
  assert.equal(AppView._clampScrollTop(9999, 1000, 400), 600);
});

test('clamp never returns a negative offset', () => {
  // Content shorter than the viewport → no scroll room at all.
  assert.equal(AppView._clampScrollTop(500, 300, 800), 0);
  assert.equal(AppView._clampScrollTop(-50, 1000, 400), 0);
});
