'use strict';

// #3620: BACK UNDOES A TAB SWITCH ON A PROJECT PAGE.
//
// A tab press on a project page (Hub, Discussion, Needs you, Workshop, All
// items) is a reading position, not a route: the address stays
// `/app/<slug>/workshop` and only the strip moves, so browser/device back
// left the page entirely instead of undoing the switch. Pinned here:
//
//   1. A PRESS RECORDS. AppView._pushWorkshopTabRecord tags the entry the
//      page stands on with the tab being left (once — an entry already
//      carrying one of ours keeps it, and one carrying the dismiss stack's
//      marker keeps ITS claim) and pushes a same-address record carrying the
//      tab entered, counted in App._historyPushes like any push.
//   2. THE LIT TAB RECORDS NOTHING (it only scrolls to its head), and the
//      embedded side panel (?panel=1) records nothing — a frame never writes
//      the top window's history, the rule back-stack.ts keeps.
//   3. A TRAVERSAL APPLIES ITS RECORD. App._applyWorkshopTabRecord —
//      registered after the router's own popstate listener — moves the strip
//      through AppView._landOnTab, but only for the page the record was
//      written for, on the one view whose band exists (dev forum).
//   4. THE PAGES' OWN WAY BACK SPENDS THEIR RECORD. All items' chevron and
//      the Needs-you closing button ask AppView._spendWorkshopTabRecord and
//      let history move when it answers true; with no record (a `?ws=` deep
//      link landed straight on the page) they press, which records like any
//      tap.
//
// Run with: node --test tests/workshop-tab-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const APPVIEW = read('public/js/app-view.js');
const APP_JS = read('public/js/app.js');

// An object-literal method lifted out of one of the legacy modules and
// evaluated with the globals it reads supplied in their places, so the
// helper runs against a fake history rather than being grepped.
function method(src, name, globals) {
  const start = src.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  let end = start;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const g = globals || {};
  const make = new Function('App', 'window', 'AppView', `return ({ ${src.slice(start + 1, end)} });`);
  return make(g.App || null, g.window || null, g.AppView || null)[name];
}

// A fake history whose entries are the bare minimum the helpers touch.
function fakeHistory(initialState) {
  let entries = [{ state: initialState === undefined ? null : initialState }];
  let index = 0;
  const writes = [];
  const win = {
    history: {
      get state() { return entries[index].state; },
      replaceState(state) { entries[index].state = state; writes.push(['replace', state]); },
      pushState(state) { entries = entries.slice(0, index + 1); entries.push({ state }); index += 1; writes.push(['push', state]); },
      back() { if (index > 0) index -= 1; writes.push(['back', null]); },
    },
  };
  return { win, entries: () => entries, writes };
}

const fakeApp = (overrides) => ({
  embeddedPanel: false, _historyPushes: 0,
  currentApp: 'garden', currentTab: 'dev', currentSubTab: 'forum',
  ...overrides,
});
const TABS = ['status', 'discussion', 'workshop', 'needs', 'all'];

test('a press tags the standing entry and pushes a record with the tab entered', () => {
  const { win, entries, writes } = fakeHistory(null);
  const App = fakeApp();
  method(APPVIEW, '_pushWorkshopTabRecord', { App, window: win })('garden', 'status', 'workshop');
  assert.deepEqual(entries()[0].state, { __unWsTab: 'status', __unWsSlug: 'garden' }, 'the landing carries the tab it was left on');
  assert.deepEqual(entries()[1].state, { __unWsTab: 'workshop', __unWsSlug: 'garden' }, 'the record carries the tab entered');
  assert.equal(App._historyPushes, 1, 'the record counts as a push');
  assert.deepEqual(writes.map((w) => w[0]), ['replace', 'push']);
});

test('an entry already carrying a tag or a dismiss marker is never re-tagged', () => {
  const tagged = fakeHistory({ __unWsTab: 'status', __unWsSlug: 'garden' });
  method(APPVIEW, '_pushWorkshopTabRecord', { App: fakeApp(), window: tagged.win })('garden', 'status', 'workshop');
  assert.deepEqual(tagged.entries()[0].state, { __unWsTab: 'status', __unWsSlug: 'garden' }, 'our own tag is kept, not overwritten');
  assert.ok(!tagged.writes.some((w) => w[0] === 'replace'));

  const claimed = fakeHistory({ __unDismissDepth: 2, __unDismissId: 'abc:1' });
  method(APPVIEW, '_pushWorkshopTabRecord', { App: fakeApp(), window: claimed.win })('garden', 'status', 'workshop');
  assert.deepEqual(claimed.entries()[0].state, { __unDismissDepth: 2, __unDismissId: 'abc:1' }, 'the dismiss stack keeps its claim');
  assert.ok(!claimed.writes.some((w) => w[0] === 'replace'), 'no replace over a dialog record');
  assert.ok(claimed.writes.some((w) => w[0] === 'push'), 'the press still records');
});

