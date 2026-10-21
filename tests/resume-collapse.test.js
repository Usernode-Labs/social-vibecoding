'use strict';

// #3618 — closing an app collapses it into its Resume control, and Resume
// grows it back out of the same control.
//
//   frontend/src/features/nav/resume-motion.ts    the origin note and the stand-in
//   frontend/src/features/nav/recents-list.tsx    the desktop Active row's pill
//   frontend/src/features/nav/parked-strip.tsx    the phone strip's origin
//   frontend/src/features/nav/mount.ts            the router's bridge
//   public/js/app.js                              measure, park, collapse, grow
//   public/usernode-native/v1/native.js           the zoom's optional duration
//   public/css/app.css                            the pill and the stand-in
//
// The module is executed against a small hand-rolled DOM: these are the
// geometry and one-shot rules, not React's renderer, and a real browser is
// what tests/proposal checks use for the pictures.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAX = 1280;
const VIEW = 800;

function box(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

class FakeEl {
  constructor(rect = box(0, 0, 0, 0), attrs = {}) {
    this.rect = rect;
    this.attrs = { ...attrs };
    this.style = {};
    this.children = [];
    this.listeners = {};
    this.textContent = '';
    this.className = '';
    this.parentNode = null;
  }

  getBoundingClientRect() { return this.rect; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  get offsetWidth() { return 1; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    if (selector === '.platform-recent-resume') {
      return this.children.filter((c) => c.className.split(/\s+/).includes('platform-recent-resume'));
    }
    return [];
  }
  get classList() {
    const self = this;
    return { contains: (name) => self.className.split(/\s+/).includes(name) };
  }
}

/** A DOM just large enough for resume-motion's lookups and stand-in. */
function fakeDom() {
  const dom = {
    rows: [],
    stripRoot: null,
    stripLink: null,
    vt: false,
    reduced: false,
    body: new FakeEl(),
    timers: new Map(),
    nextTimer: 0,
  };
  const document = {
    createElement: () => new FakeEl(),
    body: dom.body,
    documentElement: { hasAttribute: (name) => name === 'data-un-vt' && dom.vt },
    querySelectorAll: (selector) => (selector.startsWith('#platform-recents') ? dom.rows : []),
    getElementById: (id) => {
      if (id === 'platform-parked') return dom.stripRoot;
      if (id === 'platform-parked-resume') return dom.stripLink;
      return null;
    },
  };
  const win = {
    innerWidth: MAX,
    innerHeight: VIEW,
    matchMedia: (query) => ({ matches: dom.reduced && query.includes('reduced-motion') }),
    setTimeout: (fn, ms) => { dom.nextTimer += 1; dom.timers.set(dom.nextTimer, { fn, ms }); return dom.nextTimer; },
    clearTimeout: (id) => { dom.timers.delete(id); },
  };
  dom.document = document;
  dom.window = win;
  return dom;
}

function withDom(dom, fn) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.document;
  try {
    return fn();
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

/** A desktop Active row with the pill inside it. */
function activeRow(slug, { current = false, pillRect = box(1100, 20, 60, 22) } = {}) {
  const row = new FakeEl(box(12, 18, 200, 34), { 'data-recent-key': `app:${slug}` });
  if (!current) {
    const pill = new FakeEl(pillRect);
    pill.className = 'platform-recent-resume';
    row.appendChild(pill);
  }
  return row;
}

// ── The row's pill ────────────────────────────────────────────────────

test('#3618: the Active row offers Resume, the current row does not, Recents never does', () => {
  const { ActiveApps, RecentsByDay } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const { buildActive, buildRecents } = loadTsx('frontend/src/features/nav/recents.ts');
  const apps = [
    { slug: 'notes', name: 'Notes', iconUrl: null, iconEmoji: '📝', at: '2026-09-20T10:00:00Z' },
    { slug: 'chess', name: 'Chess', iconUrl: null, iconEmoji: '♟️', at: '2026-09-20T09:00:00Z' },
  ];
  const items = buildActive({ live: ['notes', 'chess'], current: 'notes', apps });
  const html = renderToHtml(createElement(ActiveApps, { items }));
  const rows = html.match(/<a class="platform-recent"[^>]*>[\s\S]*?<\/a>/g);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows[0], /platform-recent-resume/, 'the app you are in is not offered a resume');
  assert.match(rows[0], /class="app-live-dot platform-recent-live"/, 'it keeps the green still-open dot');
  assert.match(rows[1], /<span class="platform-recent-resume" aria-hidden="true">Resume<\/span>/);
  assert.match(rows[1], /aria-label="App: Chess, still open"/, 'the accessible name does not change');
  assert.ok(rows[1].indexOf('platform-recent-resume') < rows[1].indexOf('platform-recent-live'),
    'the pill comes before the dot, so the sibling rule can hide it');

  // Recents is history, not a running app: no Resume there, ever.
  const recents = buildRecents({
    apps, conversations: [], discussions: [], agents: [], active: ['notes', 'chess'],
  });
  const day = renderToHtml(createElement(RecentsByDay, {
    items: recents, live: [], showOlder: false, onToggleOlder: () => {},
  }));
  assert.doesNotMatch(day, /platform-recent-resume/);

  // The pill is a label in the row's anchor, never a nested button.
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list, /<span className="platform-recent-resume" aria-hidden="true">Resume<\/span>/);
  assert.doesNotMatch(list, /<button[^>]*platform-recent-resume/);
  assert.match(list, /<RecentRow key=\{item\.key\} item=\{item\} live resume=\{!item\.current\} \/>/);
});

test('#3618: both Resume pills are filled with the action blue', () => {
  const css = read('public/css/app.css');
  const rail = /\.platform-recent-resume \{[^}]*background: var\(--accent\);[^}]*color: var\(--accent-ink\);/;
  assert.match(css, rail, 'the desktop Active pill');
  const stripAt = css.indexOf('.platform-parked-pill {');
  const strip = css.slice(stripAt, css.indexOf('}', stripAt));
  assert.match(strip, /background: var\(--accent\);/);
  assert.match(strip, /color: var\(--accent-ink\);/);
  assert.match(strip, /border: 0;/, 'the pale periwinkle tag had a border; an action does not');
  assert.doesNotMatch(strip, /--brand-/, 'Resume is an action, not the header\'s own ink');
  assert.match(css, /\.platform-recent-resume ~ \.platform-recent-live \{\s*display: none;\s*\}/,
    'one mark per row: the pill replaces the still-open dot');

  const ghost = /\.resume-ghost \{[^}]*position: fixed;[^}]*transform-origin: 0 0;/;
  assert.match(css, ghost);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.resume-ghost \{ display: none; \}/);
});

