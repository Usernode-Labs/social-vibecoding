'use strict';

// #3618: an app you close collapses into its Resume control, and grows back
// out of it when you resume — the app's tile among the desktop strip's
// recent apps (#4417; it was the rail's Active row and its Resume pill), the
// strip above the tab bar on the phone (#platform-parked).
// frontend/src/features/nav/resume-motion.ts has the argument; these pin the
// pieces: the tile, the target, the stand-in, the router's wiring and the
// kit's duration option.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const motion = loadTsx('frontend/src/features/nav/resume-motion.ts');

// ── The tile ──────────────────────────────────────────────────────────

test('a running app you left is on the strip with the still-open dot; pressing its tile notes it as the origin', () => {
  const src = read('frontend/src/features/nav/strip-apps.tsx');
  assert.match(src, /onClick=\{\(event\) => onAppClick\(event, app\.slug, running && !lit\)\}/,
    'a running app you are not in grows back out of its tile; the app you are in has nothing to resume');
  assert.match(src, /if \(live\) noteResumeOrigin\(slug, event\.currentTarget\.querySelector\('\.platform-strip-tile'\) \|\| event\.currentTarget\);/);
  assert.match(src, /\{running \? <LiveAppDot className="platform-strip-live" \/> : null\}/);
});

test('Resume is an action: the accent, filled, on the phone strip', () => {
  const css = read('public/css/app.css');

  const strip = css.slice(css.indexOf('\n.platform-parked-pill {'));
  const rule = strip.slice(0, strip.indexOf('}'));
  assert.match(rule, /background: var\(--accent\);/);
  assert.match(rule, /color: var\(--accent-ink\);/);
  assert.doesNotMatch(rule, /--brand-/, 'the periwinkle is the header\'s ink and nothing else');
});

// ── The target ────────────────────────────────────────────────────────

function fakeEl({ rect, attrs = {}, classes = [], children = {} } = {}) {
  const cls = new Set(classes);
  return {
    isConnected: true,
    getBoundingClientRect: () => rect || { left: 0, top: 0, width: 0, height: 0, bottom: 0 },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelector: (sel) => children[sel] || null,
    classList: { contains: (c) => cls.has(c) },
  };
}

function fakeDoc({ rows = [], byId = {}, vt = false, reduced = false } = {}) {
  const appended = [];
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: (q) => ({ matches: reduced && /reduce/.test(q) }),
    setTimeout: (fn) => { win.timers.push(fn); return win.timers.length; },
    clearTimeout() {},
    timers: [],
  };
  return {
    defaultView: win,
    appended,
    documentElement: { hasAttribute: (k) => vt && k === 'data-un-vt' },
    querySelectorAll: (sel) => (/platform-strip-apps/.test(sel) ? rows : []),
    getElementById: (id) => byId[id] || null,
    body: { appendChild: (el) => { appended.push(el); el.isConnected = true; } },
    createElement: (tag) => {
      const el = {
        tag,
        style: {},
        attrs: {},
        children: [],
        className: '',
        textContent: '',
        isConnected: false,
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { this.children.push(c); },
        remove() { this.isConnected = false; el.removed = true; },
        animations: [],
        animate(frames, opts) { const a = { frames, opts }; el.animations.push(a); return a; },
      };
      return el;
    },
  };
}

const PILL = { left: 150, top: 120, width: 60, height: 22, bottom: 142 };
const ROW = { left: 8, top: 116, width: 208, height: 34, bottom: 150 };

