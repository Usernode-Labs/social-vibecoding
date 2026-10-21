'use strict';

// #3620: tab changes and in-page pages are history steps.
//
// A project's tabs and the Communities screen's Needs you page change what
// the page shows without changing its address, so they used to be invisible
// to the browser's Back button: Back left the page instead of returning to
// the tab you came from. They now push one record at the same address, tagged
// in `history.state` with the level it opened; Back and Forward read that tag
// and reopen it.
//
// Run with: node --test tests/page-back-steps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const AppView = require('../public/js/app-view.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const SCREEN = read('frontend/src/features/workshop/index.tsx');
const SWITCHER = read('frontend/src/features/workshop/community-switcher.tsx');

function withWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  globalThis.window = win;
  try { return fn(); } finally {
    if (had) globalThis.window = was;
    else delete globalThis.window;
  }
}

/** A history that records every write, and runs `back()` at once. */
function fakeHistory(state = null) {
  const entries = [state];
  let at = 0;
  const calls = [];
  return {
    get state() { return entries[at]; },
    pushState(next, title, url) {
      entries.splice(at + 1);
      entries.push(next);
      at = entries.length - 1;
      calls.push({ kind: 'push', state: next, url });
    },
    replaceState(next, title, url) {
      entries[at] = next;
      calls.push({ kind: 'replace', state: next, url });
    },
    back() {
      calls.push({ kind: 'back' });
      if (at > 0) at -= 1;
    },
    get index() { return at; },
    entries,
    calls,
  };
}

test('a tab press pushes one record at the same address, tagged with its tab', () => {
  const history = fakeHistory({ __unDismissDepth: 1 });
  withWindow({ history }, () => {
    AppView._pushWorkshopTabEntry('workshop');
    const pushes = history.calls.filter((c) => c.kind === 'push');
    assert.equal(pushes.length, 1, 'exactly one step');
    assert.equal(pushes[0].url, undefined, 'the address does not move');
    assert.deepEqual(pushes[0].state.__unWorkshopTab, { key: 'workshop', pushed: true });
    assert.equal(pushes[0].state.__unDismissDepth, 1,
      'the back stack\'s own keys ride along');
  });
});

test('re-tagging an entry keeps whether a press owns it', () => {
  const pushed = fakeHistory();
  withWindow({ history: pushed }, () => {
    AppView._pushWorkshopTabEntry('all');
    AppView._noteWorkshopTabEntry('workshop');
    assert.deepEqual(pushed.state.__unWorkshopTab, { key: 'workshop', pushed: true },
      'a door or a lit-tab press does not hand the step away');
  });
  const initial = fakeHistory();
  withWindow({ history: initial }, () => {
    AppView._noteWorkshopTabEntry('status');
    assert.deepEqual(initial.state.__unWorkshopTab, { key: 'status', pushed: false },
      'an entry the page landed on owns no step');
    assert.equal(initial.calls.filter((c) => c.kind === 'push').length, 0,
      'tagging in place never adds a step');
  });
});

test('All items spends a step only when a press opened it', () => {
  const bookmark = fakeHistory();
  withWindow({ history: bookmark }, () => {
    AppView._noteWorkshopTabEntry('all');
    assert.equal(AppView._spendWorkshopTabEntry(), false,
      'a ?ws=all bookmark has no step to spend');
    assert.equal(bookmark.calls.filter((c) => c.kind === 'back').length, 0);
  });
  const press = fakeHistory();
  withWindow({ history: press }, () => {
    AppView._pushWorkshopTabEntry('all');
    assert.equal(AppView._spendWorkshopTabEntry(), true);
    assert.equal(press.calls.filter((c) => c.kind === 'back').length, 1);
    assert.equal(press.index, 0, 'and the traversal has left the pushed entry');
  });
});

test('the page opens on the landing entry\'s tab first, then ?ws=, then the remembered tab', () => {
  const win = (search, state, stored) => ({
    history: fakeHistory(state),
    location: { search },
    localStorage: { getItem: () => stored },
  });
  withWindow(win('?ws=needs', { __unWorkshopTab: { key: 'discussion', pushed: true } }, 'workshop'), () => {
    AppView._workshopTabUrlOverride = undefined;
    assert.equal(AppView._workshopTab(), 'discussion',
      'Back and Forward reopen the tab their entry showed, ahead of a stale deep link');
  });
  withWindow(win('?ws=needs', null, 'workshop'), () => {
    AppView._workshopTabUrlOverride = undefined;
    assert.equal(AppView._workshopTab(), 'needs', 'then the deep link');
  });
  withWindow(win('', null, 'workshop'), () => {
    AppView._workshopTabUrlOverride = undefined;
    assert.equal(AppView._workshopTab(), 'workshop', 'then what you last chose');
  });
  withWindow(win('', null, null), () => {
    AppView._workshopTabUrlOverride = undefined;
    assert.equal(AppView._workshopTab(), 'status', 'then the hub');
  });
});

