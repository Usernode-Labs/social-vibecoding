'use strict';

// #3701 — pressing the lit Communities tab goes up a level, at every width;
// holding it on a phone's bar opens "Your communities".
//
// The same press did two things by width (#852): on a phone the lit tab
// opened the switcher, on the desktop rail the lit row went to All
// communities. It is one ladder now (frontend/src/features/workshop/
// tab-ladder.ts):
//
//   1. below a community's tabs (All items, a card, a reply thread) → back to
//      the community, on the tab you were on, at its top;
//   2. on one of its tabs, scrolled down → to the top;
//   3. on one of its tabs, at the top → All communities;
//   4. on All communities → to the top, and nothing else.
//
// A step that changes page pushes an entry (#3620). The switcher is the
// header's name, as before, and the phone's tab held for HOLD_MS.
//
// What is pinned, each a way it could quietly go back to what it was:
//
//   1. THE LADDER'S TABLE, and where each press lands from each place.
//   2. THE HOLD: touch only, the phone's bar only, cancelled by movement or an
//      early lift, and the click its lift leaves is swallowed once.
//   3. THE WIRING: the tab bar's lit press is the ladder at every width and
//      never the switcher; the pages say what is below their tabs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const LADDER_PATH = 'frontend/src/features/workshop/tab-ladder.ts';

/** The ladder with community-scope's two calls recorded rather than made. */
function loadLadder() {
  const calls = [];
  const mod = loadTsx(LADDER_PATH, {
    stubs: {
      './community-scope': {
        goToCommunity: (slug) => calls.push(['goToCommunity', slug]),
        openSwitcher: (from, el) => calls.push(['openSwitcher', from, el]),
      },
    },
  });
  return { mod, calls };
}

/** A scroller that records where it was asked to go. */
function scroller(id, scrollTop) {
  const el = {
    id,
    scrollTop,
    went: [],
    scrollTo(opts) { this.went.push(opts); this.scrollTop = opts.top; },
    closest(sel) { return sel === '#dev-forum-scroll' ? feed : null; },
  };
  let feed = null;
  el.setFeed = (f) => { feed = f; };
  return el;
}

/** Run `fn` with a stand-in window and document, then put the globals back. */
function withPage({ app = {}, view = {}, screens = {}, reduced = false } = {}, fn) {
  const had = { window: global.window, document: global.document };
  const location = { hash: '' };
  global.window = {
    App: app,
    AppView: view,
    location,
    PlatformUI: { scrollElement: (el) => el },
    matchMedia: (q) => ({ matches: q.includes('reduced-motion') ? reduced : false }),
  };
  global.document = { getElementById: (id) => screens[id] || null };
  try {
    return fn(location);
  } finally {
    global.window = had.window;
    global.document = had.document;
  }
}

test('the ladder: below → up, a tab → its top then the root, the root → its top and nothing more', () => {
  const { mod } = loadLadder();
  const { rungFor } = mod;
  assert.equal(rungFor('below', false), 'up');
  assert.equal(rungFor('below', true), 'up', 'a page below goes up whatever its offset');
  assert.equal(rungFor('tab', true), 'top');
  assert.equal(rungFor('tab', false), 'root');
  assert.equal(rungFor('root', true), 'top');
  assert.equal(rungFor('root', false), 'none', 'All communities at its top: nothing else');
  assert.equal(rungFor(null, true), 'none');
  // The tab a page below goes back to: the one last up, All items' is the
  // Workshop lit over it, and anything unreadable is the hub.
  assert.equal(mod.tabToReturnTo('all'), 'workshop');
  assert.equal(mod.tabToReturnTo('needs'), 'needs');
  assert.equal(mod.tabToReturnTo('discussion'), 'discussion');
  assert.equal(mod.tabToReturnTo('nowhere'), 'status');
  assert.equal(mod.tabToReturnTo(null), 'status');
  assert.equal(mod.HOLD_MS, 500, 'about half a second');
});

