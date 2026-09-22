const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  const callbacks = new Map(), observers = [], events = new Map();
  let next = 0, reads = 0;
  const style = {
    visibility: 'hidden', display: 'block', zIndex: '50', opacity: '1',
    borderTopLeftRadius: '28px', borderTopRightRadius: '0px',
    borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px', outlineStyle: 'none',
  };
  const surface = {
    id: 'improve-panel', isConnected: true, offsetWidth: 320, offsetHeight: 800,
    classList: { contains: () => false }, dataset: {},
    getBoundingClientRect() { reads++; return { left: 80, top: 0, right: 400, bottom: 800, width: 320, height: 800 }; },
    getAnimations: () => [],
    addEventListener: (e, f) => events.set(e, f),
    removeEventListener: e => events.delete(e),
  };
  const backdrop = { getAnimations: () => [] }, paint = { style: {} };
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {}
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
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/src/lib/overlay-scrim.js'), 'utf8').replace(/export /g, ''), sandbox);
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
