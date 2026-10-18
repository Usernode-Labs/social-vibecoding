'use strict';

// #3618 — a running app you stepped out of now ends its Active row with a
// filled Resume button, and the app closes into that button and grows back
// out of it. The phone's Resume pill gets the same fill and the same motion.
//
//   frontend/src/features/nav/resume-motion.ts   the target lookup, the note
//                                                and the shrinking stand-in
//   frontend/src/features/nav/recents-list.tsx   the rail's Resume pill
//   frontend/src/features/nav/parked-strip.tsx   the phone's origin note
//   frontend/src/features/nav/mount.ts           the bridge app.js reads
//   public/js/app.js                             router wiring
//   public/usernode-native/v1/native.js          an optional zoom duration
//   public/css/app.css                           the two pills and the ghost

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  RESUME_EASE, RESUME_FADE_MS, RESUME_MOTION_MS, RESUME_ORIGIN_TTL_MS,
  collapseIntoResume, noteResumeOrigin, poseBetween, rectUsable, resumeHandleFor,
  takeResumeOrigin,
} = loadTsx('frontend/src/features/nav/resume-motion.ts');
const { buildActive } = loadTsx('frontend/src/features/nav/recents.ts');

function recentApp(slug, at, extra = {}) {
  return { slug, name: slug[0].toUpperCase() + slug.slice(1), iconUrl: null, iconEmoji: null, at, ...extra };
}

// ── The rail's rows ───────────────────────────────────────────────────

test('#3618: a running app that is not on screen ends with Resume; the app on screen does not', () => {
  const { ActiveApps } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const items = buildActive({
    live: ['notes', 'chess'],
    current: 'notes',
    apps: [recentApp('notes', '2026-09-20T10:00:00Z'), recentApp('chess', '2026-09-20T09:00:00Z')],
  });
  const html = renderToHtml(createElement(ActiveApps, { items }));
  const rows = html.match(/<a class="platform-recent"[^>]*>[\s\S]*?<\/a>/g);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /aria-label="App: Notes, still open"/);
  assert.doesNotMatch(rows[0], /platform-recent-resume/, 'you are already here');
  assert.match(rows[1], /aria-label="App: Chess, still open"/, 'the row still says it is open');
  assert.match(rows[1], /<span class="platform-recent-resume" aria-hidden="true">Resume<\/span>/,
    'the pill is a label inside the row, not a second target');
  assert.match(rows[1], /class="app-live-dot platform-recent-live"/, 'the dot stays in the markup; CSS is what stands it down');

  // Away from every app (Home, Messages, the app's own Workshop), every
  // running app offers Resume.
  const away = buildActive({
    live: ['notes', 'chess'], current: null,
    apps: [recentApp('notes', '2026-09-20T10:00:00Z'), recentApp('chess', '2026-09-20T09:00:00Z')],
  });
  const awayHtml = renderToHtml(createElement(ActiveApps, { items: away }));
  assert.equal((awayHtml.match(/class="platform-recent-resume"/g) || []).length, 2);
});

test('#3618: a Recents row (an app that is no longer running) has no Resume pill', () => {
  const { RecentsByDay } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const now = Date.parse('2026-09-20T12:00:00Z');
  const html = renderToHtml(createElement(RecentsByDay, {
    items: [{
      key: 'app:dice', kind: 'app', label: 'Dice', href: '/app/dice',
      at: '2026-09-20T10:00:00Z', unread: false,
      app: { slug: 'dice', name: 'Dice', iconUrl: null, iconEmoji: '🎲' },
    }],
    live: [], showOlder: false, onToggleOlder: () => {}, now,
  }));
  assert.match(html, /data-recent-key="app:dice"/);
  assert.doesNotMatch(html, /platform-recent-resume/);
});

// ── Two filled action pills ──────────────────────────────────────────

