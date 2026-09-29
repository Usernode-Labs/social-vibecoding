const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(globals = {}, prepare = () => {}) {
  const callbacks = new Map(), observers = [], events = new Map();
  let next = 0, reads = 0;
  const style = {
    visibility: 'hidden', display: 'block', zIndex: '50', opacity: '1',
    borderTopLeftRadius: '28px', borderTopRightRadius: '0px',
    borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px', outlineStyle: 'none',
  };
  const surface = {
    // Any lifted right-edge rail; #improve-panel was the example until its
    // panel retired (#2718 review). The id is a label here, nothing reads it.
    id: 'notifications-sheet', isConnected: true, offsetWidth: 320, offsetHeight: 800,
    classList: { contains: () => false }, dataset: {},
    getBoundingClientRect() { reads++; return { left: 80, top: 0, right: 400, bottom: 800, width: 320, height: 800 }; },
    getAnimations: () => [],
    addEventListener: (e, f) => events.set(e, f),
    removeEventListener: e => events.delete(e),
  };
  const backdrop = { getAnimations: () => [] }, paint = { style: {} };
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe(target, opts) { this.target = target; this.opts = opts; }
    disconnect() { this.disconnected = true; }
  }
  const sandbox = {
    requestAnimationFrame(fn) { callbacks.set(++next, fn); return next; },
    cancelAnimationFrame: id => callbacks.delete(id),
    MutationObserver: Observer, ResizeObserver: Observer,
    getComputedStyle: el => el === surface ? style : { opacity: '.4' },
    innerWidth: 400, innerHeight: 800, matchMedia: () => ({ matches: false }),
    addEventListener: (e, f) => events.set('window:' + e, f),
    removeEventListener: e => events.delete('window:' + e),
    ...globals,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/src/lib/overlay-scrim.js'), 'utf8').replace(/export /g, ''), sandbox);
  prepare({ surface, backdrop, paint, style });
  const detach = sandbox.attachOverlayScrim(surface, backdrop, paint);
  return { surface, backdrop, paint, style, observers, events, callbacks, detach,
    scrimBackground: sandbox.scrimBackground,
    reads: () => reads,
    frame() { const work = [...callbacks.values()]; callbacks.clear(); work.forEach(fn => fn()); },
  };
}

test('closed panes do no geometry or frame work on viewport resize', () => {
  const h = harness();
  h.events.get('window:resize')(); h.observers[1].fn();
  assert.equal(h.callbacks.size, 0);
  assert.equal(h.reads(), 0);
  assert.equal(h.paint.style.visibility, 'hidden');
  h.detach();
});

test('opening measures once, coalesces mutations and stops when settled', () => {
  const h = harness(); h.style.visibility = 'visible';
  for (let i = 0; i < 5; i++) h.observers[0].fn();
  assert.equal(h.callbacks.size, 1); h.frame();
  assert.equal(h.reads(), 1);
  assert.equal(h.paint.style.opacity, '.4');
  assert.equal(h.paint.style.zIndex, '50', 'the decoration shares the surface stacking level');
  assert.match(h.paint.style.background, /linear-gradient/);
  assert.equal(h.paint.style.clipPath, undefined, 'Android must not rely on a compound clipping hole');
  assert.equal(h.callbacks.size, 0, 'no idle polling'); h.detach();
});

test('closing animation keeps its decoration until the surface hides', () => {
  const h = harness(); h.style.visibility = 'visible';
  h.surface.getAnimations = () => [{ playState: 'running' }];
  h.observers[0].fn(); h.frame();
  assert.equal(h.paint.style.visibility, 'visible');
  assert.equal(h.callbacks.size, 1);
  h.style.visibility = 'hidden'; h.frame();
  assert.equal(h.paint.style.visibility, 'hidden');
  assert.equal(h.callbacks.size, 0); h.detach();
});

test('the dim reaches the foot of the layout viewport when iOS collapses innerHeight (#2765)', () => {
  // A phone with the on-screen keyboard up: innerHeight has collapsed to the
  // 441px visual viewport while the fixed paint layer still spans the 844px
  // layout viewport, and the dialog rides the band the keyboard panned to.
  const h = harness({ innerHeight: 441, document: { documentElement: { clientHeight: 844 } } });
  h.style.visibility = 'visible';
  h.surface.getBoundingClientRect = () => ({ left: 16, top: 419, right: 374, bottom: 828, width: 358, height: 409 });
  h.observers[0].fn(); h.frame();
  const paint = h.paint.style.background;
  assert.match(paint, /0px 0px \/ 400px 419px no-repeat/, 'the band above the card');
  assert.match(paint, /0px 828px \/ 400px 16px no-repeat/, 'and the strip under it, down to 844 rather than 441');
  assert.match(paint, /0px 419px \/ 16px 409px no-repeat/, 'the gutters run the card\'s whole height');
  h.detach();
});