test('the target is the app\'s tile on the strip, then its row, then the phone strip', () => {
  const pill = fakeEl({ rect: PILL });
  const row = fakeEl({ rect: ROW, attrs: { 'data-strip-app': 'chess' }, children: { '.platform-strip-tile': pill } });
  const other = fakeEl({ rect: ROW, attrs: { 'data-strip-app': 'notes' } });
  assert.equal(motion.resumeHandleFor('chess', fakeDoc({ rows: [other, row] })), pill);
  assert.equal(motion.resumeHandleFor('notes', fakeDoc({ rows: [other, row] })), other, 'no tile drawn: the row');
  assert.equal(motion.resumeHandleFor('dice', fakeDoc({ rows: [other, row] })), null);

  // A folded strip draws no apps: nothing to land on.
  const hiddenRow = fakeEl({ attrs: { 'data-strip-app': 'chess' }, children: { '.platform-strip-tile': fakeEl() } });
  assert.equal(motion.resumeHandleFor('chess', fakeDoc({ rows: [hiddenRow] })), null);

  // The phone: the whole strip, when it offers THIS app and is showing.
  const STRIP = { left: 0, top: 700, width: 390, height: 52, bottom: 752 };
  const strip = fakeEl({ rect: STRIP });
  const open = fakeEl({ attrs: { href: '/app/my%20app' } });
  const phone = fakeDoc({ byId: { 'platform-parked': strip, 'platform-parked-resume': open } });
  assert.equal(motion.resumeHandleFor('my app', phone), strip);
  assert.equal(motion.resumeHandleFor('chess', phone), null, 'another app\'s strip is not this one\'s');
  const hidden = fakeDoc({ byId: { 'platform-parked': fakeEl({ rect: STRIP, classes: ['hidden'] }), 'platform-parked-resume': open } });
  assert.equal(motion.resumeHandleFor('my app', hidden), null);
});

test('a pressed Resume is the zoom\'s origin once, for that app, while fresh', () => {
  const pill = fakeEl({ rect: PILL });
  const doc = fakeDoc();
  motion.noteResumeOrigin('chess', pill);
  assert.equal(motion.takeResumeOrigin('notes', doc), null, 'another app');
  assert.equal(motion.takeResumeOrigin('chess', doc), null, 'and the note is spent either way');
  motion.noteResumeOrigin('chess', pill);
  assert.equal(motion.takeResumeOrigin('chess', doc), pill);
  assert.equal(motion.takeResumeOrigin('chess', doc), null, 'taken once');
  motion.noteResumeOrigin('chess', fakeEl());
  assert.equal(motion.takeResumeOrigin('chess', doc), null, 'a control no longer on screen');
  const realNow = Date.now;
  try {
    motion.noteResumeOrigin('chess', pill);
    Date.now = () => realNow() + motion.RESUME_ORIGIN_TTL_MS + 1;
    assert.equal(motion.takeResumeOrigin('chess', doc), null, 'stale');
  } finally {
    Date.now = realNow;
  }
});

// ── The stand-in ──────────────────────────────────────────────────────

test('closing shrinks a stand-in from where the app was into its tile on the strip, 250ms ease-out, then it goes', () => {
  assert.equal(motion.RESUME_MOTION_MS, 250);
  assert.match(motion.RESUME_EASE, /^cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)$/, 'ease-out');
  const pill = fakeEl({ rect: PILL });
  const row = fakeEl({ rect: ROW, attrs: { 'data-strip-app': 'chess' }, children: { '.platform-strip-tile': pill } });
  const doc = fakeDoc({ rows: [row] });
  const from = { left: 0, top: 56, width: 1280, height: 744 };
  const moved = motion.collapseIntoResume({ slug: 'chess', name: 'Chess', iconEmoji: '♟️' }, from, doc);
  assert.equal(moved, true);
  assert.equal(doc.appended.length, 1);
  const ghost = doc.appended[0];
  assert.equal(ghost.className, 'resume-ghost');
  assert.equal(ghost.attrs['aria-hidden'], 'true');
  assert.deepEqual([ghost.style.left, ghost.style.top, ghost.style.width, ghost.style.height], ['0px', '56px', '1280px', '744px']);
  assert.equal(ghost.children[0].textContent, '♟️', 'the app\'s face, as text');
  const [move, fade] = ghost.animations;
  assert.equal(move.opts.duration, 250);
  assert.equal(move.opts.easing, motion.RESUME_EASE);
  const end = move.frames[move.frames.length - 1];
  const pose = motion.poseBetween(from, PILL);
  assert.equal(end.transform, `translate(${pose.tx}px, ${pose.ty}px) scale(${pose.sx}, ${pose.sy})`);
  assert.equal(move.frames[0].transform, 'none');
  // It fades only as it lands, on the clock rather than the eased curve,
  // leaving the button.
  assert.deepEqual(fade.frames, [{ opacity: 1 }, { opacity: 0 }]);
  assert.equal(fade.opts.delay + fade.opts.duration, 250);
  assert.equal(fade.opts.easing, 'linear');
  assert.ok(fade.opts.delay >= 150, 'visible for most of the move');
  move.onfinish();
  assert.equal(ghost.removed, true);
});