// ── Finding the control ───────────────────────────────────────────────

test('#3618: resumeHandleFor is the pill, then the row, then the phone strip', () => {
  const dom = fakeDom();
  const motion = loadTsx('frontend/src/features/nav/resume-motion.ts');
  withDom(dom, () => {
    const row = activeRow('chess');
    dom.rows = [row];
    assert.equal(motion.resumeHandleFor('chess'), row.children[0], 'the pill is the target');
    row.children[0].rect = box(0, 0, 0, 0);
    assert.equal(motion.resumeHandleFor('chess'), row, 'a pill with no area falls back to the row');
    row.rect = box(0, 0, 0, 0);
    assert.equal(motion.resumeHandleFor('chess'), null, 'nothing on screen');
    assert.equal(motion.resumeHandleFor('notes'), null, 'another app has no control here');

    const root = new FakeEl(box(0, 700, 390, 52));
    root.className = 'platform-parked';
    const link = new FakeEl(box(4, 704, 300, 44), { href: '/app/chess' });
    dom.stripRoot = root;
    dom.stripLink = link;
    assert.equal(motion.resumeHandleFor('chess'), root, 'the phone strip is the origin');
    root.className = 'platform-parked hidden';
    assert.equal(motion.resumeHandleFor('chess'), null, 'a hidden strip is not a target');
    root.className = 'platform-parked';
    link.attrs.href = '/app/notes';
    assert.equal(motion.resumeHandleFor('chess'), null, 'the strip names another app');

    // Off screen, in either direction, is not on screen. The row is still
    // a target, so the pill's absence falls back to it; the row's own rect
    // going too is what leaves nothing.
    dom.rows = [activeRow('chess', { pillRect: box(2000, 20, 60, 22) })];
    assert.equal(motion.resumeHandleFor('chess'), dom.rows[0], 'an off-screen pill falls back to the row');
    dom.rows[0].rect = box(2000, 20, 200, 34);
    assert.equal(motion.resumeHandleFor('chess'), null);
    dom.rows = [activeRow('chess', { pillRect: box(-200, 20, 60, 22) })];
    dom.rows[0].rect = box(-300, 20, 200, 34);
    assert.equal(motion.resumeHandleFor('chess'), null);
  });
});

// ── The pressed origin ────────────────────────────────────────────────