test('without a document the paint height is innerHeight, as before', () => {
  const h = harness();
  h.style.visibility = 'visible';
  h.observers[0].fn(); h.frame();
  assert.match(h.paint.style.background, /0px 0px \/ 80px 800px no-repeat/);
  h.detach();
});

test('the cutout is placed relative to the paint layer\'s own box (#2822)', () => {
  // The layer reaches a viewport above and below its fixed box (app.css), and
  // with the keyboard up iOS can report both rects shifted: measuring the
  // layer too keeps the hole on the dialog whatever the offset is.
  const h = harness();
  h.paint.getBoundingClientRect = () => ({ left: 0, top: -800, right: 400, bottom: 1600, width: 400, height: 2400 });
  h.style.visibility = 'visible';
  h.surface.getBoundingClientRect = () => ({ left: 16, top: 300, right: 384, bottom: 600, width: 368, height: 300 });
  h.observers[0].fn(); h.frame();
  const paint = h.paint.style.background;
  assert.match(paint, /0px 0px \/ 400px 1100px no-repeat/, 'dim from the layer\'s top down to the dialog');
  assert.match(paint, /0px 1400px \/ 400px 1000px no-repeat/, 'and from under it to the layer\'s foot');
  assert.match(paint, /0px 1100px \/ 16px 300px no-repeat/, 'the gutter beside it, in layer coordinates');
  h.detach();
});

test('a keyboard change on <html> re-measures an open dialog (#2822)', () => {
  // --un-kb-inset and --platform-vv-top MOVE the dialog without resizing it.
  const root = { clientHeight: 800 };
  const h = harness({ document: { documentElement: root } });
  const rootObserver = h.observers[2];
  assert.equal(rootObserver.target, root);
  assert.deepEqual([...rootObserver.opts.attributeFilter], ['style', 'class']);
  rootObserver.fn();
  assert.equal(h.callbacks.size, 0, 'nothing while closed');
  h.style.visibility = 'visible';
  h.observers[0].fn(); h.frame();
  let moved = 0;
  h.surface.getBoundingClientRect = () => { moved++; return { left: 80, top: 200, right: 400, bottom: 800, width: 320, height: 600 }; };
  rootObserver.fn(); h.frame();
  assert.equal(moved, 1);
  assert.match(h.paint.style.background, /0px 0px \/ 400px 200px no-repeat/, 'the hole moved with the dialog');
  h.events.get('window:scroll')(); h.frame();
  assert.equal(moved, 2, 'a page scroll while it is open re-measures too');
  h.detach();
});

test('adopted content does not paint a second scrim', () => {
  const h = harness(); h.style.visibility = 'visible';
  h.surface.classList.contains = c => c === 'platform-sheet-adopted';
  h.observers[0].fn(); h.frame();
  assert.equal(h.reads(), 0); assert.equal(h.paint.style.visibility, 'hidden'); h.detach();
});

test('teardown cancels queued work and releases observers and listeners', () => {
  const h = harness(); h.observers[0].fn();
  h.detach(); h.frame();
  assert.equal(h.callbacks.size, 0); assert.equal(h.reads(), 0);
  assert.ok(h.observers.every(o => o.disconnected)); assert.equal(h.events.size, 0);
});


test('a square full-screen surface needs no dim paint', () => {
  const h = harness();
  assert.equal(h.scrimBackground({ left: 0, top: 0, right: 400, bottom: 800 },
    [[0, 0], [0, 0], [0, 0], [0, 0]], 400, 800), 'none');
  h.detach();
});

test('offscreen surfaces dim the viewport without negative background sizes', () => {
  const h = harness();
  const radii = [[28, 28], [28, 28], [28, 28], [28, 28]];
  for (const box of [
    { left: 0, top: 900, right: 400, bottom: 1200 },
    { left: 0, top: -400, right: 400, bottom: -100 },
    { left: 450, top: 0, right: 850, bottom: 800 },
  ]) {
    const paint = h.scrimBackground(box, radii, 400, 800);
    assert.match(paint, /0px 0px \/ 400px 800px no-repeat/);
    assert.doesNotMatch(paint, /radial-gradient|NaN/);
  }
  h.detach();
});

