'use strict';

// Kit motion and gesture costs on a phone (usernode-native v1).
//
//   - A spring's clock starts on its first frame, so a slow tap handler
//     never makes a sheet appear part-way up.
//   - A dismissal (sheet, panel, action sheet) ends once the surface is off
//     screen instead of settling an invisible overshoot for ~200ms, so
//     teardown, onDismiss and an action sheet's choice run sooner.
//   - Pull-to-refresh keeps its blocking `touchmove` listener only while a
//     pull can start (the content at its top), so a scroll mid-list is not
//     held for the page's script; the anchor is measured when a pull locks.
//   - The swipe tray is a layer only while it is dragged; the grabber and
//     the backdrop never hand a drag to the browser.
//
// The runtime pieces run for real in a vm with a controlled frame clock,
// the way tests/native-dialog-fade.test.js runs the dialog presenters.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const SRC = read('public/usernode-native/v1/native.js');
const KIT_CSS = read('public/usernode-native/v1/native.css');
const APP_CSS = read('public/css/app.css');
const { physics } = require('../public/usernode-native/v1/native.js');

function section(start) {
  const at = SRC.indexOf(start);
  assert.ok(at >= 0, `section exists: ${start}`);
  const end = SRC.indexOf('\n  /* ', at);
  assert.ok(end > at, `section ends: ${start}`);
  return SRC.slice(at, end);
}

function rule(css, sel) {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at >= 0, `${sel} must exist`);
  return css.slice(at, css.indexOf('\n}', at + 1));
}

// ── The runtime spring, on a frame clock the test owns ──────────────────

function springHarness() {
  const frames = [];
  const context = vm.createContext({
    PRESETS: physics.PRESETS,
    STEP_MS: physics.STEP_MS,
    springStep: physics.springStep,
    isAtRest: physics.isAtRest,
    isExitDone: physics.isExitDone,
    springFrameDelta: physics.springFrameDelta,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    // Creation time must not matter any more: a spring that still read it
    // would integrate 64ms (the clamp) on its first frame here.
    performance: { now: () => 0 },
  });
  vm.runInContext(section('  function resolvePreset(opts) {'), context);
  return {
    spring: context.spring,
    frame(now) {
      const due = frames.splice(0);
      for (const fn of due) fn(now);
      return due.length;
    },
  };
}

function simulated(from, to, preset, ms) {
  return physics.simulateSpring(from, to, 0, physics.PRESETS[preset], ms).samples[ms].x;
}

test('the first frame advances one nominal frame, however late it arrives', () => {
  const h = springHarness();
  const seen = [];
  h.spring((x) => seen.push(x), { from: 0, to: 400, preset: 'sheet' });
  assert.deepEqual(seen, [0], 'the spring paints its start position at once');

  // The tap handler ran for a long time before yielding to the first frame.
  h.frame(5000);
  const first = seen[seen.length - 1];
  assert.ok(Math.abs(first - simulated(0, 400, 'sheet', 16)) < 1e-9,
    `first frame is 16ms of motion (${first.toFixed(2)}px), not the 64ms clamp`);
  assert.ok(first < simulated(0, 400, 'sheet', 40), 'nowhere near part-way up');
  assert.equal(physics.springFrameDelta(5000, null), physics.FRAME_MS);
  assert.ok(Math.abs(physics.FRAME_MS - 1000 / 60) < 1e-9);

  // The carry from the first frame and a real 16.67ms gap: 33 steps in all.
  h.frame(5000 + 1000 / 60);
  assert.ok(Math.abs(seen[seen.length - 1] - simulated(0, 400, 'sheet', 33)) < 1e-9);
});

test('later frames keep the 64ms clamp', () => {
  assert.equal(physics.springFrameDelta(1000, 990), 10);
  assert.equal(physics.springFrameDelta(2000, 1000), physics.MAX_FRAME_GAP_MS);
  assert.equal(physics.MAX_FRAME_GAP_MS, 64);
  const h = springHarness();
  const seen = [];
  h.spring((x) => seen.push(x), { from: 0, to: 400, preset: 'sheet' });
  h.frame(100);
  h.frame(100 + 1000); // a background tab: one second later
  // 16.67 + 64 = 80.67ms of integration, i.e. 80 steps.
  assert.ok(Math.abs(seen[seen.length - 1] - simulated(0, 400, 'sheet', 80)) < 1e-9);
});