test('step 4: on All communities a press only scrolls, and at the top does nothing', () => {
  const { mod, calls } = loadLadder();
  const list = scroller('workshop-screen', 480);
  withPage({ screens: { 'workshop-screen': list } }, (location) => {
    assert.equal(mod.pressLitTab('workshop-screen'), 'top');
    assert.deepEqual(list.went, [{ top: 0, behavior: 'smooth' }], 'glides to the top');
    assert.equal(mod.pressLitTab('workshop-screen'), 'none');
    assert.equal(list.went.length, 1, 'already at the top: nothing');
    assert.equal(location.hash, '', 'no navigation');
  });
  assert.deepEqual(calls, [], 'never the switcher, never a page');
  // Reduced motion lands rather than glides.
  const again = scroller('workshop-screen', 300);
  withPage({ screens: { 'workshop-screen': again }, reduced: true }, () => {
    mod.pressLitTab('workshop-screen');
    assert.deepEqual(again.went, [{ top: 0, behavior: 'auto' }]);
  });
});

test('step 1 from a card: back to the community on the tab last up, at its top, as a pushed address', () => {
  const { mod, calls } = loadLadder();
  const landed = [];
  const view = {
    _onProjectPage: () => false,
    _workshopTab: () => 'all',
    _landOnTab: (slug, tab) => landed.push([slug, tab]),
  };
  const app = { currentApp: 'garden', _hubHref: (s) => `#app/${s}/workshop` };
  withPage({ app, view }, (location) => {
    assert.equal(mod.pressLitTab('app-view'), 'up');
    assert.deepEqual(landed, [['garden', 'workshop']], 'All items was last up: its Workshop, by the door that forgets the offset');
    assert.equal(location.hash, '#app/garden/workshop', 'a hash assignment: a new entry, as the card chip makes');
  });
  assert.deepEqual(calls, []);
  // The tab last up is the one it opens on.
  const back = [];
  withPage({
    app: { currentApp: 'garden' },
    view: { _onProjectPage: () => false, _workshopTab: () => 'needs', _landOnTab: (s, t) => back.push(t) },
  }, (location) => {
    mod.pressLitTab('app-view');
    assert.deepEqual(back, ['needs']);
    assert.equal(location.hash, '#app/garden/workshop', 'the hub\'s address without App._hubHref too');
  });
});

test('on the project page: All items or a thread goes up first, then the top, then All communities', () => {
  const { mod, calls } = loadLadder();
  const feed = scroller('dev-forum-scroll', 0);
  const host = scroller('host', 0);
  host.setFeed(feed);
  let tab = 'all';
  const ups = [];
  const page = mod.registerLevel({
    slug: 'garden',
    below: () => tab === 'all',
    up: () => { ups.push('workshop'); tab = 'workshop'; },
    host: () => host,
  });
  // Another community's page says nothing about this one.
  const other = mod.registerLevel({ slug: 'club', below: () => true, up: () => ups.push('club') });
  const app = { currentApp: 'garden' };
  const view = { _onProjectPage: (s) => s === 'garden', _landOnTab: () => assert.fail('no door on the page itself') };
  withPage({ app, view }, (location) => {
    feed.scrollTop = 900;
    assert.equal(mod.pressLitTab('app-view'), 'up', 'All items, however far down');
    assert.deepEqual(ups, ['workshop'], 'the page\'s own climb, not another community\'s');
    assert.equal(location.hash, '', 'the page pushes its own tab entry; no address here');
    assert.equal(mod.pressLitTab('app-view'), 'top', 'on the Workshop, scrolled: to the top');
    assert.equal(feed.scrollTop, 0);
    assert.equal(mod.pressLitTab('app-view'), 'root', 'at the top: All communities');
  });
  assert.deepEqual(calls, [['goToCommunity', null]], 'by the switcher\'s own All communities door, which pushes #communities');
  // A reply thread beside the Discussion is a level below it too.
  let thread = true;
  const discussion = mod.registerLevel({ slug: 'garden', below: () => thread, up: () => { thread = false; } });
  withPage({ app, view }, () => {
    assert.equal(mod.pressLitTab('app-view'), 'up');
    assert.equal(thread, false, 'the thread closes');
    assert.equal(mod.pressLitTab('app-view'), 'root');
  });
  page();
  other();
  discussion();
  // Nothing registered (the page still loading): a tab at its top.
  withPage({ app, view }, () => assert.equal(mod.pressLitTab('app-view'), 'root'));
  // A screen the tab is not lit on, or no app: nothing.
  withPage({ app: {}, view }, () => assert.equal(mod.pressLitTab('app-view'), 'none'));
  withPage({ app, view }, () => assert.equal(mod.pressLitTab('home-screen'), 'none'));
});