test('#3618: both pills are the action blue, and the dot steps aside for one', () => {
  const css = read('public/css/app.css');
  const desktopAt = css.indexOf('THE SAME FIVE TABS, STANDING UP');
  const desktop = css.slice(desktopAt);

  const rail = desktop.slice(desktop.indexOf('.platform-recent-resume {'));
  const railRule = rail.slice(0, rail.indexOf('}'));
  assert.match(railRule, /height: 22px;/);
  assert.match(railRule, /padding: 0 9px;/);
  assert.match(railRule, /border-radius: 999px;/);
  assert.match(railRule, /background: var\(--accent\);/);
  assert.match(railRule, /color: var\(--accent-ink\);/);
  assert.match(railRule, /font-size: 12px;/);
  assert.match(railRule, /font-weight: 600;/);
  assert.match(desktop, /\.platform-recent-resume ~ \.platform-recent-live \{\s*display: none;\s*\}/,
    'the green dot and the filled pill would say the same thing');

  // The phone's pill is the same filled button, not the periwinkle label.
  const phone = css.slice(0, desktopAt);
  const pill = phone.slice(phone.indexOf('.platform-parked-pill {'));
  const pillRule = pill.slice(0, pill.indexOf('}'));
  assert.match(pillRule, /border: 0;/);
  assert.match(pillRule, /background: var\(--accent\);/);
  assert.match(pillRule, /color: var\(--accent-ink\);/);
  assert.doesNotMatch(pillRule, /--brand-/, 'no periwinkle left on the phone pill');

  // The stand-in: decorative, above app content, from the card's own origin.
  const ghost = css.slice(css.indexOf('.resume-ghost {'));
  const ghostRule = ghost.slice(0, ghost.indexOf('}'));
  assert.match(ghostRule, /position: fixed;/);
  assert.match(ghostRule, /z-index: 9960;/);
  assert.match(ghostRule, /pointer-events: none;/);
  assert.match(ghostRule, /transform-origin: 0 0;/);
  assert.match(ghostRule, /will-change: transform, opacity;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.resume-ghost \{ display: none; \}\s*\}/);
});

// ── Which control a slug resumes from ────────────────────────────────

