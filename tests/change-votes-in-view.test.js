'use strict';

// Run four (13 Oct 2026): the App tab's "See the change" opened Club Votes'
// change page at its title; the Votes card with the Vote button sat a screen
// and a half down, and scrolled to by hand it stopped half under the
// "Change #N" header. A door that sends someone to vote now opens the page
// with the Votes card in view below the header
// (frontend/src/features/dev-board/topic/votes-in-view.ts), for any change,
// not only a first version: the App tab's See the change
// (AppView.openFirstVersionChange, tests/app-status-placeholder.test.js) and
// a vote's notification (tests/vote-digest-destination.test.js).
//
// Run with: node --test tests/change-votes-in-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MODULE = 'frontend/src/features/dev-board/topic/votes-in-view.ts';

test('an ask is for one change, taken once, by its own page, while it is fresh', () => {
  const v = loadTsx(MODULE, { cache: false });
  v.askVotesInView(31, 1000);
  assert.equal(v.takeVotesInView(32, 1000), false, 'another change\'s page does not take it');
  assert.equal(v.takeVotesInView(31, 1000 + v.ASK_TTL_MS), true, 'its own does');
  assert.equal(v.takeVotesInView(31, 1000), false, 'once');
  v.askVotesInView('31', 0);
  assert.equal(v.takeVotesInView(31, v.ASK_TTL_MS + 1), false, 'a door that opened nothing is forgotten');
  v.askVotesInView(31, 0);
  v.askVotesInView(0, 0);
  assert.equal(v.takeVotesInView(31, 0), false, 'no change, no ask');
  // A page already on screen hears it: its address does not change.
  const heard = [];
  const off = v.onVotesAsked(() => heard.push(v.takeVotesInView(40, 5)));
  v.askVotesInView(40, 5);
  off();
  v.askVotesInView(40, 6);
  assert.deepEqual(heard, [true]);
});

test('the card comes to rest a little below the header, wherever the header is drawn', () => {
  const { votesScrollDelta, GAP_PX } = loadTsx(MODULE);
  assert.equal(GAP_PX, 12);
  // The header above the scroller: the scroller's own top.
  assert.equal(votesScrollDelta({ cardTop: 900, scrollerTop: 100, headerBottom: 90 }), 788);
  // A header drawn over the scroller (sticky): below it, not half under it.
  assert.equal(votesScrollDelta({ cardTop: 900, scrollerTop: 100, headerBottom: 160 }), 728);
  assert.equal(votesScrollDelta({ cardTop: 120, scrollerTop: 100 }), 8);
  assert.equal(votesScrollDelta({ cardTop: 50, scrollerTop: 100, headerBottom: null }), -62, 'up, when it starts above');
});

function fakePage({ cardAt = 900, scrollerTop = 100, headerBottom = 100 } = {}) {
  // One listener table for the scroller and its document: `fire` stands for
  // an event reaching either.
  const on = new Map();
  const add = (type, fn) => { if (!on.has(type)) on.set(type, new Set()); on.get(type).add(fn); };
  const remove = (type, fn) => { on.get(type)?.delete(fn); };
  const fire = (type) => [...(on.get(type) || [])].forEach((fn) => fn({ type }));
  const scroller = {
    scrollTop: 0, children: [],
    getBoundingClientRect: () => ({ top: scrollerTop }),
    addEventListener: add, removeEventListener: remove,
  };
  const header = { getBoundingClientRect: () => ({ top: headerBottom - 56, bottom: headerBottom, height: 56 }) };
  const card = {
    isConnected: true,
    ownerDocument: {
      getElementById: (id) => (id === 'gc-thread-bar' ? header : null),
      addEventListener: add, removeEventListener: remove,
    },
    closest: (sel) => (sel === '#gc-thread-scroll' ? scroller : null),
    getBoundingClientRect: () => ({ top: scrollerTop + cardAt - scroller.scrollTop }),
  };
  return { scroller, card, fire, listening: (type) => (on.get(type) || new Set()).size };
}

test('the card is brought into view and held there while the page settles, until the reader moves it', () => {
  const { holdVotesInView, HOLD_MS } = loadTsx(MODULE);
  const timers = [];
  const saved = { window: global.window, ResizeObserver: global.ResizeObserver };
  global.window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    scrollBy: () => { throw new Error('the thread scroller moves, not the page'); },
  };
  const observed = [];
  global.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe(el) { observed.push(el); } disconnect() { observed.length = 0; } };
  try {
    const page = fakePage();
    const release = holdVotesInView(page.card);
    assert.equal(page.scroller.scrollTop, 888, 'the card\'s top 12px under the header');
    assert.equal(page.card.getBoundingClientRect().top, 112);
    assert.equal(timers[0].ms, HOLD_MS);
    assert.deepEqual(observed, [page.scroller], 'what the scroller holds growing above it is put right');
    // The thread's first load puts its scroller back at the top (#363).
    page.scroller.scrollTop = 0;
    page.fire('scroll');
    assert.equal(page.scroller.scrollTop, 888, 'put right');
    // The reader's own touch lets go: from then on it is theirs.
    page.fire('touchstart');
    page.scroller.scrollTop = 40;
    page.fire('scroll');
    assert.equal(page.scroller.scrollTop, 40);
    assert.equal(page.listening('scroll') + page.listening('touchstart') + page.listening('wheel'), 0, 'nothing left listening');
    release();

    // Or the time runs out.
    const later = fakePage({ headerBottom: 160 });
    holdVotesInView(later.card);
    assert.equal(later.scroller.scrollTop, 828, 'below a header drawn over the scroller');
    assert.equal(later.card.getBoundingClientRect().top, 172);
    timers[timers.length - 1].fn();
    later.scroller.scrollTop = 0;
    later.fire('scroll');
    assert.equal(later.scroller.scrollTop, 0);
  } finally {
    global.window = saved.window;
    global.ResizeObserver = saved.ResizeObserver;
  }
});

test('the change page takes its ask when it draws the Votes card, or hears one while it is up', () => {
  const head = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(head, /import \{ holdVotesInView, onVotesAsked, takeVotesInView \} from '\.\/votes-in-view';/);
  assert.match(head, /const card = pair\.current\?\.querySelector<HTMLElement>\('\[data-change-gate="votes"\]'\);\n\s+if \(!card \|\| !takeVotesInView\(id\)\) return;/);
  assert.match(head, /const off = onVotesAsked\(show\);\n\s+return \(\) => \{ off\(\); release\?\.\(\); \};\n\s+\}, \[id\]\);/);
  assert.match(head, /<ChangeGates ref=\{pair\} id=\{id\} card=\{card\} v=\{v\} \/>/);
  assert.match(head, /<div ref=\{ref\} className="dev-change-pair">\n\s+<GateCard which="votes"/, 'the pair the ref is on leads with Votes');
  // Legacy doors reach it through the dev board's bridge.
  const mount = read('frontend/src/features/dev-board/mount.ts');
  assert.match(mount, /showVotes: \(sessionId: number\) => askVotesInView\(sessionId\),/);
});
