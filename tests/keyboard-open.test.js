'use strict';
// First-session run, 4 October 2026, the iOS Homeroom app, Messages, the
// Homeroom bot's conversation at 402pt wide:
//
//   1. With the keyboard open, the Resume strip and the tab bar were drawn ON
//      the keyboard, over the bottom of the composer, half covering Send.
//   2. Sending with the keyboard still open blanked the conversation (header,
//      transcript and composer gone) until the keyboard was put away.
//
// Mobile Safari already took both bars away with the keyboard up: the kit's
// tracker sets `html.un-kb` when the keys COVER the page, and app.css hides
// `#platform-tabs` and `#platform-parked` on it. The app's Flutter shell
// resizes its web view to end at the keyboard instead, so nothing is covered,
// the kit measures 0 and `un-kb` never comes on.
//
// Five parts:
//   1. the kit, executed with the app's numbers: it cannot see this keyboard;
//   2. lib/keyboard-open.ts, executed against a fake window: it can, in the
//      app and in Safari, and it stays off for everything that is not a
//      keyboard (a toolbar, a field focused from code, a hardware keyboard, a
//      checkbox, a zoom, a desktop, a rotation);
//   3. app.css: the class takes the bar and the strip away on a phone and
//      drops the band they reserve, so the composer sits on the keys;
//   4. the boot entry installs it;
//   5. the composer keeps the field focused through a send and refocuses
//      without a scroll (the likely cause of 2).
//
// What this cannot do is raise a real keyboard in the app's web view; the
// numbers below are the iPhone 17 Pro's 874pt screen with a 336pt keyboard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const MAIN = read('frontend/src/main.tsx');
const { physics } = require('../public/usernode-native/v1/native.js');
const {
  KB_OPEN_CLASS, PHONE_QUERY, KB_SHRINK_MIN,
  describeFocus, canHoldKeyboard, visibleHeight, keyboardOpen, initKeyboardOpen,
} = loadTsx('frontend/src/lib/keyboard-open.ts');

const SCREEN = 874; // iPhone 17 Pro, points
const KEYBOARD = 336; // keys plus the form accessory bar
const WIDTH = 402;

const TEXTAREA = { tagName: 'TEXTAREA' };
const TEXT_INPUT = { tagName: 'INPUT', type: 'text' };
const CHECKBOX = { tagName: 'INPUT', type: 'checkbox' };
const BUTTON = { tagName: 'BUTTON' };
const IFRAME = { tagName: 'IFRAME' };

// A window, a document and the kit, enough for initKeyboardOpen. Events are
// dispatched by hand in the order a browser fires them.
function harness({ width = WIDTH, height = SCREEN, phone = true, kit = { physics } } = {}) {
  const listeners = { win: {}, vv: {}, doc: {} };
  const on = (bucket) => (type, fn) => { (listeners[bucket][type] ||= []).push(fn); };
  const fire = (bucket, type, event = {}) => (listeners[bucket][type] || []).forEach((fn) => fn(event));
  const classes = new Set();
  let toggles = 0;
  const root = {
    tagName: 'HTML',
    clientHeight: height,
    classList: { toggle(name, force) { toggles += 1; if (force) classes.add(name); else classes.delete(name); } },
  };
  const body = { tagName: 'BODY' };
  const doc = { activeElement: body, body, documentElement: root, addEventListener: on('doc') };
  const vv = { height, scale: 1, addEventListener: on('vv') };
  const win = {
    innerHeight: height,
    innerWidth: width,
    visualViewport: vv,
    matchMedia: (query) => ({ matches: phone && query === PHONE_QUERY }),
    addEventListener: on('win'),
    unNative: kit,
  };
  initKeyboardOpen(doc, win);
  return {
    get open() { return classes.has(KB_OPEN_CLASS); },
    get toggles() { return toggles; },
    focus(el) {
      const from = doc.activeElement;
      if (from !== body) {
        doc.activeElement = body;
        fire('doc', 'focusout', { relatedTarget: el });
      }
      doc.activeElement = el;
      fire('doc', 'focusin', {});
    },
    blur() {
      doc.activeElement = body;
      fire('doc', 'focusout', { relatedTarget: null });
    },
    // The app's web view being resized: every measure of the page shrinks.
    resized(h) {
      win.innerHeight = h; root.clientHeight = h; vv.height = h;
      fire('win', 'resize'); fire('vv', 'resize');
    },
    // Safari's keyboard: only the visual viewport shrinks.
    covered(visual) {
      vv.height = visual;
      fire('vv', 'resize');
    },
    zoom(scale, visual) {
      vv.scale = scale; vv.height = visual;
      fire('vv', 'resize');
    },
    rotate(w, h) {
      win.innerWidth = w; win.innerHeight = h; root.clientHeight = h; vv.height = h;
      fire('win', 'resize'); fire('vv', 'resize');
    },
  };
}