test('the hold: touch only, still for HOLD_MS, cancelled by moving or lifting early', () => {
  const { mod } = loadLadder();
  const timers = new Map();
  let next = 1;
  const setTimer = (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  const fire = (ms) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); }
  };
  const listeners = [];
  const doc = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  const held = [];
  let enabled = true;
  const hold = mod.createHold({ enabled: () => enabled, onHold: (el) => held.push(el), doc, setTimer, clearTimer });
  const tabEl = { id: 'platform-tab-workshop' };
  const touch = (x = 10, y = 10, extra = {}) => ({ pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, currentTarget: tabEl, ...extra });

  // A mouse never holds; a second finger never holds.
  hold.onPointerDown(touch(10, 10, { pointerType: 'mouse' }));
  hold.onPointerDown(touch(10, 10, { isPrimary: false }));
  assert.equal(timers.size, 0);

  // A short press is an ordinary tap.
  hold.onPointerDown(touch());
  assert.equal([...timers.values()][0].ms, 500);
  hold.onPointerUp();
  fire(500);
  assert.deepEqual(held, [], 'lifted before HOLD_MS');
  assert.equal(listeners.length, 0, 'and its click is its own');

  // Moving cancels; a wobble within the slop does not.
  hold.onPointerDown(touch());
  hold.onPointerMove(touch(16, 14));
  assert.equal(timers.size, 1, 'within HOLD_SLOP_PX');
  hold.onPointerMove(touch(10, 30));
  assert.equal(timers.size, 0, 'a scroll is not a hold');
  hold.onPointerUp();
  assert.deepEqual(held, []);

  // The desktop rail (a wide window) never starts one.
  enabled = false;
  hold.onPointerDown(touch());
  assert.equal(timers.size, 0);
  enabled = true;

  // Held: it lands on the tab while the finger is still down.
  hold.onPointerDown(touch());
  fire(500);
  assert.deepEqual(held, [tabEl]);
  // …and the lift's click is swallowed once, at the document, in capture.
  hold.onPointerUp();
  const click = listeners.find((l) => l.type === 'click');
  assert.ok(click && click.capture === true, 'a capture listener on the document');
  let prevented = 0;
  let stopped = 0;
  click.fn({ preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(listeners.length, 0, 'only the one click');

  // A new press before any click lets the guard go: that tap is its own.
  hold.onPointerDown(touch());
  fire(500);
  hold.onPointerUp();
  assert.equal(listeners.length, 2, 'click and pointerdown guards');
  listeners.find((l) => l.type === 'pointerdown').fn();
  assert.equal(listeners.length, 0);
  // …and so does HOLD_CLICK_MS passing with no click at all.
  hold.onPointerDown(touch());
  fire(500);
  hold.onPointerUp();
  fire(mod.HOLD_CLICK_MS);
  assert.equal(listeners.length, 0);

  // The browser deciding the press was held (Android's contextmenu) lands it
  // at once, and its own menu is stood down.
  held.length = 0;
  hold.onPointerDown(touch());
  let menu = 0;
  hold.onContextMenu({ preventDefault: () => { menu += 1; } });
  assert.equal(menu, 1);
  assert.deepEqual(held, [tabEl]);
  assert.equal(timers.size, 0, 'the timer does not land it twice');
  hold.onPointerCancel();
  assert.equal(listeners.length, 2, 'a cancelled lift still guards its click');
  hold.dispose();
  assert.equal(listeners.length, 0, 'unmounting lets the guard go');
  // A right-click with a mouse keeps the browser's menu.
  let mouseMenu = 0;
  hold.onContextMenu({ preventDefault: () => { mouseMenu += 1; } });
  assert.equal(mouseMenu, 0);
});

