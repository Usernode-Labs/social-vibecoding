'use strict';

// Home's New project card ("Have an idea?"): the one card of Home's side
// column, beside the pinned lists from 1280px.
//
//   1. It is drawn only where Home has a side column: the standard pages,
//      from 1280px, for a viewer the grid gives a create view. Narrower than
//      that the column is not displayed and Pinned apps ends with the New
//      project tile instead (tests/home-create-tile.test.js).
//   2. Its button opens the same make screen as the tile.
//   3. The line under the button counts project slots only when there is a
//      limit, and at none it links to the allowance card.
//   4. It can be closed for this browser (#6757): the ✕ keeps the choice in
//      localStorage, the card and Home's side column both follow it, and
//      once closed Home is one column again with the grid's New project tile.
//
// Run with: node --test tests/home-new-project-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/home/new-project-card.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the island mounts the card in a side column, on the standard pages only', () => {
  const island = read('frontend/src/features/home/index.tsx');
  assert.match(island, /const aside = !frame && grid\.ready && !!grid\.create && !cardHidden;/);
  assert.match(island, /setCardHidden\(newProjectCardHidden\(\)\)/);
  assert.match(island, /window\.addEventListener\(NEW_PROJECT_HIDDEN_EVENT, onHidden\)/);
  assert.match(island, /data-home-aside=\{aside \? '' : undefined\}/);
  assert.match(island, /\{aside \? \(\s*<aside id="home-aside" className="home-aside">\s*<NewProjectCard \/>\s*<\/aside>\s*\) : null\}/);
  assert.match(island, /<div className="home-main">/);
});

test('the side column exists from 1280px and holds no place under it', () => {
  const css = read('public/css/app.css');
  const base = css.match(/\n\.home-aside \{([^}]*)\}/);
  assert.ok(base, 'the column has a base rule');
  assert.match(base[1], /display: none;/, 'one column draws no card');
  const wide = css.slice(css.indexOf("HOME'S SIDE COLUMN"));
  const media = wide.slice(wide.indexOf('@media (min-width: 1280px)'));
  assert.match(media, /#home-screen\[data-home-aside\] \.home-aside \{\s*display: block;\s*flex: 0 0 304px;/);
  assert.match(media, /#home-screen\[data-home-aside\] \.home-body-fill \{\s*flex-direction: row-reverse;/);
  // home.js draws no grid tile at the same width (Home.hasSideCard).
  const js = read('frontend/src/features/home/home.js');
  assert.match(js, /window\.matchMedia\('\(min-width: 1280px\)'\)\.matches/);
  const side = js.slice(js.indexOf('hasSideCard() {'), js.indexOf('_wireRowBudget() {'));
  assert.match(side, /if \(newProjectCardHidden\(\)\) return false;/, 'a closed card has no column');
  assert.ok(
    side.indexOf('newProjectCardHidden') < side.indexOf("window.matchMedia('(min-width: 1280px)')"),
    'the dismissal is answered before the width is',
  );
  assert.match(js, /window\.addEventListener\(NEW_PROJECT_HIDDEN_EVENT, run\)/,
    'closing the card re-renders the grid, so its tile comes back');
});

test('the card draws only for a viewer who may make projects, and opens the make screen', () => {
  const src = read(CARD);
  assert.match(src, /if \(!grid\.ready \|\| !grid\.create\) return null;/);
  assert.match(src, /const open = \(\) => \{ win\(\)\.App\?\.showCreateModal\?\.\(\); \};/);
  assert.match(src, /id="home-new-project-btn"\s+className=\{BUTTON\}\s+onClick=\{open\}/);
  assert.match(src, /aria-labelledby="home-new-project-title"/);
  assert.match(src, /href="#profile\?slots"/, 'at no slots left, the way to ask for more');
  assert.equal(message('home:newProject.title'), 'Have an idea?');
  assert.equal(message('home:create.label'), 'New project');
  assert.match(message('home:newProject.slotsNone'), /<0>Request project slots<\/0>/);
  // The close button is the same dismissal the page reads (#6757).
  assert.match(src, /id="home-new-project-close"[\s\S]*?onClick=\{hideNewProjectCard\}/);
  assert.match(src, /aria-label=\{t\('home:newProject\.close'\)\}/);
  assert.equal(message('home:newProject.close'), 'Close');
  assert.match(src, /if \(hidden\) return null;/, 'a closed card draws nothing');
  assert.match(src, /window\.addEventListener\(NEW_PROJECT_HIDDEN_EVENT, onHidden\)/);
});

test('the card is drawn in Home\'s plain card, with no glow and no accent pill', () => {
  const src = read(CARD);
  assert.doesNotMatch(src, /bg-gradient/, 'no gradient button');
  assert.doesNotMatch(src, /blur-3xl/, 'no soft light in the corner');
  assert.doesNotMatch(src, /shadow-violet/, 'no accent shadow');
  assert.match(src, /text-\[15px\] font-\[650\] leading-tight/, 'a list-title heading, not a hero');
  assert.match(src, /pe-8/, 'the fan clears the close button');
});

test('the dismissal is kept per browser: the key, the event, and a storage that throws', () => {
  const store = new Map();
  const events = [];
  global.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  global.window = { dispatchEvent: (event) => { events.push(event); } };
  try {
    const dismiss = loadTsx('frontend/src/features/home/new-project-dismiss.ts');
    assert.equal(dismiss.NEW_PROJECT_HIDDEN_KEY, 'usernode:new-project-card-hidden');
    assert.equal(dismiss.NEW_PROJECT_HIDDEN_EVENT, 'usernode:new-project-card-hidden');
    assert.equal(dismiss.newProjectCardHidden(), false, 'not closed at first');
    dismiss.hideNewProjectCard();
    assert.equal(store.get('usernode:new-project-card-hidden'), '1');
    assert.equal(events.length, 1, 'the page is told once');
    assert.equal(events[0].type, 'usernode:new-project-card-hidden');
    assert.equal(dismiss.newProjectCardHidden(), true);

    // Private mode: reading throws, so the card shows; writing throws, so the
    // close is for this visit only.
    global.localStorage = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    assert.equal(dismiss.newProjectCardHidden(), false);
    assert.doesNotThrow(() => dismiss.hideNewProjectCard());
    assert.equal(events.length, 2, 'the card still closes for this visit');
  } finally {
    delete global.localStorage;
    delete global.window;
  }
});

test('the fan is the pinned apps\' pictures: five at most, no demo tile, no letter', () => {
  const { fanIcons } = loadTsx(CARD);
  const img = (n) => ({ app: { demo: false, icon: { kind: 'image', src: `/i/${n}.png` } } });
  const items = [
    img(1),
    { app: { demo: false, icon: { kind: 'letter', letter: 'A' } } },
    { app: { demo: true, icon: { kind: 'image', src: '/demo.png' } } },
    img(2), img(3), img(4), img(5), img(6),
  ];
  assert.deepEqual(fanIcons(items).map((icon) => icon.src), ['/i/1.png', '/i/2.png', '/i/3.png', '/i/4.png', '/i/5.png']);
  assert.deepEqual(fanIcons([]), []);
});

test('the slots line: a count with a limit, the request link at none, nothing without a limit', () => {
  const { slotsState } = loadTsx(CARD);
  assert.equal(slotsState(null), null, 'unknown yet');
  assert.equal(slotsState({ limit: null, remaining: null }), null, 'no limit: a count would say nothing');
  assert.equal(slotsState({ limit: 3, remaining: 2 }), 'free');
  assert.equal(slotsState({ limit: 3, remaining: 0 }), 'none');
});