test('the embedded side panel records nothing, and a lit tab records nothing', () => {
  const { win, writes } = fakeHistory(null);
  method(APPVIEW, '_pushWorkshopTabRecord', { App: fakeApp({ embeddedPanel: true }), window: win })('garden', 'status', 'workshop');
  assert.deepEqual(writes, []);
  // The guard lives in the caller: only a press to a DIFFERENT tab records.
  const openTab = WORKSHOP.match(/const openTab = \(next: TabKey\) => \{[\s\S]*?\n  \};/);
  assert.ok(openTab, 'openTab exists');
  assert.match(openTab[0], /if \(next !== tab\) callAppView\('_pushWorkshopTabRecord', v\.slug, tab, next\);/);
});

test('the pages\' own way back spends their record, else presses', () => {
  const onRecord = fakeHistory({ __unWsTab: 'all', __unWsSlug: 'garden' });
  assert.equal(method(APPVIEW, '_spendWorkshopTabRecord', { App: fakeApp(), window: onRecord.win })('garden'), true);
  assert.ok(onRecord.writes.some((w) => w[0] === 'back'));

  const untagged = fakeHistory(null);
  assert.equal(method(APPVIEW, '_spendWorkshopTabRecord', { App: fakeApp(), window: untagged.win })('garden'), false);
  assert.deepEqual(untagged.writes, []);

  const otherPage = fakeHistory({ __unWsTab: 'all', __unWsSlug: 'notebook' });
  assert.equal(method(APPVIEW, '_spendWorkshopTabRecord', { App: fakeApp(), window: otherPage.win })('garden'), false);
  assert.deepEqual(otherPage.writes, []);

  const panel = fakeHistory({ __unWsTab: 'all', __unWsSlug: 'garden' });
  assert.equal(method(APPVIEW, '_spendWorkshopTabRecord', { App: fakeApp({ embeddedPanel: true }), window: panel.win })('garden'), false);
  assert.deepEqual(panel.writes, []);

  const helper = WORKSHOP.match(/const backOutOfPage = \(parent: TabKey\) => \{[\s\S]*?\n  \};/);
  assert.ok(helper, 'the return helper exists');
  assert.match(helper[0], /callAppView\('_spendWorkshopTabRecord', v\.slug\)/);
  assert.match(helper[0], /openTab\(parent\)/, 'with no record it presses, which records like any tap');
  assert.match(WORKSHOP, /onBack=\{\(\) => backOutOfPage\(pageParent\(tab\)\)\}/, 'All items\' chevron');
  assert.match(WORKSHOP, /onDone=\{\(\) => backOutOfPage\('status'\)\}/, 'the Needs-you closing button');
});

test('a traversal applies its record only for the current page on the dev forum view', () => {
  const apply = (overrides, state) => {
    const calls = [];
    const AppView = { WORKSHOP_TABS: TABS, _landOnTab: (...args) => calls.push(args) };
    method(APP_JS, '_applyWorkshopTabRecord', {
      App: fakeApp(overrides),
      window: { history: { state } },
      AppView,
    })();
    return calls;
  };
  const record = { __unWsTab: 'needs', __unWsSlug: 'garden' };

  assert.deepEqual(apply({}, record), [['garden', 'needs']], 'the strip moves through _landOnTab');
  assert.deepEqual(apply({ currentApp: 'notebook' }, record), [], 'not on another page');
  assert.deepEqual(apply({ currentTab: 'home' }, record), [], 'not off the page');
  assert.deepEqual(apply({ currentTab: 'dev', currentSubTab: 'sessions' }, record), [], 'the band only exists on the forum view');
  assert.deepEqual(apply({ embeddedPanel: true }, record), [], 'never in the side panel');
  assert.deepEqual(apply({}, { __unWsTab: 'nope', __unWsSlug: 'garden' }), [], 'not for a key no band has');
  assert.deepEqual(apply({}, null), [], 'an ordinary entry carries no record');
  assert.deepEqual(apply({}, { __unWsSlug: 'garden' }), [], 'a tag without a tab is not ours');
});

test('the record listener is registered after the router\'s own popstate listener', () => {
  const wiring = APP_JS.match(/window\.addEventListener\('popstate'[\s\S]*?_applyWorkshopTabRecord\(\)\);/);
  assert.ok(wiring, 'registered');
  assert.ok(wiring[0].indexOf("() => App._routeFromHash()") < wiring[0].indexOf("() => App._applyWorkshopTabRecord()"),
    'after _routeFromHash, so currentApp and the sub-tab are settled first');
});