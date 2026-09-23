'use strict';

// #2896, #2775 — on the phone a page or tab change SWAPS IN PLACE.
//
// The kit's push/pop slid the whole page sideways, and on the phone which way
// a change slid was never consistent: the same tab came in from the right one
// time and the left the next, depending on which caller asked and what it
// guessed about depth. The decision was to remove the slides on the phone
// rather than fix their direction, so every transition below the 768px
// layout breakpoint runs 'none' — which is what the desktop rail has done
// since #2843/#2900. The zooms (an app growing out of its tile) are not page
// slides and stay; so does the tab bar's sliding marker (#2849), which is the
// bar's own and never went through PlatformUI.transition.
//
// Run with: node --test tests/phone-no-page-slides.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function load({ wide }) {
  const asked = [];
  const window = {
    matchMedia: (q) => ({ matches: q === '(min-width: 768px)' ? wide : false }),
    unNative: { toast() {}, transition(fn, opts) { asked.push(opts); fn(); } },
  };
  window.window = window;
  const context = vm.createContext({ window, document: { addEventListener() {} }, console });
  vm.runInContext(read('public/js/platform-ui.js'), context);
  return { PlatformUI: window.PlatformUI, asked };
}

test('on the phone every push and pop reaches the kit as a cut', () => {
  const { PlatformUI, asked } = load({ wide: false });
  for (const type of ['push', 'pop']) {
    let ran = false;
    PlatformUI.transition(() => { ran = true; }, { type });
    assert.equal(ran, true, 'the navigation itself still runs');
    assert.equal(asked.at(-1).type, 'none', `${type} is 'none' on the phone`);
  }
});

test('on the phone a zoom still zooms, but its fallback is a cut, not a slide', () => {
  const { PlatformUI, asked } = load({ wide: false });
  PlatformUI.transition(() => {}, { type: 'zoom-in', fallback: 'push' });
  assert.deepEqual({ ...asked.at(-1) }, { type: 'zoom-in', fallback: 'none' });
  PlatformUI.transition(() => {}, { type: 'zoom-out' });
  assert.equal(asked.at(-1).type, 'zoom-out');
  assert.equal(asked.at(-1).fallback, 'none', 'the kit\'s implicit pop fallback is a cut too');
  PlatformUI.transition(() => {}, { type: 'zoom-out', fallback: 'none' });
  assert.equal(asked.at(-1).fallback, 'none');
});

test('the desktop keeps the motion it had', () => {
  const { PlatformUI, asked } = load({ wide: true });
  PlatformUI.transition(() => {}, { type: 'push' });
  assert.equal(asked.at(-1).type, 'push', 'a drill-in on the desktop still pushes');
  PlatformUI.transition(() => {}, { type: 'zoom-in', fallback: 'push' });
  assert.equal(asked.at(-1).fallback, 'push');
});

test('the kit\'s native iOS parallax is left for the tablet layout, not the phone', () => {
  // Pinned so the CSS is not mistaken for dead: an iPad in the native shell is
  // at or above the breakpoint, where drill-ins still push.
  assert.match(read('public/css/app.css'), /un-vt-native-ios-parallax-out-left/);
});
