'use strict';

// #6233: a Live change this tab's build is older than says "Live · reload to
// get it", with a Reload beside it. The comparison is the change's merge
// order against the merge boundary of the build the tab loaded, which
// /api/version answers for ?have=<build sha>.
//
// Run with: node --test tests/tab-build.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SOURCE = 'frontend/src/lib/tab-build.ts';

function load() {
  // The store is real; the React hook is stubbed, since this test is about
  // the comparison, not a render.
  return loadTsx(SOURCE, { stubs: { './use-store-state': { useStoreState: () => null } } });
}

const STATE = {
  loadedSha: 'a'.repeat(40),
  runningSha: 'b'.repeat(40),
  haveThrough: { at: '2026-11-03T10:00:00.000Z', id: 10 },
  selfAppSlug: 'usernode',
};

test('a tab on the running build never lacks a change', () => {
  const { tabLacks } = load();
  const change = { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T11:00:00Z', id: 11, appSlug: 'usernode' };
  assert.equal(tabLacks(change, { ...STATE, loadedSha: STATE.runningSha }), false);
  assert.equal(tabLacks(change, { ...STATE, loadedSha: null }), false);
});

test('a change merged after the build that loaded has the reload wording', () => {
  const { tabLacks } = load();
  assert.equal(tabLacks(
    { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T11:00:00Z', id: 11, appSlug: 'usernode' }, STATE), true);
  // The same order, a lower id: the build does not contain it either only
  // when the boundary is the same merge.
  assert.equal(tabLacks(
    { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T10:00:00Z', id: 11, appSlug: 'usernode' }, STATE), true);
});

test('a change the loaded build carries, or an unknown boundary, shows plain Live', () => {
  const { tabLacks } = load();
  assert.equal(tabLacks(
    { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T09:00:00Z', id: 9, appSlug: 'usernode' }, STATE), false);
  assert.equal(tabLacks(
    { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T10:00:00Z', id: 10, appSlug: 'usernode' }, STATE), false);
  assert.equal(tabLacks(
    { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T11:00:00Z', id: 11, appSlug: 'usernode' },
    { ...STATE, haveThrough: null }), false);
  assert.equal(tabLacks(
    { liveAt: '2026-11-03T12:00:00Z', mergedAt: null, id: 11, appSlug: 'usernode' }, STATE), false);
});

test('a child app, a change not live, and a project somebody else made are never "lacking"', () => {
  const { tabLacks } = load();
  const live = { liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T11:00:00Z', id: 11 };
  assert.equal(tabLacks({ ...live, selfHosted: false, appSlug: 'usernode' }, STATE), false);
  assert.equal(tabLacks({ ...live, liveAt: null, appSlug: 'usernode' }, STATE), false);
  assert.equal(tabLacks({ ...live, appSlug: 'another-project' }, STATE), false);
});

test('publishing an answer normalizes the boundary and keeps the loaded build', () => {
  const { publish, tabBuildStore, tabLacks } = load();
  publish({ sha: 'b'.repeat(40), selfAppSlug: 'usernode',
    haveThrough: { at: '2026-11-03T10:00:00Z', id: 10 } }, 'a'.repeat(40));
  assert.deepEqual(tabBuildStore.get(), {
    loadedSha: 'a'.repeat(40), runningSha: 'b'.repeat(40),
    haveThrough: { at: '2026-11-03T10:00:00.000Z', id: 10 }, selfAppSlug: 'usernode',
  });
  assert.equal(tabLacks({ liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T11:00:00Z', id: 11 }), true);
  // A build stamped 'dev' (a checkout) has nothing to compare.
  publish({ sha: 'dev' }, 'a'.repeat(40));
  assert.equal(tabLacks({ liveAt: '2026-11-03T12:00:00Z', mergedAt: '2026-11-03T11:00:00Z', id: 11 }), false);
});

test('the words a stale tab shows are catalog entries, and the pill offers Reload', () => {
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  const project = JSON.parse(read('frontend/locales/en/project.json'));
  const messages = JSON.parse(read('frontend/locales/en/messages.json'));
  for (const [catalog, key, text] of [
    [changes, 'badge.pill.liveReload', '✓ Live · reload to get it'],
    [changes, 'page.votes.note.liveReload', 'It’s live. Reload to get it in this tab.'],
    [project, 'change.reload', 'Reload'],
    [messages, 'ai.live.olderTab', 'This tab is on an older Homeroom.'],
    [messages, 'ai.short.reload', 'Reload'],
  ]) {
    assert.equal(catalog[key] && catalog[key].text, text, key);
    assert.ok(catalog[key].description, key);
  }
  // The pill says so, and the change's line offers the same reload as the
  // side menu.
  assert.match(read('public/js/app-view.js'), /changes:badge\.pill\.liveReload/);
  assert.match(read('frontend/src/features/dev-board/topic/thread-changes.tsx'), /data-thread-change-reload/);
  assert.match(read('frontend/src/features/ai/lists.tsx'), /data-ai-older-tab/);
});
