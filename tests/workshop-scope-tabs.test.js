'use strict';

// The Workshop's scope chip, its three tabs and its plus (#2718).
//
// The screen answers "which of my apps wants something from me". #2718 gives
// it the shape every mini-app host in the study draws for that question: a
// chip that says what you are looking at and narrows it, the app Workshop's
// own three words one level up, and a control at the strip's trailing edge
// for the things you can start.
//
// Four things are pinned, and each is a way the screen can be quietly wrong:
//
//   1. THE THREE WORDS ARE THE APP'S OWN. Invent a second set and the two
//      screens stop reading as one place at two scopes.
//   2. A TAB THAT FILTERS TO NOTHING IS NOT AN EMPTY ACCOUNT. #workshop-empty
//      offers the directory and a declared check reads its `hidden` class, so
//      a tab with nothing in it has to say so somewhere else.
//   3. NARROWING NAVIGATES. This screen is the all-apps one; picking an app
//      is the link out, not a filter.
//   4. THE ACTION WAITS FOR THE NAVIGATION. Starting a change before the app
//      view has opened starts it on whatever app the panel last pointed at.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const CHROME = read('frontend/src/features/workshop/workshop-chrome.tsx');
const SCREEN = read('frontend/src/features/workshop/index.tsx');

const screen = loadTsx('frontend/src/features/workshop/index.tsx');
const chrome = loadTsx('frontend/src/features/workshop/workshop-chrome.tsx');

const app = (slug, working, needs) => ({ slug, name: slug, working, needs });

test('the three tabs are the app Workshop’s own three words', () => {
  assert.deepEqual(chrome.WORKSHOP_TABS.map((t) => t[0]), ['status', 'needs', 'all']);
  assert.deepEqual(chrome.WORKSHOP_TABS.map((t) => t[1]),
    ['Current status', 'Needs you', 'All items']);
  // …and they are the app's, read from its own source rather than restated.
  const board = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  for (const label of ['Current status', 'Needs you', 'All items']) {
    assert.ok(board.includes(label), `the app's Workshop still says "${label}"`);
  }
});

test('each tab asks its own question of the apps', () => {
  const rows = [app('a', 2, 0), app('b', 0, 3), app('c', 0, 0)];
  assert.deepEqual(screen.filterRows(rows, 'status').map((r) => r.slug), ['a']);
  assert.deepEqual(screen.filterRows(rows, 'needs').map((r) => r.slug), ['b']);
  assert.deepEqual(screen.filterRows(rows, 'all').map((r) => r.slug), ['a', 'b', 'c']);
});

test('Current status is where the screen opens', () => {
  // The question people arrive with is "what is in flight"; "all items" is
  // what you widen to once you have answered it. The app's own Workshop
  // opens on the same word, which is what carries across.
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.match(store, /tab: 'status',/);
});

test('a tab that filters to nothing is not an empty account', () => {
  // #workshop-empty means "you have no apps" and offers the directory; a
  // declared check reads `#workshop-empty.hidden` to prove it is gone once
  // the list has rows. A tab with nothing in it must not raise it.
  assert.match(SCREEN, /const empty = !!all && all\.length === 0 && !state\.error;/,
    'the empty card still means no apps at all');
  assert.match(SCREEN, /const filteredEmpty = !!all && all\.length > 0 && !!rows && rows\.length === 0;/,
    'and a filtered-to-nothing tab is a different state');
  assert.match(SCREEN, /id="workshop-tab-empty"/, 'with its own line');
  assert.match(SCREEN, /Nothing is in flight across your apps right now\./);
  assert.match(SCREEN, /No app is waiting on a decision from you\./);
});

test('narrowing navigates: the chip is the link out', () => {
  assert.match(CHROME, /await w\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/,
    'picking an app goes to that app’s own Workshop');
  assert.doesNotMatch(CHROME, /workshopStore\.set\(\{ scope/,
    'there is no scope to hold: this screen is the all-apps one');
  assert.match(CHROME, /disabled=\{!apps \|\| apps\.length === 0\}/,
    'and the chip says it has nothing to offer rather than opening an empty list');
});

test('the action waits for the navigation', () => {
  // navigateToApp resolves once the app view has opened and the Improve
  // controller knows what it is about. Calling startSession() before that
  // starts a change on whatever app the panel last pointed at.
  const fn = CHROME.slice(CHROME.indexOf('async function goToApp('), CHROME.indexOf('\n}\n', CHROME.indexOf('async function goToApp(')));
  const nav = fn.indexOf('await w.App?.navigateToApp');
  assert.ok(nav > 0);
  assert.ok(fn.indexOf("if (mode === 'change')") > nav, 'the change starts after the arrival');
  assert.ok(fn.indexOf("if (mode === 'issue')") > nav, 'and so does the report');
  assert.match(fn, /\} catch \{[\s\S]{0,200}return;/,
    'a navigation that failed starts nothing');
});

test('one panel, three contents, one open at a time', () => {
  // All three occupy the same place under the strip, so a single `picker`
  // field makes "opening one closes the others" true by construction rather
  // than by three effects agreeing.
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.match(store, /picker: null,/);
  assert.match(CHROME, /id="workshop-picker"/);
  assert.equal(CHROME.split('id="workshop-picker"').length - 1, 1,
    'there is exactly one panel element');
  // The plus opens on its menu and swaps THIS panel to the app list.
  assert.match(CHROME, /onClick=\{\(\) => workshopStore\.set\(\{ picker: 'change' \}\)\}/);
});

test('the strip is the shared primitive, not a second one', () => {
  assert.match(CHROME, /from '@\/components\/ui\/tabs'/);
  for (const token of ['SECTION_TABS_LIST_BASE', 'SECTION_TAB_BASE', 'SECTION_TAB_ACTIVE', 'SECTION_TAB_INACTIVE']) {
    assert.ok(CHROME.includes(token), `${token} comes from the primitive`);
  }
});

test('the chrome ships in the prerendered document', () => {
  // It renders whether or not the list has answered: a screen whose controls
  // appear after its data does is a screen that moves under the thumb
  // reaching for them.
  for (const id of ['workshop-scope', 'workshop-tabs', 'workshop-tab-status',
    'workshop-tab-needs', 'workshop-tab-all', 'workshop-plus']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is in the shipped shell`);
  }
  // …and the panels are not, because they render only once somebody taps.
  assert.ok(!HTML.includes('id="workshop-picker"'), 'the panel is not in a cold document');
});