// QA 2026-09-24 Q25: Group members ended at y=683.75. The strips meeting on
// that fractional row each covered part of it, and the two partial dims
// composited to less than one: a 1px light line across the whole window.
// The hole's edges now snap OUTWARD to device pixels, so the strips tile.
test('QA 2026-09-24 Q25: strips meet on device pixels, the hole snapped outward', () => {
  const h = harness();
  const rect = { left: 496.4, top: 216.25, right: 943.6, bottom: 683.75 };
  const radii = [[16, 16], [16, 16], [16, 16], [16, 16]];
  const strips = (paint) => [...paint.matchAll(/linear-gradient\(var\(--pane-scrim\), var\(--pane-scrim\)\) (-?[\d.]+)px (-?[\d.]+)px \/ ([\d.]+)px ([\d.]+)px/g)]
    .map((m) => m.slice(1, 5).map(Number));
  for (const [dpr, top, bottom, left, right] of [
    [1, 216, 684, 496, 944],
    [2, 216, 684, 496, 944],
    [3, 216, 684, 1489 / 3, 2831 / 3],
  ]) {
    const paint = h.scrimBackground(rect, radii, 1440, 900, dpr);
    const [above, below, west, east] = strips(paint);
    assert.deepEqual(above, [0, 0, 1440, top], `dpr ${dpr}: the strip above ends on the grid`);
    assert.deepEqual(below, [0, bottom, 1440, 900 - bottom], `dpr ${dpr}: the strip below starts on the grid`);
    assert.deepEqual(west.slice(1), [top, left, bottom - top], `dpr ${dpr}: the side strips span exactly between them`);
    assert.deepEqual([east[0], east[1]], [right, top]);
    for (const v of [top, bottom, left, right]) {
      assert.ok(Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6, `dpr ${dpr}: ${v} is a device pixel`);
    }
    assert.ok(top <= rect.top && bottom >= rect.bottom && left <= rect.left && right >= rect.right,
      'the hole is never smaller than the surface');
    // The corner boxes run out to the snapped edges, so nothing is left
    // undimmed between a corner and its strips.
    const corners = [...paint.matchAll(/radial-gradient\(.*?var\(--pane-scrim\) 100%\) (-?[\d.]+)px (-?[\d.]+)px \/ ([\d.]+)px ([\d.]+)px/g)]
      .map((m) => m.slice(1, 5).map(Number));
    assert.equal(corners.length, 4);
    const [tl, , br] = corners;
    assert.deepEqual([tl[0], tl[1]], [left, top]);
    assert.ok(Math.abs(br[0] + br[2] - right) < 1e-9 && Math.abs(br[1] + br[3] - bottom) < 1e-9);
  }
  // Already on the grid: nothing moves.
  const flat = h.scrimBackground({ left: 100, top: 200, right: 300, bottom: 600 }, [[0, 0], [0, 0], [0, 0], [0, 0]], 400, 800, 2);
  assert.match(flat, /0px 600px \/ 400px 200px no-repeat/);
  h.detach();
});

// ── An opaque kit surface lets the kit's backdrop carry the dim ─────────
// The cutout exists so a FROSTED surface does not frost a dimmed page. With
// the glass off (every iPhone; a browser without backdrop-filter) the surface
// is opaque, and the paint layer's per-frame rebuild — a MutationObserver on
// the kit's inline style, a computed-style and rect read and a many-layer
// gradient write on every spring frame, 23-30 per sheet open or close — buys
// nothing. The kit backdrop is marked instead and app.css paints the dim on it.

function classes(...names) {
  const set = new Set(names);
  return { set, contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c) };
}
function kitBackdrop(previous = null) {
  return { classList: classes('un-backdrop'), previousElementSibling: previous, getAnimations: () => [] };
}

test('an opaque surface over a kit backdrop does no observing, scheduling or painting', () => {
  let frameRequests = 0;
  const h = harness({ requestAnimationFrame() { frameRequests++; return 1; } }, ({ backdrop, style }) => {
    Object.assign(backdrop, kitBackdrop());
    style.visibility = 'visible';
    style.backdropFilter = 'none';
    style.webkitBackdropFilter = 'none';
  });
  assert.equal(h.observers.length, 0, 'no MutationObserver, ResizeObserver or <html> observer');
  assert.equal(h.events.size, 0, 'no surface, window or visual-viewport listeners');
  assert.equal(frameRequests, 0, 'nothing scheduled');
  assert.equal(h.reads(), 0, 'no geometry read');
  assert.equal(h.paint.style.background, undefined, 'the gradient is never built');
  assert.equal(h.paint.style.visibility, 'hidden', 'the paint layer stays out of the picture');
  assert.ok(h.backdrop.classList.contains('platform-backdrop-dim'), 'the kit backdrop carries the dim');
  h.detach();
  assert.equal(h.backdrop.classList.contains('platform-backdrop-dim'), false, 'detach undoes the mark');
});

test('a browser without backdrop-filter counts as opaque too', () => {
  const h = harness({}, ({ backdrop }) => { Object.assign(backdrop, kitBackdrop()); });
  // The harness style has neither property, as a browser that lacks them.
  assert.equal(h.observers.length, 0);
  assert.ok(h.backdrop.classList.contains('platform-backdrop-dim'));
  h.detach();
});

