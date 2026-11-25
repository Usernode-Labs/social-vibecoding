'use strict';
// THE PAGE STAYS PUT WHEN THE KEYS RISE (phone review, 23 November 2026,
// iPhone 17 and the iPhone Duo). Four items of Evan's report:
//
//   #1  typing in a running app panned the whole page up by the keyboard's
//       height: the top bar and Close left the screen, the app's text was
//       drawn under the clock, and the frame kept its full height behind
//       the keys;
//   #14 Settings forms sat behind the keyboard (Change username: the second
//       field and both buttons), and on the final pass the same pan as #1;
//   #13 Home's search with the keys up: matching communities three sections
//       down under unfiltered ones and unreachable, Return did nothing, and
//       the results were headed "Pinned projects";
//   #98 the Messages list: "Oldest chats" on a row's words, the last preview
//       on the tab bar, and the list running on behind the keys.
//
// #1 and #14 are one cause, fixed once: app.css lays the shell on the band
// of the page that is seen ("THE SHELL HOLDS STILL"), and the frame is
// measured against that band (AppView.safeAreaForFrame). What this cannot
// do is raise a real keyboard; the numbers are an iPhone 17's (402x874,
// keys 335px) and the kit's own iOS table (#1938: iOS collapses innerHeight
// to the visual viewport with the keys up).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');
const APP_VIEW_SRC = read('public/js/app-view.js');
const SETTINGS = read('frontend/src/features/settings/index.tsx');
const SIGN_IN_ROW = read('frontend/src/features/settings/sections/sign-in-row.tsx');
const HOME = read('frontend/src/features/home/index.tsx');
const HOME_JS = read('frontend/src/features/home/home.js');
const HOME_EN = JSON.parse(read('frontend/locales/en/home.json'));
const INBOX_TO_END = read('frontend/src/features/messages/inbox-to-end.tsx');
const AppView = require('../public/js/app-view.js');
const surface = loadTsx('frontend/src/lib/keyboard-surface.ts');

/** The body of the CSS rule whose selector list contains `needle`. */
function ruleWith(needle) {
  const at = APP_CSS.indexOf(needle);
  assert.ok(at >= 0, `app.css has a rule naming ${needle}`);
  const open = APP_CSS.indexOf('{', at);
  return APP_CSS.slice(open + 1, APP_CSS.indexOf('}', open));
}

// ── #1 and #14: the shell is laid on the band that is seen ──────────────

