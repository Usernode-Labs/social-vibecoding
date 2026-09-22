'use strict';

// The Workshop's scope chip and its totals (#2718).
//
// The screen answers "which of my apps wants something from me": a chip that
// says what you are looking at and narrows it, a legend that totals what is
// owed, and one row per app carrying both of its numbers.
//
// ── What this suite used to pin, and why it does not ──────────────────
//
// A TAB STRIP (Current status / Needs you / All items) and a PLUS. Both are
// retired from this screen on the owner's review, and the reason is worth
// keeping because it is the argument that would bring them back: those three
// words are the APP Workshop's, about one app's items. Up here the list is of
// APPS, each row already showing both figures, so the tabs hid whole apps to
// say what their rows were saying anyway — and the plus asked "which app?"
// before two questions ("propose a change", "report a problem") that can only
// be asked inside an app.
//
// Three things are still pinned, and each is a way the screen can be quietly
// wrong:
//
//   1. NARROWING NAVIGATES. This screen is the all-apps one; picking an app
//      is the link out, not a filter.
//   2. THE NAVIGATION IS AWAITED, so a refused one cannot read as a
//      completed one.
//   3. THE TOTALS DO NOT REWORD THE LEGEND. A declared check pins the phrase
//      "Votes waiting on you" on this screen.

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

test('narrowing navigates: the chip is the link out', () => {
  assert.match(CHROME, /await win\(\)\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/,
    'picking an app goes to that app’s own Workshop');
  assert.doesNotMatch(CHROME, /workshopStore\.set\(\{ scope/,
    'there is no scope to hold: this screen is the all-apps one');
  assert.match(CHROME, /disabled=\{!apps \|\| apps\.length === 0\}/,
    'and the chip says it has nothing to offer rather than opening an empty list');
});

test('the action waits for the navigation', () => {
  // It MATTERED more when the plus's two action rows landed here:
  // navigateToApp resolves once the app view has opened and the Improve
  // controller knows what it is about, and calling startSession() before that
  // started a change on whatever app the panel last pointed at. The scope
  // chip is the only caller left, so nothing runs after the await — the await
  // stays so a refused navigation cannot read as a completed one, and the
  // panel closes either way.
  const at = CHROME.indexOf('async function goToApp(');
  const fn = CHROME.slice(at, CHROME.indexOf('\n}\n', at));
  assert.match(fn, /await win\(\)\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.match(fn, /\} catch \{/, 'and a refusal is caught rather than thrown at the screen');
  assert.ok(!fn.includes('startSession'), 'nothing is started from this screen any more');
  assert.ok(!fn.includes('giveFeedback'), 'nor reported from it');
});

test('the tabs and the plus are gone, and took their panel modes with them', () => {
  for (const id of ['workshop-tabs', 'workshop-tab-status', 'workshop-tab-needs',
    'workshop-tab-all', 'workshop-tab-empty', 'workshop-plus',
    'workshop-plus-change', 'workshop-plus-issue', 'workshop-plus-create']) {
    assert.ok(!CHROME.includes(`id="${id}"`), `#${id} is not rendered`);
    assert.ok(!SCREEN.includes(`id="${id}"`), `#${id} is not on the screen either`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // The store's `tab` went with the strip: nothing filters this list now, so
  // a field naming which filter is on would be a fact with no reader.
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.ok(!/^\s*tab:/m.test(store), 'the store holds no tab');
  assert.ok(!SCREEN.includes('filterRows'), 'and the screen does not filter');
  // The scope chip keeps its panel, which is why `picker` survives.
  assert.match(store, /picker: null,/);
  assert.equal(CHROME.split('id="workshop-picker"').length - 1, 1,
    'there is exactly one panel element');
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
  for (const id of ['workshop-scope']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is in the shipped shell`);
  }
  // …and the panels are not, because they render only once somebody taps.
  assert.ok(!HTML.includes('id="workshop-picker"'), 'the panel is not in a cold document');
});
