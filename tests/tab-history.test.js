// Back remembers the tab you were on (#3620).
//
// A project's tabs (Hub, Discussion, Needs you, Workshop) and the All items
// page under one of them had no address of their own, so changing tab wrote
// no history entry: Back skipped the tab and left the project. The same was
// true of Communities' Needs you page. `frontend/src/lib/tab-history.ts`
// records each tab change as a same-address entry carrying the tab in its
// state; the screens read it back on a traversal.
//
// Run with: node --test tests/tab-history.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const {
  PAGE_TAB_KEY, readPageTab, currentPageTab, pageTabMatches,
  pushPageTab, replacePageTab, stampPageTab, backWithinTabs,
} = loadTsx('frontend/src/lib/tab-history.ts');

/** A history that keeps its entries, so push, replace and back are visible. */
function browser(startState) {
  const entries = [startState === undefined ? null : startState];
  let at = 0;
  let backs = 0;
  const win = {
    history: {
      get state() { return entries[at]; },
      pushState(state) { entries.splice(at + 1); entries.push(state); at = entries.length - 1; },
      replaceState(state) { entries[at] = state; },
      back() { backs += 1; at = Math.max(0, at - 1); },
    },
  };
  return {
    win,
    entries,
    backs: () => backs,
    install() { global.window = win; },
  };
}

function withBrowser(startState, fn) {
  const b = browser(startState);
  b.install();
  try { return fn(b); } finally { delete global.window; }
}

test('a tab change is a record at the same address, carrying the tab and the one it came from', () => {
  withBrowser(undefined, ({ entries }) => {
    pushPageTab({ scope: 'project', slug: 'garden', tab: 'workshop', from: 'status' });
    assert.equal(entries.length, 2, 'a new entry');
    assert.deepEqual(entries[1][PAGE_TAB_KEY], { scope: 'project', slug: 'garden', tab: 'workshop', from: 'status' });
    pushPageTab({ scope: 'project', slug: 'garden', tab: 'all', from: 'workshop' });
    assert.equal(entries.length, 3);
    assert.deepEqual(currentPageTab(), { scope: 'project', slug: 'garden', tab: 'all', from: 'workshop' },
      'the entry the page stands on answers');
  });
});

test('a replace swaps the tab without adding a step, and a stamp leaves an existing marker alone', () => {
  withBrowser(undefined, ({ entries }) => {
    stampPageTab({ scope: 'project', slug: 'garden', tab: 'status', from: null });
    assert.equal(entries.length, 1, 'stamping adds nothing');
    assert.equal(currentPageTab().tab, 'status');
    stampPageTab({ scope: 'project', slug: 'garden', tab: 'workshop', from: null });
    assert.equal(currentPageTab().tab, 'status', 'an entry that has this page\'s marker keeps its own position');
    replacePageTab({ scope: 'project', slug: 'garden', tab: 'needs', from: 'status' });
    assert.equal(entries.length, 1, 'replace is not a step');
    assert.deepEqual(currentPageTab(), { scope: 'project', slug: 'garden', tab: 'needs', from: 'status' });
    // A marker for another project (the same node reused after a navigation
    // the browser did not give a fresh state) is replaced, not kept.
    replacePageTab({ scope: 'project', slug: 'other', tab: 'workshop', from: null });
    stampPageTab({ scope: 'project', slug: 'garden', tab: 'status', from: null });
    assert.equal(currentPageTab().slug, 'garden');
    assert.equal(currentPageTab().tab, 'status');
  });
});

test('the marker merges the entry\'s state and leaves the back stack\'s keys behind', () => {
  withBrowser({ feature: 'kept', __unDismissDepth: 2, __unDismissId: 'dialog:3' }, ({ entries }) => {
    pushPageTab({ scope: 'communities', slug: null, tab: 'needs', from: 'status' });
    assert.equal(entries[1].feature, 'kept', 'the entry\'s own state survives');
    assert.ok(!('__unDismissDepth' in entries[1]), 'a tab record is not a dialog record');
    assert.ok(!('__unDismissId' in entries[1]));
    assert.deepEqual(entries[1][PAGE_TAB_KEY], { scope: 'communities', slug: null, tab: 'needs', from: 'status' });
  });
});