test('the stand-in removes itself even when no animation event ever comes', () => {
  const pill = fakeEl({ rect: PILL });
  const row = fakeEl({ rect: ROW, attrs: { 'data-strip-app': 'chess' }, children: { '.platform-strip-tile': pill } });
  const doc = fakeDoc({ rows: [row] });
  assert.equal(motion.collapseIntoResume({ slug: 'chess' }, null, doc), true, 'no measured rect: under the header, edge to edge');
  const ghost = doc.appended[0];
  assert.equal(ghost.style.width, '1280px');
  doc.defaultView.timers[0]();
  assert.equal(ghost.removed, true);
});

test('nothing moves for reduced motion, a missing button, or a page transition in flight', () => {
  const pill = fakeEl({ rect: PILL });
  const row = () => fakeEl({ rect: ROW, attrs: { 'data-strip-app': 'chess' }, children: { '.platform-strip-tile': pill } });
  const from = { left: 0, top: 56, width: 1280, height: 744 };
  for (const [why, doc] of [
    ['reduced motion', fakeDoc({ rows: [row()], reduced: true })],
    ['no Resume on screen', fakeDoc({ rows: [] })],
    ['a View Transition is drawing snapshots', fakeDoc({ rows: [row()], vt: true })],
  ]) {
    assert.equal(motion.collapseIntoResume({ slug: 'chess' }, from, doc), false, why);
    assert.equal(doc.appended.length, 0, why);
  }
  assert.equal(motion.collapseIntoResume(null, from, fakeDoc({ rows: [row()] })), false);
  const css = read('public/css/app.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.resume-ghost \{ display: none; \}/);
  assert.match(css, /\.resume-ghost \{[^}]*position: fixed;[^}]*pointer-events: none;[^}]*transform-origin: 0 0;/);
});

// ── The wiring ────────────────────────────────────────────────────────