test('a frosted surface keeps the cutout exactly as before', () => {
  for (const [prop, value] of [['backdropFilter', 'blur(24px) saturate(1.6)'], ['webkitBackdropFilter', 'blur(24px) saturate(1.6)']]) {
    const h = harness({}, ({ backdrop, style }) => {
      Object.assign(backdrop, kitBackdrop());
      style[prop] = value;
    });
    assert.equal(h.observers.length, 3, `${prop}: surface/backdrop, size and <html> observers`);
    assert.equal(h.backdrop.classList.contains('platform-backdrop-dim'), false, `${prop}: the backdrop stays clear`);
    h.style.visibility = 'visible';
    h.observers[0].fn(); h.frame();
    assert.match(h.paint.style.background, /linear-gradient/, `${prop}: the paint layer cuts the hole`);
    h.detach();
  }
});

test('the decision keys off the surface\'s own computed backdrop filter', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/lib/overlay-scrim.js'), 'utf8');
  assert.match(src, /export const BACKDROP_DIM_CLASS = 'platform-backdrop-dim';/, 'the class app.css styles');
  assert.match(src, /return on\(style\.backdropFilter\) \|\| on\(style\.webkitBackdropFilter\);/);
  assert.match(src, /!drawsBackdropFilter\(getComputedStyle\(surface\)\)/);
  const attach = src.slice(src.indexOf('export function attachOverlayScrim('));
  const early = attach.indexOf('if (dimsWithBackdrop(surface, backdrop))');
  assert.ok(early > 0 && early < attach.indexOf('new MutationObserver'),
    'decided before any observer is created');
});

test('a surface opened over another kit surface keeps the paint layer', () => {
  // The backdrop sits a layer below every kit surface, so it could not dim
  // the sheet underneath; the paint layer, stacked at the new surface's level,
  // does.
  const lower = { classList: classes('un-sheet'), previousElementSibling: null };
  const h = harness({}, ({ backdrop, style }) => {
    Object.assign(backdrop, kitBackdrop({ classList: classes('overlay-scrim'), previousElementSibling: lower }));
    style.backdropFilter = 'none';
  });
  assert.equal(h.observers.length, 3);
  assert.equal(h.backdrop.classList.contains('platform-backdrop-dim'), false);
  h.detach();
});

test('a React rail\'s own backdrop is not taken over', () => {
  const h = harness({}, ({ style }) => { style.backdropFilter = 'none'; });
  assert.equal(h.observers.length, 3, 'the rail path is unchanged');
  h.detach();
});

test('app.css paints the dim on a marked backdrop, over the transparent rule, with the scrim\'s reach', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  const clear = css.indexOf('.un-backdrop:has(+ .un-modal),\n.un-backdrop:has(+ .un-sheet),\n.un-backdrop:has(+ .un-panel) {\n  background: transparent;');
  const at = css.indexOf('\nhtml .un-backdrop.platform-backdrop-dim {');
  assert.ok(clear > 0 && at > clear, 'the dim rule follows the transparent one');
  const body = css.slice(at, css.indexOf('\n}', at));
  assert.match(body, /background: var\(--pane-scrim\);/, 'the scrim\'s own colour');
  assert.match(body, /inset: -100vh 0;/, 'and its reach past a keyboard-panned viewport');
  assert.match(css.slice(css.indexOf('\n.overlay-scrim {')), /^\n\.overlay-scrim \{[^}]*inset: -100vh 0;[^}]*background: var\(--pane-scrim\);/,
    'the same reach and colour as the paint layer it replaces');
});

test('the kit drives the backdrop\'s opacity for sheets, panels and dialogs', () => {
  const kit = fs.readFileSync(path.join(__dirname, '../public/usernode-native/v1/native.js'), 'utf8');
  for (const fn of ['presentSheet', 'presentPanel']) {
    const src = kit.slice(kit.indexOf(`function ${fn}(`));
    const render = src.slice(src.indexOf('function render(val)'), src.indexOf('function springTo'));
    assert.match(render, /backdrop\.style\.opacity = presence;/, `${fn}: the dim rides the position`);
  }
  const modal = kit.slice(kit.indexOf('function presentModal('));
  assert.match(modal, /backdrop\.className = 'un-backdrop un-backdrop-fade';/);
  assert.match(modal, /animateDialog\(card, backdrop,/, 'the dialog\'s backdrop fades with its card');
  const fade = kit.slice(kit.indexOf('function animateDialog('));
  assert.match(fade, /backdrop\.style\.opacity = '1';\s*card\.classList\.add\('un-in'\);/);
  assert.match(fade, /card\.classList\.remove\('un-in'\);\s*backdrop\.style\.opacity = '0';/);
});