test('the runtime spring source starts its clock on the first frame', () => {
  const body = section('  function resolvePreset(opts) {');
  const spring = body.slice(body.indexOf('function spring(target, opts)'), body.indexOf('function glideGhost('));
  assert.doesNotMatch(spring, /performance\.now\(\)/, 'no creation-time clock');
  assert.match(spring, /var last = null;/);
  assert.match(spring, /acc \+= springFrameDelta\(now, last\);/);
});

// ── A dismissal ends off-screen ─────────────────────────────────────────

function runToRest(h, opts) {
  let restedAt = null;
  const seen = [];
  h.spring((x) => seen.push(x), { ...opts, onRest: () => { restedAt = t; } });
  let t = 0;
  while (restedAt == null && t < 3000) { t += 1000 / 60; h.frame(t); }
  return { restedAt, seen };
}

test('a dismissal ends once the surface has left the screen, well before the old rest', () => {
  for (const height of [200, 400, 800]) {
    const exit = runToRest(springHarness(), { from: 0, to: height, preset: 'sheet', exit: true });
    const rest = runToRest(springHarness(), { from: 0, to: height, preset: 'sheet' });
    assert.ok(exit.restedAt != null && rest.restedAt != null);
    assert.ok(rest.restedAt - exit.restedAt >= 150,
      `${height}px: the exit ends ${Math.round(rest.restedAt - exit.restedAt)}ms sooner (${Math.round(exit.restedAt)}ms vs ${Math.round(rest.restedAt)}ms)`);
    assert.equal(exit.seen[exit.seen.length - 1], height, 'it lands exactly on the off-screen target');
    const before = exit.seen[exit.seen.length - 2];
    assert.ok(height - before > 0, 'the last frame before the end was still on its way out');
  }
});

test('the pure exit check: within a pixel of the target, moving toward it, or past it', () => {
  const done = (x, v, from, to) => physics.isExitDone({ x, v }, from, to);
  assert.equal(physics.EXIT_DELTA, 1);
  assert.equal(done(399.2, 0.3, 0, 400), true, 'within a pixel, still moving out');
  assert.equal(done(398.5, 0.3, 0, 400), false, 'a pixel and a half short');
  assert.equal(done(400.6, 0.1, 0, 400), true, 'overshooting further off-screen');
  assert.equal(done(399.5, -0.2, 0, 400), false, 'within a pixel but heading back on screen');
  assert.equal(done(-399.5, -0.3, 0, -400), true, 'a left-hand exit, the same in the other direction');
  assert.equal(done(400, 0, 400, 400), true, 'already there');
  // Entrances keep the rest thresholds: a spring toward 0 is not an exit.
  const entrance = physics.simulateSpring(400, 0, 0, physics.PRESETS.sheet);
  assert.ok(Math.abs(entrance.x) < physics.REST_DELTA && Math.abs(entrance.v) < physics.REST_VELOCITY);
  const exit = physics.simulateSpring(0, 400, 0, physics.PRESETS.sheet, 5000, true);
  assert.ok(Math.abs(exit.x - 400) < physics.EXIT_DELTA);
  assert.ok(physics.simulateSpring(0, 400, 0, physics.PRESETS.sheet).durationMs - exit.durationMs >= 150);
});

test('an entrance is unchanged: without `exit` the spring runs to rest', () => {
  const h = springHarness();
  const { restedAt } = runToRest(h, { from: 400, to: 0, preset: 'sheet' });
  const rest = physics.simulateSpring(400, 0, 0, physics.PRESETS.sheet).durationMs;
  assert.ok(Math.abs(restedAt - rest) <= 1000 / 60 + 1, `rests with isAtRest (${Math.round(restedAt)}ms vs ${rest}ms)`);
});