test('#3618: a noted origin is per-slug, taken once, fresh and on-screen', () => {
  const dom = fakeDom();
  const motion = loadTsx('frontend/src/features/nav/resume-motion.ts');
  withDom(dom, () => {
    const el = new FakeEl(box(1100, 20, 60, 22));
    motion.noteResumeOrigin('chess', el);
    assert.equal(motion.takeResumeOrigin('notes'), null, 'another slug does not take it');
    assert.equal(motion.takeResumeOrigin('chess'), el, 'the press comes back once');
    assert.equal(motion.takeResumeOrigin('chess'), null, 'and only once');

    const realNow = Date.now;
    try {
      motion.noteResumeOrigin('notes', el);
      Date.now = () => realNow() + 2000;
      assert.equal(motion.takeResumeOrigin('notes'), null, 'a stale press is ignored');
    } finally {
      Date.now = realNow;
    }

    motion.noteResumeOrigin('notes', new FakeEl(box(0, 0, 0, 0)));
    assert.equal(motion.takeResumeOrigin('notes'), null, 'a control with no area is not noted');

    motion.noteResumeOrigin('notes', el);
    el.rect = box(3000, 20, 60, 22);
    assert.equal(motion.takeResumeOrigin('notes'), null, 'a control that has gone is ignored');
  });
});

// ── The stand-in ──────────────────────────────────────────────────────

