'use strict';
// iPhone Duo (30 Oct 2026): folded, a tap in the top ~62px of the cover never
// becomes a click, in any app. The touches reach the page but iOS fails every
// gesture recognizer there, so the header's controls did not respond.
// frontend/src/lib/top-band-taps.ts finishes those taps itself on the Duo
// layout: one click on the element under the finger, and none from WebKit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const { BAND_PX, TAP_SLOP_PX, TAP_MAX_MS, watchTopBandTaps } = loadTsx('frontend/src/lib/top-band-taps.ts');

// A window and document just big enough for the watcher. `strip` is whether
// <html> carries data-side-strip; `under` is what elementFromPoint finds.
function fakePage({ strip = true } = {}) {
  const listeners = new Map();
  const clicks = [];
  const focused = [];
  const el = (tagName, extra = {}) => ({
    tagName,
    dispatchEvent: (ev) => { clicks.push({ tagName, type: ev.type, x: ev.clientX, y: ev.clientY }); return true; },
    focus: () => focused.push(tagName),
    ...extra,
  });
  const page = { under: el('BUTTON') };
  const doc = {
    documentElement: { hasAttribute: (n) => strip && n === 'data-side-strip' },
    elementFromPoint: () => page.under,
  };
  const win = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    MouseEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  const touch = (x, y, id = 1) => ({ identifier: id, clientX: x, clientY: y, screenX: x, screenY: y });
  const fire = (type, { touches = [], changed = [], at = 0 } = {}) => {
    let prevented = false;
    const ev = {
      type, touches, changedTouches: changed, timeStamp: at,
      get defaultPrevented() { return prevented; },
      preventDefault: () => { prevented = true; },
    };
    listeners.get(type)?.(ev);
    return prevented;
  };
  const tap = (x, y, { moveTo = null, heldMs = 80 } = {}) => {
    fire('touchstart', { touches: [touch(x, y)], at: 0 });
    const end = moveTo || [x, y];
    if (moveTo) fire('touchmove', { touches: [touch(...end)], at: 10 });
    return fire('touchend', { changed: [touch(...end)], at: heldMs });
  };
  return Object.assign(page, { listeners, clicks, focused, doc, win, el, touch, fire, tap });
}

test('a tap in the band clicks the element under the finger, once', () => {
  const page = fakePage();
  watchTopBandTaps(page.doc, page.win);
  const prevented = page.tap(332, 22);
  assert.equal(prevented, true, 'WebKit adds no click of its own');
  assert.deepEqual(page.clicks, [{ tagName: 'BUTTON', type: 'click', x: 332, y: 22 }]);
});

test('below the band, iOS taps work: nothing is added', () => {
  const page = fakePage();
  watchTopBandTaps(page.doc, page.win);
  assert.equal(page.tap(200, BAND_PX + 1), false);
  assert.equal(page.tap(200, BAND_PX), false, 'the band ends at BAND_PX');
  assert.equal(page.clicks.length, 0);
});

test('a swipe, a long press, a second finger or a cancelled touch is left alone', () => {
  const page = fakePage();
  watchTopBandTaps(page.doc, page.win);
  assert.equal(page.tap(200, 10, { moveTo: [200, 10 + TAP_SLOP_PX + 5] }), false, 'pulling down Notification Center');
  assert.equal(page.tap(200, 10, { heldMs: TAP_MAX_MS + 50 }), false, 'a press');
  page.fire('touchstart', { touches: [page.touch(200, 10, 1), page.touch(260, 10, 2)] });
  assert.equal(page.fire('touchend', { changed: [page.touch(200, 10, 1)], touches: [page.touch(260, 10, 2)], at: 50 }), false, 'two fingers');
  page.fire('touchstart', { touches: [page.touch(200, 10)] });
  page.fire('touchcancel');
  assert.equal(page.fire('touchend', { changed: [page.touch(200, 10)], at: 50 }), false, 'iOS took it');
  assert.equal(page.clicks.length, 0);
});

test('a touch a control already handled is not clicked again', () => {
  const page = fakePage();
  watchTopBandTaps(page.doc, page.win);
  page.fire('touchstart', { touches: [page.touch(200, 10)] });
  const ev = { type: 'touchend', touches: [], changedTouches: [page.touch(200, 10)], timeStamp: 40, defaultPrevented: true, preventDefault() {} };
  page.listeners.get('touchend')(ev);
  assert.equal(page.clicks.length, 0);
});

test('a field in the band is focused, not clicked', () => {
  const page = fakePage();
  page.under = page.el('INPUT', { type: 'search' });
  watchTopBandTaps(page.doc, page.win);
  assert.equal(page.tap(200, 20), true);
  assert.deepEqual(page.focused, ['INPUT']);
  assert.equal(page.clicks.length, 0);
});

test('only on the Duo layout: with no side strip nothing changes', () => {
  const page = fakePage({ strip: false });
  watchTopBandTaps(page.doc, page.win);
  assert.equal(page.tap(332, 22), false);
  assert.equal(page.clicks.length, 0);
});

test('wired in at boot, after the strip it keys on, with a non-passive touchend', () => {
  const main = fs.readFileSync(path.join(ROOT, 'frontend/src/main.tsx'), 'utf8');
  assert.ok(main.indexOf("import './lib/top-band-taps';") > main.indexOf("import './lib/side-strip';"));
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/lib/top-band-taps.ts'), 'utf8');
  assert.match(src, /addEventListener\('touchend', onEnd, \{ passive: false \}\)/, 'preventDefault must be allowed');
  assert.equal(BAND_PX, 64, 'measured: 62 to 65px on the Duo simulator');
});