test('sheets, panels and action sheets mark their exit springs, and only those', () => {
  const sheet = SRC.slice(SRC.indexOf('function presentSheet('), SRC.indexOf('function presentModal('));
  assert.match(sheet, /from: y, to: to, velocity: velocity \|\| 0, preset: 'sheet', exit: closed,/,
    'a sheet\'s spring is an exit once it is closed (dismiss and the mid-exit retarget)');
  assert.match(sheet, /closed = true;\s*releaseInput\(backdrop, sheet\);\s*springTo\(height/);
  const panel = SRC.slice(SRC.indexOf('function presentPanel('));
  assert.match(panel.slice(0, panel.indexOf('function teardown()')), /from: x, to: to, preset: 'sheet', exit: closed,/);
  const action = SRC.slice(SRC.indexOf('function actionSheet('));
  assert.match(action.slice(0, action.indexOf('function finishSettle()')),
    /from: y, to: to, velocity: velocity \|\| 0, preset: 'sheet', exit: settled,/);
  // The chosen action's handler runs from the exit spring's onRest.
  assert.match(action, /springTo\(height, 0, finishSettle\)/);
  assert.match(action, /function finishSettle\(\) \{[\s\S]*?if \(settleAction && settleAction\.handler\) settleAction\.handler\(\);/);
  assert.equal((SRC.match(/exit: (closed|settled)/g) || []).length, 3, 'no other spring is an exit');
});

// ── Pull-to-refresh: the blocking listener only while a pull can start ──

function el(extra = {}) {
  const listeners = new Map();
  const node = {
    nodeType: 1,
    style: {},
    rectReads: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners,
    addEventListener(type, fn, options) {
      const list = listeners.get(type) || [];
      list.push({ fn, options });
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((l) => l.fn !== fn));
    },
    count(type) { return (listeners.get(type) || []).length; },
    options(type) { return (listeners.get(type) || [])[0]?.options; },
    emit(type, event) { for (const l of [...(listeners.get(type) || [])]) l.fn(event); },
    getBoundingClientRect() { node.rectReads++; return { top: 60, bottom: 700, left: 0, right: 390, width: 390, height: 640 }; },
    appendChild(child) { return child; },
    insertBefore(child) { return child; },
    contains: () => false,
    ...extra,
  };
  return node;
}

function ptrHarness({ mode = 'element', getScrollTop } = {}) {
  const win = el({ nodeType: undefined, scrollY: 0 });
  const html = el();
  const body = el();
  const parent = el();
  const scroller = el({ scrollTop: 0, parentNode: parent });
  const springs = [];
  const document = {
    scrollingElement: html,
    documentElement: html,
    body,
    createElement: () => el(),
  };
  const context = vm.createContext({
    platform: 'ios',
    window: win,
    document,
    console,
    getComputedStyle: () => ({ position: 'relative' }),
    firstContentChild: () => el(),
    haptic() {},
    spring(apply, opts) {
      const handle = { opts, stopped: false, stop() { handle.stopped = true; }, current: () => ({ x: opts.from, v: 0 }) };
      springs.push(handle);
      return handle;
    },
    gestures: physics.createArbiter(),
    lockIntent: physics.lockIntent,
    rubberband: physics.rubberband,
    rubberbandInvert: physics.rubberbandInvert,
    estimateVelocity: physics.estimateVelocity,
    decidePtrRelease: physics.decidePtrRelease,
    ptrPuckOffset: physics.ptrPuckOffset,
    PTR_THRESHOLD: physics.PTR_THRESHOLD,
    PTR_LIMIT: physics.PTR_LIMIT,
    PTR_HOLD: physics.PTR_HOLD,
    PTR_LAYER_H: physics.PTR_LAYER_H,
    PTR_COEFF: 0.8,
    PTR_MIN_HOLD_MS: 500,
    PTR_SETTLE_HOLD_MS: 500,
    setTimeout: () => 0,
    clearTimeout() {},
    Promise,
  });
  vm.runInContext(section('  function attachPullToRefresh(scrollEl, onRefresh, opts) {'), context);
  let reads = 0;
  const opts = getScrollTop ? { getScrollTop: () => { reads++; return getScrollTop(); } } : undefined;
  const target = mode === 'window' ? win : scroller;
  const handle = context.attachPullToRefresh(target, () => Promise.resolve(), opts);
  const listen = mode === 'window' ? win : scroller;
  return {
    handle, win, scroller, parent, springs, listen,
    reads: () => reads,
    bound: () => listen.count('touchmove'),
    scrollTo(top) {
      if (mode === 'window') { win.scrollY = top; win.emit('scroll', { target: document }); }
      else { scroller.scrollTop = top; scroller.emit('scroll', { target: scroller }); }
    },
    touch(type, y, extra = {}) {
      const event = {
        touches: type === 'touchend' ? [] : [{ clientX: 100, clientY: y }],
        timeStamp: extra.t || 0,
        prevented: false,
        preventDefault() { event.prevented = true; },
      };
      listen.emit(type, event);
      return event;
    },
  };
}

test('at the top the blocking touchmove is there before the finger lands', () => {
  const h = ptrHarness();
  assert.equal(h.bound(), 1);
  assert.equal(h.listen.options('touchmove').passive, false, 'non-passive, so a pull can preventDefault');
  assert.equal(h.listen.options('touchstart').passive, true);
  assert.equal(h.scroller.options('scroll').passive, true, 'the scroll listener that moves it never blocks');
});

test('scrolled away from the top, scrolling is never held for the script', () => {
  const h = ptrHarness();
  h.scrollTo(120);
  assert.equal(h.bound(), 0, 'off as soon as the content leaves the top');
  for (const top of [300, 900, 40]) h.scrollTo(top);
  assert.equal(h.bound(), 0, 'and stays off mid-list');
  h.scrollTo(0);
  assert.equal(h.bound(), 1, 'back at the top, back on for the next pull');
  h.scrollTo(-12); // iOS rubber-band above the top
  assert.equal(h.bound(), 1);
});

test('touchstart re-checks an offset that changed with no scroll event', () => {
  const h = ptrHarness();
  h.scrollTo(500);
  assert.equal(h.bound(), 0);
  h.scroller.scrollTop = 0; // a re-render put the list back at its top
  h.touch('touchstart', 100);
  assert.equal(h.bound(), 1);
  h.touch('touchend', 100);
  assert.equal(h.bound(), 1, 'a tap at the top leaves it on');
});

test('a touch that scrolls away from the top takes it off', () => {
  const h = ptrHarness();
  h.touch('touchstart', 300, { t: 0 });
  h.touch('touchmove', 200, { t: 16 }); // finger up: a scroll, not a pull
  h.scrollTo(100);
  assert.equal(h.bound(), 0, 'off with the first scroll event once the touch is not a pull');

  // Before the intent lock the touch might still become a pull, so a scroll
  // event keeps it; with no momentum no later event comes, and touchend
  // takes it off.
  const g = ptrHarness();
  g.touch('touchstart', 300, { t: 0 });
  g.scrollTo(4);
  assert.equal(g.bound(), 1, 'kept while an undecided touch is down');
  g.touch('touchend', 300, { t: 32 });
  assert.equal(g.bound(), 0, 'off at touchend');
});

test('a pull from the top behaves as before, and only then measures the anchor', () => {
  const h = ptrHarness();
  const before = h.scroller.rectReads + h.parent.rectReads;
  h.touch('touchstart', 100, { t: 0 });
  assert.equal(h.scroller.rectReads + h.parent.rectReads, before, 'a touch alone reads no geometry');
  const small = h.touch('touchmove', 105, { t: 16 });
  assert.equal(small.prevented, false, 'under the intent lock nothing is claimed');
  assert.equal(h.scroller.rectReads + h.parent.rectReads, before);
  const pull = h.touch('touchmove', 180, { t: 32 });
  assert.equal(pull.prevented, true, 'a locked pull still owns the gesture');
  assert.ok(h.scroller.rectReads + h.parent.rectReads > before, 'the anchor is measured once the pull locks');
  assert.match(h.scroller.style.transform, /^translateY\(\d/, 'the content follows the finger');
  h.touch('touchend', 180, { t: 48 });
  assert.equal(h.springs.length, 1, 'released into a spring (a refresh or a retract)');
  // The settle keeps the listener even if an offset reads non-zero meanwhile.
  h.scrollTo(30);
  assert.equal(h.bound(), 1, 'a pull\'s settle is still in flight');
});

test('a touch that starts mid-list never measures or claims', () => {
  const h = ptrHarness();
  h.scrollTo(400);
  const before = h.scroller.rectReads + h.parent.rectReads;
  h.touch('touchstart', 100);
  h.touch('touchend', 100);
  assert.equal(h.scroller.rectReads + h.parent.rectReads, before);
  assert.equal(h.bound(), 0);
});

test('mid-list scroll events do not consult the scroll-owner reader', () => {
  let top = 0;
  const h = ptrHarness({ getScrollTop: () => top });
  assert.equal(h.win.count('scroll'), 1, 'a page that may scroll the document is watched there too');
  top = 200; h.scrollTo(200);
  assert.equal(h.bound(), 0);
  const settled = h.reads();
  for (const y of [260, 340, 420, 500]) { top = y; h.scrollTo(y); }
  assert.equal(h.reads(), settled, 'one cheap offset read per event while nothing changes');
  top = 0; h.scrollTo(0);
  assert.equal(h.bound(), 1);
});

test('window mode follows the document scroll', () => {
  const h = ptrHarness({ mode: 'window' });
  assert.equal(h.bound(), 1);
  h.scrollTo(300);
  assert.equal(h.bound(), 0);
  h.scrollTo(0);
  assert.equal(h.bound(), 1);
});

test('detach removes every listener it added', () => {
  const h = ptrHarness({ getScrollTop: () => 0 });
  h.handle.detach();
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'scroll']) {
    assert.equal(h.scroller.count(type), 0, `${type} on the scroller`);
  }
  assert.equal(h.win.count('scroll'), 0);
});