test('#3618: the close stand-in starts at the app rect and shrinks into the pill', () => {
  const dom = fakeDom();
  const motion = loadTsx('frontend/src/features/nav/resume-motion.ts');
  withDom(dom, () => {
    dom.rows = [activeRow('chess', { pillRect: box(1100, 20, 60, 22) })];
    motion.collapseIntoResume('chess', box(100, 100, 600, 400));

    assert.equal(dom.body.children.length, 1, 'one stand-in');
    const ghost = dom.body.children[0];
    assert.equal(ghost.className, 'resume-ghost');
    assert.equal(ghost.style.left, '100px');
    assert.equal(ghost.style.top, '100px');
    assert.equal(ghost.style.width, '600px');
    assert.equal(ghost.style.height, '400px');
    assert.match(ghost.style.transition, /transform 250ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
    assert.match(ghost.style.transition, /opacity 90ms linear 160ms/, 'the fade is on the clock');
    assert.equal(ghost.style.transform, 'translate(1000px, -80px) scale(0.1, 0.055)');
    assert.equal(ghost.style.opacity, '0');

    const tile = ghost.children[0];
    assert.equal(tile.className, 'app-icon-tile resume-ghost-tile');
    assert.equal(tile.textContent, 'C', 'a letter is text, never markup');
    assert.equal(tile.attrs['data-icon'], 'letter');

    const timer = [...dom.timers.values()].find((t) => t.ms === 400);
    assert.ok(timer, 'a 250 + 150ms cleanup');
    ghost.listeners.transitionend();
    assert.equal(dom.body.children.length, 0, 'gone when the motion finishes');
    assert.equal(dom.timers.size, 0, 'and its timer is cleared');

    // A second collapse finishes the first rather than stacking two cards.
    motion.collapseIntoResume('chess', box(100, 100, 600, 400));
    motion.collapseIntoResume('chess', box(120, 120, 500, 300));
    assert.equal(dom.body.children.length, 1);
    dom.body.children[0].listeners.transitioncancel();
    assert.equal(dom.body.children.length, 0);
  });
});

test('#3618: reduced motion, a View Transition and no control create nothing', () => {
  const dom = fakeDom();
  const motion = loadTsx('frontend/src/features/nav/resume-motion.ts');
  withDom(dom, () => {
    dom.rows = [activeRow('chess')];
    dom.reduced = true;
    motion.collapseIntoResume('chess', box(100, 100, 600, 400));
    assert.equal(dom.body.children.length, 0, 'reduced motion keeps the plain swap');

    dom.reduced = false;
    dom.vt = true;
    motion.collapseIntoResume('chess', box(100, 100, 600, 400));
    assert.equal(dom.body.children.length, 0, 'a View Transition is drawing snapshots');

    dom.vt = false;
    dom.rows = [];
    motion.collapseIntoResume('chess', box(100, 100, 600, 400));
    assert.equal(dom.body.children.length, 0, 'no control on screen, no motion');

    // With no measured rect the stand-in starts at the header's lower edge.
    dom.rows = [activeRow('chess')];
    dom.document.getElementById = (id) => (id === 'platform-header'
      ? new FakeEl(box(0, 0, MAX, 56)) : null);
    motion.collapseIntoResume('chess', null);
    assert.equal(dom.body.children.length, 1, 'the app still has a place to start from');
    assert.equal(dom.body.children[0].style.top, '56px');
    assert.equal(dom.body.children[0].style.width, `${MAX}px`);
    assert.equal(dom.body.children[0].style.height, `${VIEW - 56}px`);
    dom.body.children[0].listeners.transitionend();
  });
});

// ── The seam ──────────────────────────────────────────────────────────

test('#3618: both press paths note the control before the router opens the app', () => {
  const list = read('frontend/src/features/nav/recents-list.tsx');
  const note = list.indexOf('noteResumeOrigin(slug, pressed || event.currentTarget);');
  const open = list.indexOf("window.App?.openAppTab?.(slug, 'app');");
  assert.ok(note > 0 && open > note, 'the desktop row notes first');

  const strip = read('frontend/src/features/nav/parked-strip.tsx');
  const stripNote = strip.indexOf('noteResumeOrigin(app.slug, ref.current);');
  const stripOpen = strip.indexOf("window.App?.openAppTab?.(app.slug, 'app');");
  assert.ok(stripNote > 0 && stripOpen > stripNote, 'the phone strip notes first');
});

test('#3618: the nav bridge publishes the motion\'s four methods', () => {
  const mount = read('frontend/src/features/nav/mount.ts');
  for (const method of [
    /collapse\(slug: string, from:/,
    /resumeHandle\(slug: string\)/,
    /takeResumeOrigin\(slug: string\)/,
    /resumeMotionMs: RESUME_MOTION_MS/,
  ]) assert.match(mount, method);
  assert.match(mount, /import \{[\s\S]*?collapseIntoResume, resumeHandleFor, RESUME_MOTION_MS, takeResumeOrigin,/);
});

test('#3618: the router measures before hiding, parks, then collapses into the control', () => {
  const app = read('public/js/app.js');
  // Measure the app view before the hide loop.
  const measure = app.indexOf('App._leavingAppRect = App._runningApp && revealId !== \'app-view\'');
  const hide = app.indexOf('for (const id of App.SCREEN_IDS) {', app.indexOf('_showOnlyScreen(revealId, keepAlso)'));
  assert.ok(measure > 0 && hide > measure, 'the rect is measured before any root is hidden');
  assert.match(app, /!keep\.includes\('app-view'\)/, 'Home keeps the live view for its own shrink');
  assert.match(app, /_appViewRect\(\) \{[\s\S]*?getBoundingClientRect\(\)/);
  assert.match(app, /if \(!\(rect\.width > 0\) \|\| !\(rect\.height > 0\)\) return null;/);

  // Park first (the store flushes), then collapse — and only off Home.
  const park = app.indexOf('bridge.park(left);', app.indexOf('_syncParkedApp(inApp)'));
  const collapse = app.indexOf('bridge.collapse(left.slug, from);', park);
  assert.ok(park > 0 && collapse > park, 'the control is drawn before the stand-in asks where it is');
  assert.match(app, /if \(typeof bridge\.collapse === 'function' && !App\._isScreenVisible\('app-view'\)\) \{/);

  // Home prefers the Resume control over the tile, in the shortened time.
  assert.match(app, /App\._resumeHandleFor\(leavingSlug\) \|\| App\._tileFor\(leavingSlug\)/);
  assert.match(app, /const resumeTarget = leavingSlug \? App\._resumeHandleFor\(leavingSlug\) : null;/);
  assert.match(app, /\.\.\.\(resumeTarget \? \{ duration: App\._resumeMotionMs\(\) \} : null\),/);

  // Resuming takes the pressed origin, once, and grows out of it.
  assert.match(app, /const resumeFrom = window\.UsernodeReact\?\.nav\?\.takeResumeOrigin\?\.\(slug\) \|\| null;/);
  assert.match(app, /fromEl: \(\) => resumeFrom \|\| App\._tileFor\(slug\),/);
  assert.match(app, /\.\.\.\(resumeFrom \? \{ duration: App\._resumeMotionMs\(\) \} : null\),/);
});

test('#3618: the kit accepts a duration and its own timings are untouched', () => {
  const kit = read('public/usernode-native/v1/native.js');
  assert.match(kit, /function zoomDuration\(opts, fallbackMs\) \{[\s\S]*?typeof value === 'function'[\s\S]*?value > 0[\s\S]*?: fallbackMs;/);
  assert.match(kit, /var duration = zoomDuration\(opts, 380\);/);
  assert.match(kit, /var duration = zoomDuration\(opts, 340\);/);
  // Zoom-in: transform and radius at the duration, opacity capped, +120 safety.
  assert.match(kit, /'transform ' \+ duration \+ 'ms ' \+ ZOOM_EASE\s*\n\s*\+ ', opacity ' \+ Math\.min\(duration, 220\) \+ 'ms ease, border-radius ' \+ duration \+ 'ms ease'/);
  assert.match(kit, /setTimeout\(finish, duration \+ 120\);/);
  // Zoom-out: opacity scaled from the old 200/340 pair, +140 safety.
  assert.match(kit, /Math\.round\(duration \* 200 \/ 340\)/);
  assert.match(kit, /Math\.round\(duration \* 60 \/ 340\)/);
  assert.match(kit, /setTimeout\(finish, duration \+ 140\);/);
  // The defaults reproduce the literals exactly.
  assert.match(kit, /Math\.min\(duration, 220\)/);
  assert.match(kit, /ZOOM_EASE/);
});