test('the bridge offers the motion to the router', () => {
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount, /collapse\(app[\s\S]{0,400}return collapseIntoResume\(/);
  assert.match(mount, /resumeHandle\(slug: string\) \{\s*return resumeHandleFor\(slug\);/);
  assert.match(mount, /takeResumeOrigin\(slug: string\) \{\s*return takeResumeOrigin\(slug\);/);
  assert.match(mount, /resumeMotionMs: RESUME_MOTION_MS,/);
});

test('pressing Resume notes the control before the router opens the app', () => {
  const strip = read('frontend/src/features/nav/parked-strip.tsx');
  assert.match(strip, /noteResumeOrigin\(app\.slug, ref\.current\);\s*window\.App\?\.openAppTab\?\.\(app\.slug, 'app'\);/);
  const apps = read('frontend/src/features/nav/strip-apps.tsx');
  assert.match(apps, /if \(live\) noteResumeOrigin\([^;]*\);\s*\/\/[^\n]*\n[\s\S]{0,300}\.App\?\.openAppTab\?\.\(slug, 'app'\);/);
});

test('the router measures the app before hiding it and parks it into the button', () => {
  const app = read('public/js/app.js');
  const show = app.slice(app.indexOf('  _showOnlyScreen(revealId, keepAlso) {'));
  const loop = show.indexOf('for (const id of App.SCREEN_IDS)');
  const measure = show.indexOf('App._leavingAppRect = (App._runningApp');
  assert.ok(measure > 0 && measure < loop, 'measured BEFORE the roots are hidden');
  assert.match(show.slice(measure, loop), /revealId !== 'app-view' && !keep\.includes\('app-view'\)/);

  const park = app.slice(app.indexOf('  _syncParkedApp(inApp) {'), app.indexOf('  _parkRecord(slug) {'));
  const at = park.indexOf('bridge.park(left);');
  const collapse = park.indexOf('bridge.collapse(left, from)');
  assert.ok(at > 0 && collapse > at, 'parked first, so the button is drawn, then collapsed into it');
  assert.match(park, /typeof bridge\.collapse === 'function' && !App\._isScreenVisible\('app-view'\)/,
    'only when the app view is gone: Home shrinks the live view itself');
});

test('Home shrinks the live app into its Resume control first, its tile second; resuming grows out of the pressed control', () => {
  const app = read('public/js/app.js');
  const home = app.slice(app.indexOf('  navigateHome(opts) {'));
  const zoom = home.slice(0, home.indexOf('App.updateHash();'));
  assert.match(zoom, /const handle = App\._resumeHandleFor\(leavingSlug\);\s*intoResume = !!handle;\s*return handle \|\| App\._tileFor\(leavingSlug\);/);
  assert.match(zoom, /duration: \(\) => \(intoResume \? App\._resumeMotionMs\(\) : null\),/);

  const nav = app.slice(app.indexOf('const viaTab = App._tabPress === true;'));
  assert.match(nav, /resumeFrom = window\.UsernodeReact\?\.nav\?\.takeResumeOrigin\?\.\(slug\) \|\| null;/);
  assert.match(nav, /fromEl: \(\) => resumeFrom \|\| App\._tileFor\(slug\),\s*duration: resumeFrom \? App\._resumeMotionMs\(\) : null,/);
});

// ── The kit's duration option ─────────────────────────────────────────

const KIT = read('public/usernode-native/v1/native.js');

function runZoom(type, opts) {
  const timers = [];
  const styles = { cssText: '' };
  const el = {
    style: styles,
    getBoundingClientRect: () => ({ top: 56, left: 0, width: 1280, height: 744, bottom: 800 }),
    addEventListener() {},
    removeEventListener() {},
    get offsetHeight() { return 0; },
  };
  const { physics } = require('../public/usernode-native/v1/native.js');
  const context = vm.createContext({
    document: { scrollingElement: { scrollTop: 0, scrollLeft: 0 } }, window: { innerHeight: 800 },
    prefersReducedMotion: false, vtActive: false, zoomCleanup: null,
    ZOOM_EASE: 'ease', ZOOM_RADIUS: '16px',
    zoomPose: physics.zoomPose, zoomRectUsable: physics.zoomRectUsable,
    setTimeout: (fn, ms) => timers.push(ms),
  });
  const start = KIT.indexOf('  function zoomPin(');
  const end = KIT.indexOf('  // Has the document painted', start);
  vm.runInContext(KIT.slice(start, end), context);
  context.zoomTransition(() => {}, type, { el, fromRect: PILL, ...opts });
  return { transition: styles.transition, timers };
}

test('the kit zooms keep the homescreen timing unless a duration is asked for', () => {
  assert.deepEqual(runZoom('zoom-in', {}), {
    transition: 'transform 380ms ease, opacity 220ms ease, border-radius 380ms ease', timers: [500],
  });
  assert.deepEqual(runZoom('zoom-in', { duration: 250 }), {
    transition: 'transform 250ms ease, opacity 220ms ease, border-radius 250ms ease', timers: [370],
  });
  // zoom-out reads its source after `fn`; a function duration is asked then.
  const out = runZoom('zoom-out', { fromEl: () => ({ getBoundingClientRect: () => PILL }), duration: () => 250 });
  assert.equal(out.transition, 'transform 250ms ease, opacity 147ms ease 44ms, border-radius 250ms ease');
  assert.deepEqual(out.timers, [390]);
  const plain = runZoom('zoom-out', { fromEl: () => ({ getBoundingClientRect: () => PILL }), duration: () => null });
  assert.equal(plain.transition, 'transform 340ms ease, opacity 200ms ease 60ms, border-radius 340ms ease');
  assert.deepEqual(plain.timers, [480]);
});

test('a declared check pins a kept app\'s still-open tile on the strip (folded into the kept-apps check)', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find((t) => t.id === 'kept-apps.home-dot');
  assert.equal(check.path, '/?demo=1&shot=apps-kept');
  assert.match(check.expectSelector,
    /^body:has\(#platform-strip-apps > a\.platform-strip-app\[data-live\]:not\(\[aria-current\]\) \.platform-strip-live\) /);
  assert.ok(check.impact.includes('frontend/src/features/nav/**'));
});