// ── CSS: layers and touch-action ────────────────────────────────────────

test('the swipe tray is a layer only while its row is dragged', () => {
  assert.doesNotMatch(rule(KIT_CSS, '.un-swipe-tray'), /will-change/, 'no permanent layer per row');
  assert.match(rule(KIT_CSS, '.un-swipe.un-dragging .un-swipe-tray'), /will-change: transform;/);
  // `.un-dragging` spans the drag: added at the axis lock, removed on release.
  const swipe = SRC.slice(SRC.indexOf('function attachSwipeActions('));
  assert.match(swipe, /if \(axis === 'x'\) \{[\s\S]*?wrap\.classList\.add\('un-dragging'\);/);
  assert.match(swipe, /function onPointerEnd\(e\) \{[\s\S]*?wrap\.classList\.remove\('un-dragging'\);/);
});

test('the grabber and the backdrop never hand a drag to the browser', () => {
  assert.match(rule(KIT_CSS, '.un-sheet-grabber'), /touch-action: none;/,
    'a drag from the grabber is the sheet\'s even inside a `pan-y` sheet');
  assert.match(APP_CSS, /\.un-sheet:has\(#notifications-sheet\),\n\.un-sheet:has\(#messages-sheet\) \{\n  touch-action: pan-y;/,
    'the host really does let some sheets pan, which is why the grabber needs its own');
  assert.match(rule(KIT_CSS, '.un-backdrop'), /touch-action: none;/,
    'dragging on the dim does not scroll the page behind');
  // Tap-to-dismiss is a click, which touch-action does not withhold; the
  // backdrop still dismisses through onBackdropDismiss's pointerdown + click.
  const dismiss = SRC.slice(SRC.indexOf('function onBackdropDismiss('));
  assert.match(dismiss, /backdrop\.addEventListener\('pointerdown', press\);/);
  assert.match(dismiss, /backdrop\.addEventListener\('click', function \(e\) \{/);
});