// ── 1. The kit cannot see the app's keyboard ───────────────────────────────

test('the kit measures no keyboard in a web view resized for it, which is why un-kb never came on', () => {
  const shrunk = SCREEN - KEYBOARD;
  // The app: the page itself is 538 tall, so nothing covers it.
  assert.equal(physics.keyboardInset({ layoutHeight: shrunk, vvHeight: shrunk, vvScale: 1 }), 0);
  // Safari, for contrast: the layout stays 874 and the keys cover 336 of it.
  assert.equal(physics.keyboardInset({ layoutHeight: SCREEN, vvHeight: shrunk, vvScale: 1 }), KEYBOARD);
});

// ── 2. lib/keyboard-open.ts ─────────────────────────────────────────────────

test('the visible height is the smallest readable measure, ignoring a zoomed visual viewport', () => {
  assert.equal(visibleHeight({ innerHeight: 874, clientHeight: 874, vv: { height: 538, scale: 1 } }), 538);
  assert.equal(visibleHeight({ innerHeight: 538, clientHeight: 874, vv: { height: 874, scale: 1 } }), 538);
  assert.equal(visibleHeight({ innerHeight: 874, clientHeight: 874, vv: { height: 437, scale: 2 } }), 874,
    'a pinch zoom is not a keyboard');
  assert.equal(visibleHeight({ innerHeight: 874, clientHeight: 0, vv: null }), 874, 'a 0 is unreadable, not short');
  assert.equal(visibleHeight({}), 0);
});

test('the decision: phone, a keyboard field focused, and shorter than at rest by a keyboard', () => {
  const base = { phone: true, focused: true, height: SCREEN - KEYBOARD, resting: SCREEN };
  assert.equal(keyboardOpen(base), true);
  assert.equal(keyboardOpen({ ...base, phone: false }), false);
  assert.equal(keyboardOpen({ ...base, focused: false }), false);
  assert.equal(keyboardOpen({ ...base, height: SCREEN - (KB_SHRINK_MIN - 1) }), false);
  assert.equal(keyboardOpen({ ...base, height: SCREEN - KB_SHRINK_MIN }), true);
  assert.equal(keyboardOpen({ ...base, height: 0 }), false);
  assert.equal(KB_SHRINK_MIN, 150, 'more than any toolbar, less than any phone keyboard');
});

test('what can hold the keyboard is the kit\'s own classifier, and nothing without the kit', () => {
  for (const [el, want] of [[TEXTAREA, true], [TEXT_INPUT, true], [IFRAME, true], [CHECKBOX, false], [BUTTON, false], [null, false]]) {
    assert.equal(canHoldKeyboard(el, { physics }), want, `${el ? el.tagName + (el.type ? `[${el.type}]` : '') : 'nothing'}`);
    assert.equal(canHoldKeyboard(el, { physics }), physics.keyboardCanBeUp(describeFocus(el)));
  }
  assert.equal(canHoldKeyboard({ tagName: 'INPUT', type: 'text', readOnly: true }, { physics }), false);
  assert.equal(canHoldKeyboard({ tagName: 'DIV', isContentEditable: true }, { physics }), true);
  // Focus inside a shadow root is reported as its host.
  assert.equal(canHoldKeyboard({ tagName: 'X-FIELD', shadowRoot: { activeElement: TEXTAREA } }, { physics }), true);
  const body = { tagName: 'BODY' };
  assert.equal(canHoldKeyboard(body, { physics }, body), false);
  assert.equal(canHoldKeyboard(TEXTAREA, null), false);
  assert.equal(canHoldKeyboard(TEXTAREA, { physics: { keyboardCanBeUp() { throw new Error('x'); } } }), false);
});

