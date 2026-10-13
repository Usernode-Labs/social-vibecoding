'use strict';

// #3319 — "Keep sidebar open in apps": an opt-in, desktop-only preference
// that keeps the rail docked beside a running app.
//
// Pinned here:
//   1. DEFAULT OFF IS THE OLD BEHAVIOUR: nothing stored, an app hides the rail.
//   2. PINNED KEEPS IT: `usernode:rail-pinned` = '1' publishes the rail inside
//      an app on the desktop and puts `rail-pinned` on the body — and never
//      on a phone, where the app keeps the whole screen.
//   3. STORAGE THAT THROWS READS AS OFF.
//   4. THE CSS IS SCOPED TO THE DESKTOP BREAKPOINT.
//   5. THE SWITCH writes the key, and its first render is unchecked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const appSource = read('public/js/app.js');
const css = read('public/css/app.css');

function harness({ stored = null, phone = false, throws = false } = {}) {
  const store = new Map(stored == null ? [] : [['usernode:rail-pinned', stored]]);
  const classes = new Set();
  const localStorage = throws
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} }
    : {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      body: {
        classList: {
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
        },
      },
    },
    addEventListener() {},
    matchMedia: () => ({ matches: !phone, addEventListener() {} }),
    localStorage,
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  context.UsernodeReact = { nav: { setScreen() {} } };
  App.currentTab = 'app';
  return { App, store, classes, shown: () => App.Visibility.read('platform-tabs') };
}

test('default off: an open app still covers the rail', () => {
  const { App, classes, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false, 'nothing stored is the old behaviour');
  assert.equal(classes.has('rail-pinned'), false);
});

test('pinned: the rail stays beside a running app on the desktop', () => {
  const { App, classes, shown } = harness({ stored: '1' });
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), true);
  assert.equal(classes.has('rail-pinned'), true);
  // Leaving the app takes the class with it; the rail is up as always.
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  assert.equal(classes.has('rail-pinned'), false);
});

test('pinned does not reach the phone, chromeless, or the app\'s Workshop', () => {
  const phone = harness({ stored: '1', phone: true });
  phone.App._syncPlatformTabs('app-view');
  assert.equal(phone.shown(), false, 'a phone\'s app keeps the whole screen');
  assert.equal(phone.classes.has('rail-pinned'), false);

  const { App, classes, shown } = harness({ stored: '1' });
  App.setChromeless(true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false, 'chromeless still takes the rail');
  App.setChromeless(false);
  App.currentTab = 'dev';
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), true, 'the app\'s Workshop has its rail anyway');
  assert.equal(classes.has('rail-pinned'), false, 'but it is not the pinned case');
});

test('storage that throws reads as off', () => {
  const { App, shown } = harness({ throws: true });
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false);
  assert.doesNotThrow(() => App.setRailPinned(true));
});

test('setRailPinned writes the key and re-decides at once', () => {
  const { App, store, shown } = harness();
  // The router has revealed the app; the switch re-decides for that screen.
  App._revealedScreen = 'app-view';
  App._syncPlatformTabs();
  assert.equal(shown(), false);
  App.setRailPinned(true);
  assert.equal(store.get('usernode:rail-pinned'), '1');
  assert.equal(shown(), true);
  App.setRailPinned(false);
  assert.equal(store.has('usernode:rail-pinned'), false);
  assert.equal(shown(), false);
});

test('the pinned frame rule lives only inside the desktop breakpoint', () => {
  const at = css.indexOf('body.rail-pinned:has(');
  assert.ok(at > 0, 'app.css has the pinned #app-view rule');
  assert.equal(css.match(/body\.rail-pinned/g).length, 1, 'one rule, not scattered overrides');
  const open = css.lastIndexOf('@media (min-width: 768px) {', at);
  assert.ok(open > 0, 'inside a min-width: 768px block');
  // No closing brace at column 0 between the media query and the rule: the
  // rule is still inside that block.
  assert.doesNotMatch(css.slice(open, at), /\n\}/);
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /#app-view\s*\{[^]*padding-left:\s*var\(--platform-rail-w, 0px\)/);
  assert.match(rule, /padding-right:\s*0/);
});

test('the Settings switch renders unchecked, desktop only, and writes through App', () => {
  const html = renderComponent('frontend/src/features/settings/sections/theme.tsx', 'ThemeSection', {});
  const at = html.indexOf('id="settings-rail-pinned"');
  assert.ok(at > 0, 'the switch is in Settings → Theme');
  const input = html.slice(html.lastIndexOf('<input', at), html.indexOf('>', at) + 1);
  assert.doesNotMatch(input, /checked/, 'the prerender is unchecked; the stored value arrives in an effect');
  assert.match(html, /Keep sidebar open in apps/);
  assert.match(html, /class="hidden md:block[^"]*"[^>]*>\s*<label/, 'hidden below 768px');

  const src = read('frontend/src/features/settings/sections/theme.tsx');
  assert.match(src, /RAIL_PINNED_KEY = 'usernode:rail-pinned'/);
  assert.match(src, /window\.App\.setRailPinned\(on\)/);
  assert.match(appSource, /RAIL_PINNED_KEY: 'usernode:rail-pinned'/, 'the same key on both sides');
});