function fakeEl({ classes = '', attrs = {}, rect = { left: 0, top: 0, width: 100, height: 100 }, connected = true } = {}) {
  const el = {
    isConnected: connected,
    style: {},
    className: classes,
    children: [],
    anims: [],
    _attrs: attrs,
    _rect: rect,
    _pill: null,
    classList: {
      contains(name) { return (el.className || '').split(/\s+/).includes(name); },
    },
    setAttribute(name, value) { el._attrs[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(el._attrs, name) ? el._attrs[name] : null; },
    hasAttribute(name) { return Object.hasOwn(el._attrs, name); },
    appendChild(child) { el.children.push(child); child.isConnected = true; return child; },
    remove() { el.isConnected = false; },
    querySelector(selector) {
      return el._pill && selector.includes('platform-recent-resume') ? el._pill : null;
    },
    getBoundingClientRect() { return el._rect; },
  };
  return el;
}

function fakeDoc({ rows = [], strip = null, resume = null, reducedMotion = false, viewTransition = false, create } = {}) {
  const documentElement = fakeEl();
  if (viewTransition) documentElement.setAttribute('data-un-vt', '');
  const body = fakeEl();
  return {
    documentElement,
    body,
    defaultView: {
      innerHeight: 800,
      innerWidth: 1000,
      matchMedia: (query) => ({ matches: reducedMotion && query.includes('reduced-motion') }),
      getComputedStyle: () => ({ borderRadius: '999px', getPropertyValue: () => '' }),
    },
    createElement: create || ((tag) => fakeEl({ classes: tag })),
    querySelectorAll: () => rows,
    getElementById(id) {
      if (id === 'platform-parked') return strip;
      if (id === 'platform-parked-resume') return resume;
      return null;
    },
  };
}

function activeRow(slug, { pillRect, rowRect, pillConnected = true } = {}) {
  const row = fakeEl({ attrs: { 'data-recent-key': `app:${slug}` }, rect: rowRect });
  if (pillRect) {
    row._pill = fakeEl({
      classes: 'platform-recent-resume',
      rect: pillRect,
      connected: pillConnected,
    });
  }
  return row;
}

test('#3618: the pill is preferred, then the row, then the phone strip', () => {
  const pillRect = { left: 10, top: 100, width: 60, height: 22 };
  const rowRect = { left: 0, top: 90, width: 210, height: 34 };
  const withPill = activeRow('chess', { pillRect, rowRect });
  const doc = fakeDoc({ rows: [withPill] });
  assert.equal(resumeHandleFor('chess', doc), withPill._pill);

  const withoutPill = activeRow('chess', { rowRect });
  assert.equal(resumeHandleFor('chess', fakeDoc({ rows: [withoutPill] })), withoutPill);

  // A pill that is gone from the screen falls through to the row it belongs to.
  const disconnected = activeRow('chess', { pillRect, rowRect, pillConnected: false });
  assert.equal(resumeHandleFor('chess', fakeDoc({ rows: [disconnected] })), disconnected);

  // A row with no size (the rail folded to 0) answers null.
  const folded = activeRow('chess', { rowRect: { left: 0, top: 90, width: 0, height: 34 } });
  assert.equal(resumeHandleFor('chess', fakeDoc({ rows: [folded] })), null);

  // The phone's strip, while it is drawn, for its own app.
  const strip = fakeEl({ rect: { left: 0, top: 700, width: 390, height: 52 } });
  const resume = fakeEl({ attrs: { href: '/app/chess' } });
  assert.equal(resumeHandleFor('chess', fakeDoc({ strip, resume })), strip);

  // Another app's strip is not this app's control.
  assert.equal(resumeHandleFor('dice', fakeDoc({ strip, resume })), null);

  // A hidden strip is not on screen.
  strip.className = 'platform-parked hidden';
  assert.equal(resumeHandleFor('chess', fakeDoc({ strip, resume })), null);
});

test('#3618: a pressed control is taken once, for its app, while fresh and on screen', () => {
  const el = fakeEl({ rect: { left: 10, top: 100, width: 60, height: 22 } });
  const doc = fakeDoc();
  noteResumeOrigin('chess', el);
  assert.equal(takeResumeOrigin('chess', doc), el);
  assert.equal(takeResumeOrigin('chess', doc), null, 'one press, one grow-out');

  noteResumeOrigin('chess', el);
  assert.equal(takeResumeOrigin('dice', doc), null, 'another app does not inherit the note');
  assert.equal(takeResumeOrigin('chess', doc), null, 'and the note was consumed by asking');

  noteResumeOrigin('chess', el);
  const removed = fakeEl({ rect: { left: 0, top: 0, width: 60, height: 22 }, connected: false });
  noteResumeOrigin('chess', removed);
  assert.equal(takeResumeOrigin('chess', doc), null, 'a row removed from the screen cannot be grown from');

  noteResumeOrigin('chess', el);
  const real = Date.now;
  Date.now = () => real() + RESUME_ORIGIN_TTL_MS + 1;
  try {
    assert.equal(takeResumeOrigin('chess', doc), null, 'a stale origin is a Home-tile fallback');
  } finally {
    Date.now = real;
  }
  assert.equal(RESUME_ORIGIN_TTL_MS, 1500);
});

test('#3618: rect usability and the pose maths', () => {
  assert.equal(rectUsable({ width: 0, height: 10, top: 0, bottom: 10 }), false);
  assert.equal(rectUsable({ width: 10, height: 10, top: -20, bottom: 0 }), false);
  assert.equal(rectUsable({ width: 10, height: 10, top: 900, bottom: 910 }, 800), false);
  assert.equal(rectUsable({ width: 10, height: 10, top: 10, bottom: 20 }, 800), true);
  assert.equal(poseBetween({ left: 0, top: 0, width: 100, height: 50 }, { left: 10, top: 20, width: 50, height: 25 }),
    'translate(10px, 20px) scale(0.5, 0.5)');
  assert.equal(poseBetween({ left: 0, top: 0, width: 0, height: 50 }, { left: 0, top: 0, width: 1, height: 1 }), null);
});

// ── The shrinking stand-in ───────────────────────────────────────────

function ghostFactory() {
  const created = [];
  const create = (tag) => {
    const el = fakeEl({ classes: tag });
    el.tagName = tag;
    el.animate = (frames, options) => {
      const anim = {
        frames, options, listeners: {}, finished: { then() {} },
        addEventListener(name, fn) { (anim.listeners[name] = anim.listeners[name] || []).push(fn); },
        fire(name) { (anim.listeners[name] || []).forEach((fn) => fn()); },
      };
      el.anims.push(anim);
      return anim;
    };
    created.push(el);
    return el;
  };
  return { create, created };
}

if (typeof globalThis.Element === 'undefined') {
  globalThis.Element = function Element() {};
  globalThis.Element.prototype.animate = function animate() { return null; };
}

test('#3618: 250ms into the pill, easing out, with a fade over the last 90ms', () => {
  const pillRect = { left: 10, top: 100, width: 60, height: 22 };
  const rowRect = { left: 0, top: 90, width: 210, height: 34 };
  const row = activeRow('chess', { pillRect, rowRect });
  const ghosts = ghostFactory();
  const doc = fakeDoc({ rows: [row], create: ghosts.create });
  const start = { left: 0, top: 56, width: 1000, height: 744 };

  assert.equal(collapseIntoResume({ slug: 'chess', name: 'Chess', iconEmoji: '♟️' }, start, doc), true);
  assert.equal(ghosts.created.length, 3, 'the card and its icon tile');
  const ghost = ghosts.created[0];
  assert.equal(ghost.className, 'resume-ghost');
  assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.style.position, 'fixed');
  assert.equal(ghost.style.left, '0px');
  assert.equal(ghost.style.top, '56px');
  assert.equal(ghost.style.width, '1000px');
  assert.equal(ghost.style.height, '744px');

  const move = ghost.anims[0];
  assert.equal(move.frames[0].transform, 'none');
  assert.equal(move.frames[1].transform, poseBetween(start, pillRect));
  assert.equal(move.frames[1].borderRadius, '999px', 'landing on the control\'s own corner');
  assert.deepEqual(move.options, { duration: RESUME_MOTION_MS, easing: RESUME_EASE, fill: 'forwards' });
  assert.equal(RESUME_MOTION_MS, 250);

  const fade = ghost.anims[1];
  assert.deepEqual(fade.options, {
    duration: RESUME_FADE_MS, delay: RESUME_MOTION_MS - RESUME_FADE_MS, easing: 'linear', fill: 'forwards',
  });
  assert.equal(RESUME_FADE_MS, 90);

  move.fire('finish');
  assert.equal(ghost.isConnected, false, 'the stand-in removes itself when the move lands');
});

