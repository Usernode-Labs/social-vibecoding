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
  // SECTION_TAB_BASE is deliberately absent: this strip spells its trigger
  // class out (see below). The track and the two state tables are still the
  // primitive's.
  for (const token of ['SECTION_TABS_LIST_BASE', 'SECTION_TAB_ACTIVE', 'SECTION_TAB_INACTIVE']) {
    assert.ok(CHROME.includes(token), `${token} comes from the primitive`);
  }
});

test('the three labels fit a phone row, and the strip cannot hide one', () => {
  // THE BUG THIS PINS. At 390pt the three labels needed 370px of track and
  // the row gave them 314, so "All items" was cut off mid-word by a scroller
  // `platform-no-scrollbar` had made invisible — reachable only by a drag
  // nothing on screen suggested. Measured in a real browser, not inferred.
  //
  // The labels themselves may not give: they are the app Workshop's own three
  // words, which is why the two screens read as one place at two scopes.
  assert.deepEqual(
    CHROME.match(/'(Current status|Needs you|All items)'/g),
    ["'Current status'", "'Needs you'", "'All items'"],
    'the three words are the app Workshop\'s, unabbreviated',
  );

  // 1. The plus is off this row — it is on the scope chip's line now.
  assert.match(CHROME, /export function WorkshopPlus\(/);
  // Bounded to the function: everything after it is the picker, whose rows
  // legitimately carry `shrink-0` on their glyphs.
  const tabsAt = CHROME.indexOf('export function WorkshopTabs(');
  const tabsFn = CHROME.slice(tabsAt, CHROME.indexOf('\n}', CHROME.indexOf('</Tabs>', tabsAt)));
  assert.ok(!tabsFn.includes('id="workshop-plus"'),
    'the plus does not share the tab row any more');
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /<WorkshopScope[\s\S]{0,200}<WorkshopPlus/,
    'it renders beside the scope chip instead');

  // 2 and 3. Tighter padding and a 13px label — the size the app's own
  // Workshop already concluded these words need on a phone (it draws them at
  // ELEVEN, with a glyph above; `.dev-ws-tab` in app.css).
  assert.match(CHROME, /const WORKSHOP_TAB_CLASS =\n\s+'inline-flex items-center justify-center h-8 px-2\.5 rounded-full text-\[13px\] '/);
  assert.match(CHROME, /\+ 'font-semibold transition-colors min-w-0';/);

  // THE FLOOR: truncate, never hide. `shrink-0` inside a scroller was what
  // turned "does not fit" into "is silently cut" — flex had no permission to
  // do anything but overflow.
  assert.ok(!tabsFn.includes('overflow-x-auto'), 'there is no scroller to hide a tab behind');
  assert.ok(!tabsFn.includes('platform-no-scrollbar'), 'nor a hidden scrollbar');
  assert.ok(!tabsFn.includes("shrink-0"), 'the triggers may shrink');
  assert.match(tabsFn, /<span className="min-w-0 truncate">\{label\}<\/span>/,
    'and their labels ellipsize rather than disappear');

  // The class is a COMPLETE LITERAL, never derived. Tailwind's extractor is a
  // regex over source text, so a computed class name is one that never gets
  // compiled — and it fails silently, with the attribute right in the DOM.
  // Comments stripped first: the note above WORKSHOP_TAB_CLASS says the word
  // `.replace()` in order to warn against it, which is prose, not code.
  const code = CHROME.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('.replace('), 'no class name is computed at runtime');
});

test('the legend carries the totals, and says nothing when there is nothing', () => {
  // The design study put three count cards at the top of this screen. The
  // question they answer is real — the rows say which APPS need you, and
  // nothing said how much there is altogether — but a deck above a list whose
  // every row carries the same two figures is the third telling of one fact,
  // so the numbers went into the legend that already names the two glyphs.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /id="workshop-total-working"/);
  assert.match(screen, /id="workshop-total-needs"/);
  // ACROSS EVERY APP, not the filtered tab: "how much is there" is not a
  // question whose answer should move when you change tabs.
  const at = screen.indexOf('const totals = all');
  const decl = screen.slice(at, screen.indexOf('const empty', at));
  assert.match(decl, /all\.length > 0/,
    'no totals with no apps — the empty card already says why the screen is bare');
  assert.match(decl, /acc\.working \+ \(row\.working \|\| 0\)/);
  assert.match(decl, /acc\.needs \+ \(row\.needs \|\| 0\)/);
  assert.ok(!decl.includes('rows'), 'it sums `all`, not the tab-filtered rows');
  // THE WORDS ARE NOT THE NUMBER'S TO CHANGE, which is the whole reason this
  // assertion exists in this shape. The totals first shipped as "2 working
  // on" / "3 waiting on your vote" — a rewording on the way past — and a
  // declared check pins the phrase "Votes waiting on you" on this screen, so
  // it went red on the platform's own run. The number is additive now: the
  // legend says what it always said and gains a figure at the end.
  assert.match(screen, /You are working on\n\s+\{totals \? <b id="workshop-total-working"/);
  assert.match(screen, /Votes waiting on you\n\s+\{totals \? <b id="workshop-total-needs"/);
  const dapp = JSON.parse(read('dapp.json'));
  const pinned = dapp.tests.find((t) => t.expectText === 'Votes waiting on you');
  assert.ok(pinned, 'the phrase is still a declared check\'s expectText');
  assert.ok(read('public/index.html').includes('Votes waiting on you'),
    'and the cold document still carries it, with no figure to wait for');
  assert.ok(!HTML.includes('id="workshop-total-working"'),
    'a figure read from data is not in a cold document');
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
