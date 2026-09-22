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
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

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
  // DEAD ONLY WHERE THERE IS NOTHING BEHIND IT. On this screen the one thing
  // the panel holds is your apps, so with none of them a control that says it
  // has nothing to offer beats a panel that says nothing. The same chip worn
  // by ONE app's Workshop always has somewhere to go — back up to all of
  // them — which is why the condition names the scope (#2718 review).
  assert.match(CHROME, /disabled=\{!scope && \(!apps \|\| apps\.length === 0\)\}/,
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
  // ONE PANEL COMPONENT, TWO SURFACES (#2718 review). The id is a prop now,
  // because the app's own Workshop wears the same chip and the same panel
  // with the scope set — and two elements sharing one id is the shell's id
  // contract broken in the quietest possible way. This screen's spelling is
  // the default, so it is the only literal in the file.
  assert.equal(CHROME.split("id || 'workshop-picker'").length - 1, 2,
    'there is exactly one panel element, and it names itself once per id it needs');
  assert.match(CHROME, /id=\{id \|\| 'workshop-scope'\}/, 'and so does the chip');
  assert.ok(!CHROME.includes('id="workshop-picker"'),
    'nothing hard-codes the id any more');
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

// ── The same chip, scoped to one app (#2718 review) ────────────────────

test('scoped, the chip names the app and never reads as a dead control', () => {
  // The app's own Workshop wears this, and the first render has no list: the
  // fetch runs in an effect, so what it draws until then is what the caller
  // already knows — which is why the name and the artwork are props rather
  // than something to wait for. A chip that started as a bare slug and
  // changed under the reader would be worse than one that arrived late.
  const html = renderToHtml(createElement(chrome.AppWorkshopScope, {
    slug: 'notes-ab12', name: 'Recipe Box', iconEmoji: '🍲',
  }));
  assert.match(html, /id="dev-ws-scope-chip"/);
  assert.match(html, /Recipe Box/, 'it names the app, not the slug');
  assert.doesNotMatch(html, /All apps/,
    'the panel is behind a press, so the first render is the chip alone');
  // The ATTRIBUTE, not the word: `disabled:opacity-60` is in every one of
  // these chips' class strings and matching on it would pass either way.
  assert.doesNotMatch(html, /disabled=""/,
    'scoped there is always somewhere to go — up to all of them');
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="dev-ws-scope-chip-picker"/,
    'the panel it names is this surface\'s, not the all-apps screen\'s');
});

test('unscoped, the chip is the all-apps screen\'s and is dead with no apps', () => {
  const empty = renderToHtml(createElement(chrome.WorkshopScope, { apps: [], open: false }));
  assert.match(empty, /id="workshop-scope"/, 'the default id is this screen\'s');
  assert.match(empty, /All apps/);
  assert.match(empty, /disabled=""/,
    'with nothing behind it, a control that says so beats a panel that says nothing');

  const some = renderToHtml(createElement(chrome.WorkshopScope, {
    apps: [app('notes-ab12', 0, 0)], open: false,
  }));
  assert.doesNotMatch(some, /disabled=""/);
});