test('with the keys up the header starts at the pan and the screen ends on the keys, in the bounded shell', () => {
  const header = ruleWith('body:has(> :is(#app-view[data-app-surface="app"], #settings-screen, #home-screen):not(.hidden)) > #platform-header');
  assert.match(header, /margin-top:\s*var\(--platform-vv-top, 0px\)/,
    'the header rides down with iOS\'s pan, so it stays at the top of the glass');
  const screen = ruleWith('html.un-kb:not([data-browser-scroller]) body > :is(#app-view[data-app-surface="app"], #settings-screen, #home-screen):not(.hidden) {');
  assert.match(screen, /margin-bottom:\s*max\(0px, calc\(var\(--un-kb-inset, 0px\) - var\(--platform-vv-top, 0px\)\)\)/,
    'pan + margin = the keyboard: the screen is shorter by exactly the keys, panned or not');
  // An app with no header (chromeless) takes the pan itself.
  assert.match(APP_CSS, /body:has\(> #platform-header\.hidden\) > #app-view\[data-app-surface="app"\]:not\(\.hidden\)/);
  // Margins, not a transform: a transform would make the screen the
  // containing block of every fixed thing in it.
  assert.doesNotMatch(screen, /transform|translate/);
});

test('in a phone browser Home and Settings are the document: its end is padded by the keys instead', () => {
  const pad = ruleWith('html.un-kb[data-browser-scroller="settings-screen"] #settings-screen');
  assert.match(APP_CSS, /html\.un-kb\[data-browser-scroller="home-screen"\] #home-screen \{/);
  assert.match(pad, /padding-bottom:\s*var\(--un-kb-inset, 0px\) !important/,
    '`html.un-kb .platform-safe-scroll` zeroes this padding, so it has to outrank it');
});

function withPage({ layout, inner, vv, frameRect, kitClasses = [] }, fn) {
  const saved = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle };
  const savedRead = AppView._readRootInsets;
  const frame = { isConnected: true, getBoundingClientRect: () => frameRect, contentWindow: {} };
  global.window = { innerWidth: 402, innerHeight: inner, visualViewport: vv, matchMedia: () => ({ matches: false }) };
  global.document = {
    documentElement: { clientHeight: layout, classList: { contains: (c) => kitClasses.includes(c) } },
    getElementById: (id) => (id === 'app-iframe' ? frame : null),
  };
  AppView._readRootInsets = () => ({ top: 62, right: 0, bottom: 34, left: 0, maxBottom: 0 });
  try {
    return fn();
  } finally {
    AppView._readRootInsets = savedRead;
    Object.assign(global, saved);
  }
}
const box = (top, bottom) => ({ top, bottom, left: 0, right: 402, width: 402, height: bottom - top });

test('#1: the frame on the band is told no keyboard covers it, and its top is measured against the pan', () => {
  // iOS, the keys up and the page panned by their height: innerHeight has
  // collapsed to the visual viewport, the layout viewport has not. The shell
  // has put the header at the pan and ended the frame on the keys.
  const ios = { layout: 874, inner: 539, vv: { height: 539, offsetTop: 335, scale: 1 } };
  const laid = withPage({ ...ios, frameRect: box(442, 874) }, () => AppView.safeAreaForFrame('app-iframe'));
  assert.equal(laid.keyboard, 0, 'the frame ends where the keys begin: an app pads for nothing');
  assert.equal(laid.top, 0, 'the header covers the status bar, at the top of the band');
  assert.equal(laid.bottom, 0, 'the home indicator is behind the keys');
  // Chromeless: the frame itself starts at the pan, so the clock is over it.
  const bare = withPage({ ...ios, frameRect: box(335, 874) }, () => AppView.safeAreaForFrame('app-iframe'));
  assert.equal(bare.top, 62, 'the status bar is over the band\'s top, which is the frame\'s');
  // Android: no pan, nothing collapses. The frame ended on the keys too.
  const android = { layout: 874, inner: 874, vv: { height: 539, offsetTop: 0, scale: 1 } };
  assert.equal(withPage({ ...android, frameRect: box(107, 539) }, () => AppView.safeAreaForFrame('app-iframe')).keyboard, 0);
  // A frame that does run on behind the keys is still told how far.
  assert.equal(withPage({ ...android, frameRect: box(107, 874) }, () => AppView.safeAreaForFrame('app-iframe')).keyboard, 335);
  // At rest nothing changes.
  const rest = withPage({ layout: 874, inner: 874, vv: { height: 874, offsetTop: 0, scale: 1 }, frameRect: box(107, 874) },
    () => AppView.safeAreaForFrame('app-iframe'));
  assert.deepEqual(rest, { top: 0, right: 0, bottom: 34, left: 0, keyboard: 0 });
});

test('#1: the pan is read only unzoomed, and a pan re-broadcasts', () => {
  const pan = (vv) => {
    const saved = global.window;
    global.window = { visualViewport: vv };
    try { return AppView._viewportPan(); } finally { global.window = saved; }
  };
  assert.equal(pan({ offsetTop: 335.4, scale: 1 }), 335);
  assert.equal(pan({ offsetTop: 120, scale: 2 }), 0, 'a pinch zoom\'s offset is not a pan');
  assert.equal(pan({ offsetTop: -3, scale: 1 }), 0);
  assert.equal(pan(null), 0);
  assert.deepEqual(AppView._shiftRect(box(442, 874), -335), { ...box(107, 539) });
  const tail = APP_VIEW_SRC.slice(APP_VIEW_SRC.lastIndexOf("window.addEventListener('message'"));
  assert.match(tail, /window\.visualViewport\.addEventListener\('scroll', onViewportChange/,
    'iOS reports the pan in its own event, after the resize');
});

// ── #14: Settings takes the tap and reveals the form with its buttons ───

test('#14: Settings is a keyboard surface where it is its own scroller, and its forms name their buttons', () => {
  assert.match(SETTINGS, /useKeyboardSurface\(screenRef, \{ when: scrollsItself \}\)/);
  assert.match(SETTINGS, /ref=\{screenRef\}\s*\n\s*id="settings-screen"/);
  assert.match(SETTINGS, /function scrollsItself\(\): boolean \{\s*\n\s*return typeof document === 'undefined' \|\| !document\.documentElement\.dataset\.browserScroller;/);
  assert.equal(surface.FORM_GROUP_CLASS, 'kb-form');
  assert.equal(surface.FORM_ACTIONS_CLASS, 'kb-form-actions');
  assert.match(SIGN_IN_ROW, /export const ROW_EDITOR = 'kb-form /);
  assert.match(SIGN_IN_ROW, /export const EDITOR_ACTIONS = 'kb-form-actions /);
});

function rig({ when } = {}) {
  let clock = 0;
  const timers = [];
  const actions = { rect: { top: 559, bottom: 605 } };
  actions.getBoundingClientRect = () => actions.rect;
  const group = { querySelector: (sel) => (sel === '.kb-form-actions' ? actions : null) };
  const doc = { activeElement: null, documentElement: { classList: { contains: () => false } } };
  const field = {
    nodeType: 1, tagName: 'INPUT', type: 'text', form: null, focused: [],
    closest: (sel) => (/input/.test(sel) ? field : sel === '.kb-form' ? group : null),
    getBoundingClientRect: () => ({ top: 459, bottom: 497 }),
    focus(opts) { field.focused.push(opts || null); doc.activeElement = field; },
    blur() { doc.activeElement = null; },
  };
  const listeners = {};
  const scrolls = [];
  const scroller = {
    nodeType: 1, scrollTop: 0, scrollHeight: 1050, clientHeight: 432, children: [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    fire(type, e) { (listeners[type] || []).forEach((fn) => fn(e)); },
    getBoundingClientRect: () => ({ top: 106, bottom: 539 }),
    contains: (n) => n === field || n === actions,
    querySelectorAll: () => [],
    scrollTo({ top }) { scrolls.push(top); scroller.scrollTop = top; },
  };
  const vv = { addEventListener() {}, removeEventListener() {} };
  const { physics } = require('../public/usernode-native/v1/native.js');
  const win = {
    unNative: { platform: 'ios', physics, gestures: { owner: () => null } },
    visualViewport: vv,
    matchMedia: () => ({ matches: false }),
    setTimeout(fn, ms) { timers.push({ fn, due: clock + ms }); return timers.length; },
    clearTimeout() {},
  };
  surface.attachKeyboardSurface(scroller, win, doc, { when });
  const tap = () => {
    const event = { target: field, touches: [], cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
    scroller.fire('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
    scroller.fire('touchend', event);
    return event;
  };
  const advance = (ms) => { clock += ms; timers.filter((t) => t.due <= clock).forEach((t) => { t.due = Infinity; t.fn(); }); };
  return { tap, advance, scrolls, field };
}

test('#14: a field in a form without a <form> is revealed with its row of buttons', () => {
  const r = rig();
  const event = r.tap();
  assert.equal(event.prevented, true, 'the tap is taken: no pan');
  assert.deepEqual(r.field.focused, [{ preventScroll: true }]);
  r.advance(surface.FALLBACK_MS);
  // iPhone 17, measured in the shell: New username at 459-497, Change
  // username and Cancel at 559-605, the screen ending on the keys at 539.
  // The buttons come up to 12px above the keys: 605 - (539 - 12).
  assert.deepEqual(r.scrolls, [78]);
});

test('#14: where the page is the document the taps stay native (`when`)', () => {
  const r = rig({ when: () => false });
  const event = r.tap();
  assert.equal(event.prevented, false, 'the browser focuses and reveals the field itself');
  assert.deepEqual(r.field.focused, []);
});

// ── #13: Home's search ──────────────────────────────────────────────────

test('#13: while the box has text Recent threads and Next challenges step aside, so communities follow the projects', () => {
  const hide = ruleWith('#home-screen:has(#home-search-input[placeholder]:not([placeholder=""]):not(:placeholder-shown)) :is(#home-aside, #home-challenges-section)');
  assert.match(hide, /display:\s*none/);
});

test('#13: the results are headed for what they are, and Return or a drag puts the keys away', () => {
  assert.match(HOME, /grid\.view === 'search' \? t\('home:grid\.headingSearch'\)/);
  assert.equal(HOME_EN['grid.headingSearch'].text, 'Your projects');
  assert.match(HOME_JS, /if \(e\.key === 'Enter' && !e\.isComposing\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*input\.blur\(\);/);
  assert.match(HOME_JS, /SEARCH_DRAG_DISMISS_PX: 12,/);
  assert.match(HOME_JS, /if \(document\.activeElement === input\) input\.blur\(\);/);
});

// ── #98: the Messages list ──────────────────────────────────────────────

test('#98: the list ends a lane past the bar, fades under the pill while it is up, and ends on the keys', () => {
  const rest = ruleWith('.messages-list-scroll.platform-safe-scroll {');
  assert.match(rest, /--inbox-lane:\s*60px/);
  assert.match(rest, /padding-bottom:\s*calc\(max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\) \+ var\(--inbox-lane\)\) !important/);
  const keys = ruleWith('html:is(.un-kb, .platform-kb-open) .messages-list-scroll.platform-safe-scroll');
  assert.match(keys, /padding-bottom:\s*calc\(var\(--un-kb-inset, 0px\) \+ var\(--inbox-lane\)\) !important/);
  const fade = ruleWith('.messages-list-scroll:has(+ [data-inbox-to-end] button:not([inert]))');
  assert.match(fade, /mask-image:\s*linear-gradient/);
  assert.match(INBOX_TO_END, /bottom: 'calc\(var\(--platform-tabs-h, 0px\) \+ var\(--un-kb-inset, 0px\) \+ 12px\)'/,
    'the pill rides on the keys while they are up');
});