test('the app: the web view shrinks under a focused composer, the class comes on, and off on the blur', () => {
  const h = harness();
  assert.equal(h.open, false, 'nothing focused, nothing open');
  h.focus(TEXTAREA);
  assert.equal(h.open, false, 'focused, but the keyboard has not taken any room yet');
  // Flutter animates the web view down with the keyboard.
  h.resized(SCREEN - 100);
  assert.equal(h.open, false, 'a 100px step is not yet a keyboard');
  h.resized(SCREEN - 200);
  assert.equal(h.open, true);
  h.resized(SCREEN - KEYBOARD);
  assert.equal(h.open, true);
  // The keys start down the moment the field lets go; the bar comes back
  // with them, not when the web view has finished growing.
  h.blur();
  assert.equal(h.open, false, 'off in the blur itself');
  h.resized(SCREEN - 200);
  h.resized(SCREEN);
  assert.equal(h.open, false);
  // And again, the next time.
  h.focus(TEXTAREA);
  h.resized(SCREEN - KEYBOARD);
  assert.equal(h.open, true);
});

test('a hop from field to field keeps it on without a flicker', () => {
  const h = harness();
  h.focus(TEXTAREA);
  h.resized(SCREEN - KEYBOARD);
  const before = h.toggles;
  h.focus(TEXT_INPUT);
  h.focus(TEXTAREA);
  assert.equal(h.open, true);
  assert.equal(h.toggles, before, 'the class was never written in between');
});

test('Safari: the keys cover the page, and it is on there too (beside the kit\'s un-kb)', () => {
  const h = harness();
  h.focus(TEXTAREA);
  h.covered(SCREEN - KEYBOARD);
  assert.equal(h.open, true);
  h.blur();
  assert.equal(h.open, false);
});

test('not a keyboard: a toolbar, a field focused from code, a hardware keyboard\'s bar', () => {
  const h = harness();
  h.focus(TEXTAREA);
  assert.equal(h.open, false, 'a field focused from code gets no keyboard on iOS until it is tapped');
  h.covered(SCREEN - 84);
  assert.equal(h.open, false, 'Safari\'s toolbar moves the page by well under 150px');
  h.covered(SCREEN - 60);
  assert.equal(h.open, false, 'a hardware keyboard raises only a slim bar; the tab bar stays');
});

test('not a keyboard: a checkbox or a button focused while the page is short', () => {
  for (const el of [CHECKBOX, BUTTON]) {
    const h = harness();
    h.focus(el);
    h.resized(SCREEN - KEYBOARD);
    assert.equal(h.open, false, `${el.tagName} raises no keyboard`);
  }
  const h = harness();
  h.focus(IFRAME);
  h.resized(SCREEN - KEYBOARD);
  assert.equal(h.open, true, 'a focused app frame may hold a field, as the kit counts it');
});

test('not a keyboard: a pinch zoom', () => {
  const h = harness();
  h.focus(TEXTAREA);
  h.zoom(2, SCREEN / 2);
  assert.equal(h.open, false);
});

test('only on a phone layout', () => {
  const h = harness({ width: 1024, height: 768, phone: false });
  h.focus(TEXTAREA);
  h.resized(768 - KEYBOARD);
  assert.equal(h.open, false);
  assert.match(PHONE_QUERY, /^\(max-width: 767px\)/, 'the bar\'s own breakpoint');
  assert.match(PHONE_QUERY, /\(pointer: coarse\)/, 'and a touch screen, where an on-screen keyboard is');
});

test('a rotation starts the resting measure again', () => {
  const h = harness();
  h.focus(TEXTAREA);
  // Turned with a field focused: a different width, and shorter than the
  // portrait page by more than a keyboard, but no keyboard came up.
  h.rotate(500, 600);
  assert.equal(h.open, false, 'shorter than the PORTRAIT page is not a keyboard');
  h.resized(600 - 200);
  assert.equal(h.open, true, 'shorter than this width\'s rest is');
});

test('without the kit there is no answer, so nothing is hidden', () => {
  const h = harness({ kit: null });
  h.focus(TEXTAREA);
  h.resized(SCREEN - KEYBOARD);
  assert.equal(h.open, false);
});