test('the tab bar: the lit Communities tab is the ladder at every width, and the switcher only when held', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const click = src.slice(src.indexOf('const onTabClick = '), src.indexOf('return (', src.indexOf('const onTabClick = ')));
  assert.match(click, /if \(key === 'workshop' && lit === 'workshop' && tab === 'workshop'\) \{\s*event\.preventDefault\(\);\s*pressLitTab\(screen\);\s*return;\s*\}/);
  assert.doesNotMatch(click, /toggleSwitcher|openSwitcher|matchMedia|goToCommunity/,
    'no width decides it, and a press never opens the switcher');
  assert.doesNotMatch(src, /toggleSwitcher/);
  // The hold rides on the Communities tab alone, as handlers only.
  assert.match(src, /const \[hold\] = useState\(createSwitcherHold\);/);
  assert.match(src, /useEffect\(\(\) => \(\) => hold\.dispose\(\), \[hold\]\);/);
  assert.match(src, /\{\.\.\.\(key === 'workshop' \? holdProps : \{\}\)\}/);
  const ladder = read(LADDER_PATH);
  assert.match(ladder, /export function createSwitcherHold\(\) \{\s*return createHold\(\{ enabled: onPhoneBar, onHold: \(el\) => openSwitcher\('tab', el\) \}\);/);
  assert.match(ladder, /return !window\.matchMedia\('\(min-width: 768px\)'\)\.matches;/, 'the phone\'s bar only');
  // iOS's own long press on a link would open over the sheet.
  const css = read('public/css/app.css');
  assert.match(css, /#platform-tab-workshop \{\s*-webkit-touch-callout: none;\s*-webkit-user-select: none;\s*user-select: none;\s*\}/);
  // The header's name still opens it, unchanged.
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.equal((header.match(/onClick=\{\(e\) => toggleSwitcher\('header', e\.currentTarget\)\}/g) || []).length, 2);
});

test('the pages say what is below their tabs: All items on the project page, a reply thread beside its Discussion', () => {
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const climb = /const climb = \(\) => \{([\s\S]*?)\n  \};/.exec(workshop);
  assert.ok(climb, 'the page\'s climb');
  assert.match(climb[1], /const next = pageParent\(was\);/);
  assert.match(climb[1], /callAppView\('_pushWorkshopTab', v\.slug, was, next\);/, 'a new entry, as a tab press pushes');
  assert.doesNotMatch(climb[1], /_upWorkshopTab/);
  assert.match(climb[1], /callAppView\('_saveFeedScroll', v\.slug, 0\);\s*scrollToHead\(hostRef\.current\);/, 'at its top');
  assert.match(workshop, /registerLevel\(\{\s*slug: v\.slug,\s*below: \(\) => tabRef\.current === 'all',\s*up: \(\) => climbRef\.current\(\),\s*host: \(\) => hostRef\.current,\s*\}\)/);
  const discussion = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  assert.match(discussion, /below: \(\) => \(room \? embeddedThreadOpen\(room\) : !!threadRef\.current\),\s*up: \(\) => \{ if \(room\) closeThread\(\); else setThread\(null\); \},/);
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /export function embeddedThreadOpen\(conversationId: number\): boolean \{\s*return !!state\.route\.embedded && state\.route\.conversationId === conversationId && !!state\.route\.threadRootId;/);
  // The switcher's notes say where it opens from now.
  const switcher = read('frontend/src/features/workshop/community-switcher.tsx');
  assert.match(switcher, /the phone's tab HELD \(#3701\)/);
  assert.doesNotMatch(switcher, /lit sidebar row goes back/);
  assert.match(switcher, /t\.closest\('\[data-community-switch\]'\)/, 'a press on the rail row closes the menu like any other');
});