test('a project tab press is a step, a lit-tab press is not, and the page reads it back', () => {
  const openTab = /const openTab = \(next: TabKey\) => \{([\s\S]*?)\n  \};/.exec(WORKSHOP);
  assert.ok(openTab, 'openTab exists');
  assert.match(openTab[1], /if \(next === tab\) \{[\s\S]*?_noteWorkshopTabEntry', next\)/,
    'the lit tab adds no step');
  assert.match(openTab[1], /else \{[\s\S]*?_noteWorkshopTabEntry', tab\);[\s\S]*?_pushWorkshopTabEntry', next\)/,
    'a different tab tags the entry it leaves and pushes one for itself');

  const door = WORKSHOP.slice(WORKSHOP.indexOf('const onDoor = (event: Event) => {'));
  const doorBody = door.slice(0, door.indexOf('\n    };'));
  assert.match(doorBody, /_pushWorkshopTabEntry', door\.tab\)/,
    'a door pressed on the open page takes the same step');

  const pop = WORKSHOP.slice(WORKSHOP.indexOf('const onPop = () => {'));
  const popBody = pop.slice(0, pop.indexOf('\n    };'));
  assert.match(popBody, /callAppView\('_workshopTabEntry'\)/);
  assert.match(popBody, /setTab\(entry\.key\)/);
  assert.match(popBody, /callAppView\('_setWorkshopTab', entry\.key\)/);
  assert.match(WORKSHOP, /window\.addEventListener\('popstate', onPop\)/);
});

test('the Communities feed opens as a step, and Back spends it', () => {
  const screen = loadTsx('frontend/src/features/workshop/index.tsx');
  const history = fakeHistory();
  withWindow({ history }, () => {
    screen.workshopStore.set({ open: true, tab: 'status' });
    screen.workshopController.openNeeds();
    assert.equal(screen.workshopStore.get().tab, 'needs');
    const pushes = () => history.calls.filter((c) => c.kind === 'push');
    assert.equal(pushes().length, 1, 'one step');
    assert.equal(pushes()[0].url, undefined, 'at the same address');
    assert.equal(pushes()[0].state.__unWorkshopNeeds, true, 'tagged as the feed');

    screen.workshopController.openNeeds();
    assert.equal(pushes().length, 1, 'already showing: no second step');

    screen.workshopController.closeNeeds();
    assert.equal(history.calls.filter((c) => c.kind === 'back').length, 1,
      'the record the row pushed is spent');
    assert.ok(!history.state || history.state.__unWorkshopNeeds !== true,
      'and Back now leaves the screen');
  });
});

test('a ?ws=needs feed with no record of its own returns in place', () => {
  const screen = loadTsx('frontend/src/features/workshop/index.tsx');
  const history = fakeHistory();
  withWindow({ history }, () => {
    screen.workshopStore.set({ open: true, tab: 'needs' });
    screen.workshopController.closeNeeds();
    assert.equal(history.calls.filter((c) => c.kind === 'back').length, 0);
    assert.equal(screen.workshopStore.get().tab, 'status');
  });
});

test('the Needs you row, its back disc and its Done all use the step-aware controller', () => {
  assert.match(SCREEN, /onClick=\{\(\) => workshopController\.openNeeds\(\)\}/);
  assert.match(SCREEN, /onClick=\{\(\) => workshopController\.closeNeeds\(\)\}/);
  assert.match(SCREEN, /onDone=\{\(\) => workshopController\.closeNeeds\(\)\}/);
  // The traversal back onto the feed's record reopens it; one without the
  // marker puts the list back, while this screen is the one on show.
  assert.match(SCREEN, /if \(needsEntry\(\)\) workshopController\.setTab\('needs'\);/);
  assert.match(SCREEN, /else if \(workshopStore\.get\(\)\.tab === 'needs'\) workshopController\.setTab\('status'\);/);
  assert.match(SCREEN, /if \(!app \|\| !app\._inWorkshop \|\| app\.currentApp\) return;/);
});

test('Your communities claims one Back press while it is open', () => {
  assert.match(SWITCHER, /import \{ pushDismissible \} from '\.\.\/\.\.\/lib\/back-stack';/);
  assert.match(SWITCHER, /if \(!st\.switcher\) return undefined;\s*const release = pushDismissible\(\(\) => \{ closeSwitcher\(\); \}\);/,
    'the menu owns the next press');
  assert.match(SWITCHER, /return \(\) => release\(\{ navigating: true \}\);/,
    'any other close leaves its record under a navigation rather than spending it');
});