test('#3618: the stand-in is removed by its timer too, and never drawn where motion cannot run', (t) => {
  const pillRect = { left: 10, top: 100, width: 60, height: 22 };
  const rowRect = { left: 0, top: 90, width: 210, height: 34 };
  const start = { left: 0, top: 56, width: 1000, height: 744 };
  const ghosts = ghostFactory();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = fakeDoc({ rows: [activeRow('chess', { pillRect, rowRect })], create: ghosts.create });
  assert.equal(collapseIntoResume({ slug: 'chess', name: 'Chess' }, start, doc), true);
  const ghost = ghosts.created[0];
  assert.equal(ghost.isConnected, true);
  t.mock.timers.tick(RESUME_MOTION_MS + 150);
  assert.equal(ghost.isConnected, false, 'a transitionend that never fires cannot leave the card behind');

  // Reduced motion: nothing is drawn.
  const still = ghostFactory();
  assert.equal(collapseIntoResume({ slug: 'chess' }, start,
    fakeDoc({ rows: [activeRow('chess', { pillRect, rowRect })], create: still.create, reducedMotion: true })), false);
  assert.equal(still.created.length, 0);

  // A View Transition is snapshotting: no second owner of the frame.
  const vt = ghostFactory();
  assert.equal(collapseIntoResume({ slug: 'chess' }, start,
    fakeDoc({ rows: [activeRow('chess', { pillRect, rowRect })], create: vt.create, viewTransition: true })), false);
  assert.equal(vt.created.length, 0);

  // No Resume control on screen: the plain cut.
  const none = ghostFactory();
  assert.equal(collapseIntoResume({ slug: 'chess' }, start, fakeDoc({ create: none.create })), false);
  assert.equal(none.created.length, 0);
});

// ── Wiring ───────────────────────────────────────────────────────────