// ── 3. app.css ──────────────────────────────────────────────────────────────

const block = (() => {
  const start = APP_CSS.indexOf(`@media (max-width: 767px) {\n  html.${KB_OPEN_CLASS} body {`);
  assert.ok(start > 0, 'the phone-only keyboard block is missing');
  const end = APP_CSS.indexOf('\n}\n', start);
  return APP_CSS.slice(start, end + 2);
})();
const rule = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&').replace(/\s+/g, '\\s+');
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(block);
  assert.ok(m, `${selector} is missing from the phone keyboard block`);
  return m[1];
};

test('the class takes the tab bar and the Resume strip away, on a phone', () => {
  assert.equal(KB_OPEN_CLASS, 'platform-kb-open');
  assert.match(rule(`html.${KB_OPEN_CLASS} #platform-tabs,\n  html.${KB_OPEN_CLASS} #platform-parked`), /display: none;/);
  // Presentation, not the islands' `hidden` class: the bars come back with no
  // state to restore. A strip leaving while hidden this way runs no keyframe,
  // and its leave already ends on a timer for exactly that case.
  assert.match(read('frontend/src/features/nav/parked-strip.tsx'), /window\.setTimeout\(finish, /);
});

test('and drops the band they reserve, so the composer sits on the keyboard', () => {
  const tokens = rule(`html.${KB_OPEN_CLASS} body`);
  // !important because the reservations key off the bars' own classes
  // (`html:not(.un-kb) body:has(#platform-tabs:not(.hidden)…)`), which this
  // state leaves alone, and win on specificity otherwise.
  assert.match(tokens, /--platform-bar-h: 0px !important;/);
  assert.match(tokens, /--platform-tabs-h: 0px !important;/);
  assert.match(rule(`html.${KB_OPEN_CLASS} .platform-safe-scroll`), /padding-bottom: 0 !important;/);
  // The composer keeps its own 8px gap and nothing else, exactly as under un-kb.
  const kitBar = /html\.un-kb \.platform-safe-bar\s*\{([^}]*)\}/.exec(APP_CSS)[1];
  assert.match(rule(`html.${KB_OPEN_CLASS} .platform-safe-bar`), /padding-bottom: 0\.5rem !important;/);
  assert.match(kitBar, /padding-bottom: 0\.5rem !important;/);
});

test('Safari\'s path is unchanged', () => {
  assert.match(APP_CSS, /html\.un-kb #platform-tabs \{\s*display: none;\s*\}/);
  assert.match(APP_CSS, /html\.un-kb #platform-parked \{\s*display: none;\s*\}/);
});

// ── 4. Installed at boot ────────────────────────────────────────────────────

test('the shell bundle installs it, beside the visual viewport tracker', () => {
  const vv = MAIN.indexOf("import './lib/visual-viewport';");
  const kb = MAIN.indexOf("import './lib/keyboard-open';");
  assert.ok(vv > 0 && kb > vv, 'imported after lib/visual-viewport');
  const src = read('frontend/src/lib/keyboard-open.ts');
  assert.match(src, /if \(typeof document !== 'undefined' && typeof window !== 'undefined'\) \{\s*initKeyboardOpen\(/,
    'installs itself in the browser, and only there');
});

// ── 5. The send keeps the keyboard ──────────────────────────────────────────

test('Send does not take focus from the field, and the refocus never scrolls', () => {
  const at = COMPOSER.indexOf('className="messages-send"');
  assert.ok(at > 0, 'the send button is missing');
  const send = COMPOSER.slice(COMPOSER.lastIndexOf('<button', at), at);
  assert.match(send, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/,
    'a tap on Send must not blur the field (and drop, then re-raise, the keyboard)');
  assert.match(send, /onClick=\{submit\}/);
  const submit = COMPOSER.slice(COMPOSER.indexOf('function submit() {'), COMPOSER.indexOf('\n  }\n', COMPOSER.indexOf('function submit() {')));
  assert.match(submit, /requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\{ preventScroll: true \}\)\)/);
  assert.doesNotMatch(submit, /\.focus\(\)/, 'no refocus that asks iOS to scroll the field into view');
});