test('reads ignore a wrong scope, an unknown tab and a state that is not a marker', () => {
  assert.equal(readPageTab({}), null);
  assert.equal(readPageTab(null), null);
  assert.equal(readPageTab('x'), null);
  assert.equal(readPageTab({ [PAGE_TAB_KEY]: { scope: 'elsewhere', tab: 'status' } }), null);
  assert.equal(readPageTab({ [PAGE_TAB_KEY]: { scope: 'project', tab: '' } }), null);
  assert.equal(readPageTab({ [PAGE_TAB_KEY]: { scope: 'project', slug: 7, tab: 'status' } }), null);
  const project = { scope: 'project', slug: 'garden', tab: 'workshop', from: 'status' };
  assert.equal(pageTabMatches(project, 'project', 'garden'), true);
  assert.equal(pageTabMatches(project, 'project', 'other'), false, 'another project\'s marker is ignored');
  assert.equal(pageTabMatches(project, 'project', null), false);
  assert.equal(pageTabMatches(project, 'communities', null), false, 'a wrong scope is ignored');
  assert.equal(pageTabMatches({ scope: 'communities', slug: null, tab: 'needs', from: 'status' }, 'communities', null), true);
});

test('a page\'s own back disc is a Back step only when the parent is the entry below', () => {
  withBrowser(undefined, ({ entries, backs }) => {
    stampPageTab({ scope: 'project', slug: 'garden', tab: 'status', from: null });
    pushPageTab({ scope: 'project', slug: 'garden', tab: 'workshop', from: 'status' });
    pushPageTab({ scope: 'project', slug: 'garden', tab: 'all', from: 'workshop' });
    // A parent the entry did not come from, another project, another scope:
    // the disc opens the Workshop itself instead of walking the history.
    assert.equal(backWithinTabs('project', 'garden', 'status'), false);
    assert.equal(backWithinTabs('project', 'other', 'workshop'), false);
    assert.equal(backWithinTabs('communities', null, 'workshop'), false);
    assert.equal(backs(), 0);
    assert.equal(backWithinTabs('project', 'garden', 'workshop'), true, 'All items goes back to the Workshop');
    assert.equal(backs(), 1);
    assert.equal(entries.length, 3, 'and adds no step of its own');
    // Landed on the Workshop entry, which came from the hub.
    assert.equal(backWithinTabs('project', 'garden', 'workshop'), false, 'never twice from the same entry');
    assert.equal(backWithinTabs('project', 'garden', 'status'), true, 'and the Workshop\'s parent is the hub');
  });
});

test('a Communities tab change is the same record, and finishing the feed is a replace', () => {
  withBrowser(undefined, ({ entries }) => {
    stampPageTab({ scope: 'communities', slug: null, tab: 'status', from: null });
    pushPageTab({ scope: 'communities', slug: null, tab: 'needs', from: 'status' });
    assert.equal(entries.length, 2);
    assert.equal(backWithinTabs('communities', null, 'status'), true, 'the feed\'s disc goes back to the list');
  });
  withBrowser(undefined, ({ entries }) => {
    stampPageTab({ scope: 'communities', slug: null, tab: 'status', from: null });
    pushPageTab({ scope: 'communities', slug: null, tab: 'needs', from: 'status' });
    replacePageTab({ scope: 'communities', slug: null, tab: 'status', from: 'needs' });
    assert.equal(entries.length, 2, 'finishing the queue leaves no entry to come back to');
    assert.equal(currentPageTab().tab, 'status');
  });
});

test('nothing throws where there is no window (the prerender pass)', () => {
  delete global.window;
  assert.equal(currentPageTab(), null);
  assert.doesNotThrow(() => pushPageTab({ scope: 'project', slug: 'garden', tab: 'workshop', from: 'status' }));
  assert.doesNotThrow(() => stampPageTab({ scope: 'communities', slug: null, tab: 'needs', from: 'status' }));
  assert.equal(backWithinTabs('project', 'garden', 'status'), false);
});