test('#3618: both Resume presses note their control before opening the app', () => {
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list, /if \(resume\) \{\s*noteResumeOrigin\(\s*slug,\s*event\.currentTarget\.querySelector\('\.platform-recent-resume'\) \|\| event\.currentTarget,\s*\);\s*\}/);
  assert.ok(list.indexOf('noteResumeOrigin(') < list.indexOf("window.App?.openAppTab?.(slug, 'app')"),
    'the origin is noted in the same click, before the router runs');
  assert.match(list, /resume=\{!item\.current\}/);

  const strip = read('frontend/src/features/nav/parked-strip.tsx');
  assert.ok(strip.indexOf('noteResumeOrigin(app.slug, ref.current)') < strip.indexOf("window.App?.openAppTab?.(app.slug, 'app')"));

  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount, /collapseIntoResume/);
  assert.match(mount, /resumeHandleFor/);
  assert.match(mount, /takeResumeOrigin/);
  assert.match(mount, /resumeMotionMs: RESUME_MOTION_MS/);
});

test('#3618: the router measures before hiding, parks before collapsing, and matches the duration', () => {
  const app = read('public/js/app.js');
  assert.ok(app.indexOf('App._leavingAppRect = App._appViewRect();') < app.indexOf('App._setScreenVisible(id, false);'),
    'the card is measured while the app view is still painted');
  assert.ok(app.indexOf('bridge.park(left);') < app.indexOf('bridge.collapse?.(left, from)'),
    'the rail row exists before it is measured');
  assert.match(app, /if \(from && !App\._isScreenVisible\('app-view'\)\)/,
    'Home keeps the live view for its own zoom-out');
  assert.match(app, /const handle = leavingSlug \? App\._resumeHandleFor\(leavingSlug\) : null;/);
  assert.match(app, /return handle \|\| \(leavingSlug \? App\._tileFor\(leavingSlug\) : null\);/);
  assert.match(app, /duration: \(\) => \(usedResume \? App\._resumeMotionMs\(\) : null\)/);
  assert.match(app, /const resumeFrom = App\._takeResumeOrigin\(slug\);/);
  assert.match(app, /fromEl: \(\) => resumeFrom \|\| App\._tileFor\(slug\)/);
  assert.match(app, /\.\.\.\(resumeFrom \? \{ duration: App\._resumeMotionMs\(\) \} : null\)/);
});

test('#3618: the kit keeps its old timings unless a duration is given', () => {
  const kit = read('public/usernode-native/v1/native.js');
  assert.match(kit, /function zoomDuration\(opts, fallbackMs\) \{/);
  assert.match(kit, /return Number\.isFinite\(ms\) && ms > 0 \? Math\.round\(ms\) : fallbackMs;/);
  assert.match(kit, /typeof value === 'function'\) value = value\(\);/,
    'a function is asked after the source is resolved');
  assert.match(kit, /var inMs = zoomDuration\(opts, 380\);/);
  assert.match(kit, /opacity ' \+ Math\.min\(220, inMs\) \+ 'ms ease/);
  assert.match(kit, /setTimeout\(finish, inMs \+ 120\)/);
  assert.match(kit, /var outMs = zoomDuration\(opts, 340\);/);
  assert.match(kit, /Math\.round\(outMs \* 200 \/ 340\) \+ 'ms ease '/);
  assert.match(kit, /Math\.round\(outMs \* 60 \/ 340\)/);
  assert.match(kit, /setTimeout\(finish, outMs \+ 140\)/);
  // Undefined duration falls back to the timings every other zoom has.
  assert.equal(Math.round(340 * 200 / 340), 200);
  assert.equal(Math.round(340 * 60 / 340), 60);
  assert.equal(Math.min(220, 380), 220);
});

test("#3618: the kept-apps check sees the rail's Resume pill", () => {
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((entry) => entry.id === 'kept-apps.home-dot');
  assert.equal(check.path, '/?demo=1&shot=apps-kept', 'path unchanged');
  assert.match(check.expectSelector,
    /^body:has\(#platform-recents \.platform-active > a\[data-live\]:not\(\[aria-current\]\) > \.platform-recent-resume\) /);
  assert.ok(check.impact.includes('frontend/src/features/nav/**'));
});
