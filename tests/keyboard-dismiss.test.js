'use strict';
// Request #4032, "Hide keyboard when tapping outside it on mobile": "Now
// that there is no checkbox, when the keyboard is open, tapping behind the
// keyboard on the screen should hide the keyboard (on iOS + probably
// android)".
//
// The Homeroom iOS app dropped WKWebView's keyboard accessory bar
// (flutter-mobile-app PR #603), and its check mark was the only way to put
// the keys away: WebKit does not blur a focused field when a finger taps
// content that cannot take focus. Chrome on Android does.
//
// One rule, in one place: the kit (usernode-native/v1/native.js), whose
// pure decisions live on `physics` and whose listener runs in every
// document that loads it. Every app loads it in its own frame, and the
// platform shell loads it too (frontend/src/head.html), so Homeroom's own
// screens get the same listener rather than a copy.
//
// Five parts:
//   1. the decisions: what a tap is, and what keeps the keyboard;
//   2. the listener, executed from native.js in a sandbox against a fake
//      page that fires events in a browser's order;
//   3. its opt-out and its desktop no-op, and the shell running it as is;
//   4. in the shell, with lib/keyboard-open.ts: a tap that closes the
//      keyboard is a press, so the tab bar waits for its click (the
//      composer does not fall under the finger first);
//   5. the conventions document it, and every element in the shell that
//      keeps its field focused through a press is one a tap keeps the
//      keyboard for.
//
// What this cannot do is raise a real keyboard; it checks the blur that
// closes one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NATIVE_JS = read('public/usernode-native/v1/native.js');
const { physics } = require('../public/usernode-native/v1/native.js');
const OPEN = loadTsx('frontend/src/lib/keyboard-open.ts');

// ── A fake page ─────────────────────────────────────────────────────────────

// An element: a tag, literal attributes, and a parent.
function node(tag, attrs = {}, parent = null, extra = {}) {
  return {
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    parentNode: parent,
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? String(attrs[name]) : null),
    setAttribute(name, value) { attrs[name] = String(value); },
    ...extra,
  };
}

// A window and a document, the listeners each registers, and a finger.
// Events go through the window and the document in a browser's order:
// capture down (window, document), then bubble up (document, window).
function page({ touch = true } = {}) {
  let clock = 10_000;
  const listeners = [];
  const on = (where) => (type, fn, options) => listeners.push({
    where,
    type,
    fn,
    capture: options === true || !!(options && options.capture),
    passive: !!(options && options.passive),
  });
  const html = node('html');
  const body = node('body', {}, html);
  const doc = { documentElement: html, body, activeElement: body, addEventListener: on('doc') };
  const win = { addEventListener: on('win'), performance: { now: () => clock } };
  if (touch) win.ontouchstart = null;

  const order = [['win', true], ['doc', true], ['doc', false], ['win', false]];
  function fire(type, event, { stopped = false } = {}) {
    for (const [where, capture] of order) {
      if (stopped && !capture) break; // a handler on the target stopped it
      for (const l of listeners) if (l.where === where && l.capture === capture && l.type === type) l.fn(event);
    }
  }
  const chain = (target) => {
    const out = [];
    for (let n = target; n; n = n.parentNode) out.push(n);
    return [...out, doc, win];
  };

  // A field that can be focused and blurred, as the browser would.
  function field(tag, attrs = {}, extra = {}) {
    const el = node(tag, attrs, body, {
      blurs: 0,
      blur() {
        el.blurs += 1;
        if (doc.activeElement === el || doc.activeElement?.shadowRoot?.activeElement === el) {
          doc.activeElement = body;
          fire('focusout', { target: el, relatedTarget: null });
        }
      },
      ...extra,
    });
    return el;
  }
  function focus(el) {
    doc.activeElement = el;
    fire('focusin', { target: el });
  }

  // One finger: down at `from`, through `via`, up at `to` after `ms`. The
  // events carry no preventDefault: a listener that called it would throw.
  function tap(target, {
    from = [120, 300], via = null, to = from, ms = 80, scroll = false, fingers = 1, cancel = false,
    prevented = false, stopped = false, pointerType = 'touch', path: withPath = true,
  } = {}) {
    const p0 = { clientX: from[0], clientY: from[1] };
    const p1 = { clientX: to[0], clientY: to[1] };
    const moves = [via, to === from ? null : to].filter(Boolean).map(([x, y]) => ({ clientX: x, clientY: y }));
    const route = chain(target);
    const base = withPath ? { target, composedPath: () => route } : { target };
    if (touch) {
      fire('touchstart', { ...base, touches: [p0], changedTouches: [p0] });
      if (fingers > 1) fire('touchstart', { ...base, touches: [p0, p1], changedTouches: [p1] });
      if (scroll) fire('scroll', { target: node('div', {}, body) });
      for (const m of moves) fire('touchmove', { ...base, touches: [m], changedTouches: [m] });
      clock += ms;
      if (cancel) return fire('touchcancel', { ...base, touches: [], changedTouches: [p1] });
      if (fingers > 1) fire('touchend', { ...base, touches: [p0], changedTouches: [p1] });
      return fire('touchend', { ...base, touches: [], changedTouches: [p1], defaultPrevented: prevented }, { stopped });
    }
    const ptr = (p, extra = {}) => ({ ...base, pointerType, isPrimary: true, ...p, ...extra });
    fire('pointerdown', ptr(p0));
    if (fingers > 1) fire('pointerdown', ptr(p1, { isPrimary: false }));
    if (scroll) fire('scroll', { target: node('div', {}, body) });
    for (const m of moves) fire('pointermove', ptr(m));
    clock += ms;
    if (cancel) return fire('pointercancel', ptr(p1));
    return fire('pointerup', ptr(p1, { defaultPrevented: prevented }), { stopped });
  }

  return {
    win, doc, html, body, listeners, field, focus, tap, fire,
    el: (tag, attrs, parent = body) => node(tag, attrs, parent),
  };
}

// The kit's listener, executed from native.js itself: the text-field
// classifier, the dismissal decisions and the listener, in a sandbox whose
// window and document are the fake page's.
function between(from, to) {
  const start = NATIVE_JS.indexOf(from);
  assert.ok(start >= 0, `native.js: ${from} is missing`);
  const end = NATIVE_JS.indexOf(to, start);
  assert.ok(end > start, `native.js: nothing after ${from}`);
  return NATIVE_JS.slice(start, end);
}
const KIT_LISTENER = between('  var KB_TEXT_INPUT_TYPES = {', '  // Whether the focused element can be holding')
  + between('  var KB_DISMISS_SLOP = ', '  // Keyboard-aware reveal math')
  + between('  (function keyboardDismiss() {', '\n  })();') + '\n  })();\n';

function kitPage({ platform = 'ios', touch = true } = {}) {
  const p = page({ touch });
  vm.runInNewContext(KIT_LISTENER, { window: p.win, document: p.doc, platform });
  return p;
}

// ── 1. The decisions ────────────────────────────────────────────────────────

test('a tap: one finger, under the slop at its furthest, no scroll, shorter than a long press', () => {
  const { isKeyboardDismissTap, KB_DISMISS_SLOP, KB_DISMISS_MAX_MS } = physics;
  assert.equal(KB_DISMISS_SLOP, 10);
  assert.equal(KB_DISMISS_MAX_MS, 500, 'iOS starts text selection and context menus at half a second');
  assert.equal(isKeyboardDismissTap({ moved: 0, ms: 80 }), true);
  assert.equal(isKeyboardDismissTap({ moved: KB_DISMISS_SLOP - 0.5, ms: 80 }), true);
  assert.equal(isKeyboardDismissTap({ moved: KB_DISMISS_SLOP, ms: 80 }), false, 'a drag');
  assert.equal(isKeyboardDismissTap({ moved: 0, ms: 80, scrolled: true }), false, 'a scroll');
  assert.equal(isKeyboardDismissTap({ moved: 0, ms: 80, multi: true }), false, 'a pinch');
  assert.equal(isKeyboardDismissTap({ moved: 0, ms: KB_DISMISS_MAX_MS }), true);
  assert.equal(isKeyboardDismissTap({ moved: 0, ms: KB_DISMISS_MAX_MS + 1 }), false, 'a long press');
  assert.equal(isKeyboardDismissTap({ moved: 0 }), true, 'no clock is no long press');
  assert.equal(isKeyboardDismissTap(null), false);
});

test('what keeps the keyboard: fields, controls, widget roles, the kit\'s pressable, and the mark', () => {
  const { keepsKeyboard } = physics;
  const el = (tag, attrs) => node(tag, attrs);
  for (const tag of ['input', 'textarea', 'select', 'button', 'label', 'summary', 'iframe']) {
    assert.equal(keepsKeyboard(el(tag)), true, tag);
  }
  assert.equal(keepsKeyboard(el('a', { href: '#x' })), true, 'a link');
  assert.equal(keepsKeyboard(el('a')), false, 'an anchor with no href is no link');
  assert.equal(keepsKeyboard(el('div', { contenteditable: '' })), true);
  assert.equal(keepsKeyboard(el('div', { contenteditable: 'plaintext-only' })), true);
  assert.equal(keepsKeyboard(el('span', { contenteditable: 'false' })), false);
  for (const role of ['button', 'link', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'combobox',
    'listbox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'switch', 'checkbox', 'radio', 'tab']) {
    assert.equal(keepsKeyboard(el('div', { role })), true, role);
  }
  assert.equal(keepsKeyboard(el('div', { role: 'Option' })), true, 'roles are matched without case');
  assert.equal(keepsKeyboard(el('div', { role: 'presentation button' })), true, 'any token of a fallback list');
  for (const role of ['dialog', 'region', 'log', 'presentation', 'toString', 'constructor']) {
    assert.equal(keepsKeyboard(el('div', { role })), false, role);
  }
  assert.equal(keepsKeyboard(el('li', { class: 'row un-pressable' })), true);
  assert.equal(keepsKeyboard(el('li', { class: 'row un-pressable-ish' })), false);
  assert.equal(keepsKeyboard(el('div', { 'data-keep-keyboard': '' })), true);
  for (const tag of ['div', 'p', 'span', 'main', 'img', 'body', 'html']) {
    assert.equal(keepsKeyboard(el(tag)), false, tag);
  }
  // The event path ends in the document and the window, which have no attributes.
  assert.equal(keepsKeyboard({}), false);
  assert.equal(keepsKeyboard(null), false);
  assert.equal(keepsKeyboard({ tagName: 'DIV', getAttribute() { throw new Error('gone'); } }), false);
});

test('the whole tap: anywhere up the path, and the suggestion list the field names', () => {
  const { tapKeepsKeyboard } = physics;
  const body = node('body');
  const list = node('ul', { id: 'people' }, body);
  const row = node('li', {}, list);
  const send = node('button', {}, body);
  const icon = node('svg', {}, send);
  const text = node('p', {}, node('div', {}, body));
  const marked = node('span', {}, node('div', { 'data-keep-keyboard': '' }, body));
  const up = (n) => { const out = []; for (; n; n = n.parentNode) out.push(n); return out; };
  const composer = node('textarea', { 'aria-controls': 'people other' });
  assert.equal(tapKeepsKeyboard(up(icon), composer), true, 'the icon inside Send');
  assert.equal(tapKeepsKeyboard(up(marked), composer), true, 'inside data-keep-keyboard');
  assert.equal(tapKeepsKeyboard(up(row), composer), true, 'a row of the list it controls, roles or none');
  assert.equal(tapKeepsKeyboard(up(row), node('textarea', { 'aria-owns': 'people' })), true);
  assert.equal(tapKeepsKeyboard(up(row), node('textarea')), false, 'someone else\'s list');
  assert.equal(tapKeepsKeyboard(up(row), node('textarea', { 'aria-controls': 'People' })), false, 'ids keep their case');
  assert.equal(tapKeepsKeyboard(up(text), composer), false, 'the page behind the keyboard');
  assert.equal(tapKeepsKeyboard([], composer), false);
  assert.equal(tapKeepsKeyboard(null, composer), false);
});

// ── 2. The listener ──────────────────────────────────────────────────────────

test('a tap on the page behind the keyboard blurs the field, and does nothing else to the tap', () => {
  const p = kitPage();
  const composer = p.field('textarea');
  p.focus(composer);
  const text = p.el('p', {}, p.el('div', { class: 'transcript' }));
  p.tap(text);
  assert.equal(composer.blurs, 1);
  assert.equal(p.doc.activeElement, p.body);
  // Every listener is passive: nothing can prevent the tap or hold a scroll.
  assert.ok(p.listeners.length > 0 && p.listeners.every((l) => l.passive), 'passive');
  // Nothing focused, nothing to do; the next tap is just a tap.
  p.tap(text);
  assert.equal(composer.blurs, 1);
});

test('only a field that raises keys, and an editable region', () => {
  for (const [tag, attrs, extra, want] of [
    ['input', {}, { type: 'text' }, 1],
    ['input', {}, { type: 'search' }, 1],
    ['input', {}, { type: 'email' }, 1],
    ['div', {}, { isContentEditable: true }, 1],
    ['input', {}, { type: 'checkbox' }, 0],
    ['input', {}, { type: 'date' }, 0],
    ['input', {}, { type: 'text', readOnly: true }, 0],
    ['select', {}, {}, 0],
    ['button', {}, {}, 0],
    ['iframe', {}, {}, 0], // an app's own field: its kit closes it, in its frame
  ]) {
    const p = kitPage();
    const el = p.field(tag, attrs, extra);
    p.focus(el);
    p.tap(p.el('p'));
    assert.equal(el.blurs, want, `${tag} ${JSON.stringify(extra)}`);
  }
});

test('a field focused inside a shadow root is the one blurred', () => {
  const p = kitPage();
  const inner = p.field('input', {}, { type: 'text' });
  const host = p.el('x-field');
  host.shadowRoot = { activeElement: inner };
  p.focus(host);
  p.doc.activeElement = host;
  p.tap(p.el('p'));
  assert.equal(inner.blurs, 1);
});

test('a scroll, a drag, a long press, two fingers and a cancelled touch keep the keyboard', () => {
  for (const [what, opts] of [
    ['a scroll', { scroll: true }],
    ['a drag', { to: [120, 330] }],
    ['a drag just past the slop', { to: [131, 300] }],
    ['a drag that comes back', { via: [120, 340], to: [120, 300] }],
    ['a long press', { ms: 800 }],
    ['two fingers', { fingers: 2 }],
    ['a cancelled touch', { cancel: true }],
  ]) {
    const p = kitPage();
    const composer = p.field('textarea');
    p.focus(composer);
    p.tap(p.el('p'), opts);
    assert.equal(composer.blurs, 0, what);
  }
  const p = kitPage();
  const composer = p.field('textarea');
  p.focus(composer);
  p.tap(p.el('p'), { to: [126, 306] });
  assert.equal(composer.blurs, 1, 'a finger that wobbles less than the slop still taps');
});

test('a tap on a field, a control, a list or the mark keeps the keyboard', () => {
  const p = kitPage();
  const composer = p.field('textarea', { 'aria-controls': 'mention-menu' });
  p.focus(composer);
  const send = p.el('button', { class: 'messages-send' });
  const listbox = p.el('div', { role: 'listbox' });
  const menu = p.el('div', { id: 'mention-menu' });
  for (const [what, target] of [
    ['the composer itself', composer],
    ['another field', p.el('input')],
    ['Send (its icon)', p.el('svg', {}, send)],
    ['a suggestion row', p.el('button', { role: 'option' }, listbox)],
    ['a heading inside the list', p.el('div', {}, listbox)],
    ['the list the field controls', p.el('div', {}, menu)],
    ['a label', p.el('label')],
    ['a link', p.el('a', { href: '/x' })],
    ['a switch', p.el('span', {}, p.el('div', { role: 'switch' }))],
    ['a pressable row', p.el('div', { class: 'un-pressable' })],
    ['inside data-keep-keyboard', p.el('p', {}, p.el('div', { 'data-keep-keyboard': '' }))],
  ]) {
    p.tap(target);
    assert.equal(composer.blurs, 0, what);
  }
  // Without composedPath the parent chain is the path.
  p.tap(p.el('svg', {}, send), { path: false });
  assert.equal(composer.blurs, 0, 'the parent chain');
  p.tap(p.el('p'), { path: false });
  assert.equal(composer.blurs, 1, 'the parent chain reaches nothing that keeps it');
});

test('a tap a handler took for itself (cancelled, or stopped) is left to it', () => {
  const p = kitPage();
  const composer = p.field('textarea');
  p.focus(composer);
  p.tap(p.el('p'), { prevented: true });
  assert.equal(composer.blurs, 0, 'its touchend was cancelled');
  p.tap(p.el('p'), { stopped: true });
  assert.equal(composer.blurs, 0, 'its touchend never reached the window');
  p.tap(p.el('p'));
  assert.equal(composer.blurs, 1, 'and the next tap is heard');
});

test('pointer events where there are no touch events, from a finger only', () => {
  for (const [pointerType, want] of [['touch', 1], ['mouse', 0], ['pen', 0]]) {
    const p = kitPage({ touch: false });
    const field = p.field('input', {}, { type: 'text' });
    p.focus(field);
    p.tap(p.el('p'), { pointerType });
    assert.equal(field.blurs, want, pointerType);
  }
  for (const opts of [{ scroll: true }, { to: [140, 300] }, { fingers: 2 }, { cancel: true }, { prevented: true }]) {
    const p = kitPage({ touch: false });
    const field = p.field('textarea');
    p.focus(field);
    p.tap(p.el('p'), opts);
    assert.equal(field.blurs, 0, JSON.stringify(opts));
  }
  const p = kitPage({ touch: false });
  assert.ok(p.listeners.every((l) => !/^touch/.test(l.type)), 'one family of events, not both');
});

test('the start is heard in capture, the end after the page\'s own handlers', () => {
  const p = kitPage();
  const kinds = Object.fromEntries(p.listeners.filter((l) => l.where === 'win').map((l) => [l.type, l]));
  for (const type of ['touchstart', 'touchmove', 'touchcancel', 'scroll']) {
    assert.equal(kinds[type].capture, true, type);
  }
  assert.equal(kinds.touchend.capture, false, 'touchend in bubble, so its defaultPrevented is final');
});

// ── 3. The opt-out, the desktop, and the shell ──────────────────────────────

test('an app turns it off on <html> or <body>, as the finger lands', () => {
  for (const where of ['html', 'body']) {
    const p = kitPage();
    const field = p.field('textarea');
    p.focus(field);
    p[where].setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
    p.tap(p.el('p'));
    assert.equal(field.blurs, 0, where);
    p[where].setAttribute(physics.KB_DISMISS_OFF_ATTR, 'on');
    p.tap(p.el('p'));
    assert.equal(field.blurs, 1, `${where}: any other value leaves it on`);
  }
});

test('nothing on a desktop, which has no on-screen keyboard: not even a listener', () => {
  const p = kitPage({ platform: 'desktop' });
  const field = p.field('textarea');
  p.focus(field);
  p.tap(p.el('p'));
  assert.equal(field.blurs, 0);
  assert.equal(p.listeners.length, 0);
  assert.equal(kitPage({ platform: 'android' }).listeners.length, 5, 'Android gets the same rule');
});

test('the shell runs the kit\'s listener as is: loaded as a plain script, and never turned off', () => {
  // The shell's document loads the hosted kit in its <head>, before the
  // bundle, synchronously: the listener is installed there on the same
  // terms as in any app (a phone, by the kit's platform; not a desktop).
  const head = read('frontend/src/head.html');
  const tag = /<script\b[^>]*src="\/usernode-native\/v1\/native\.js"[^>]*>/.exec(head);
  assert.ok(tag, 'head.html loads the kit');
  assert.doesNotMatch(tag[0], /\b(defer|async|type=)/, 'a plain script, run as the head is parsed');
  // And nothing in the shell opts its own document out, or carries a second copy.
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(rel);
    return /\.(tsx?|jsx?|html|css)$/.test(d.name) ? [rel] : [];
  });
  for (const file of [...walk('frontend/src'), ...walk('frontend/@'), ...walk('public/js'), 'public/css/app.css']) {
    const src = read(file);
    assert.doesNotMatch(src, new RegExp(physics.KB_DISMISS_OFF_ATTR), `${file} turns the kit's listener off`);
    assert.doesNotMatch(src, /isKeyboardDismissTap|tapKeepsKeyboard/, `${file} runs a second copy`);
  }
});

// ── 4. With lib/keyboard-open.ts: the bars wait for the tap's click ─────────

test('in the shell in the app, a tap that closes the keyboard holds the tab bar back until its click', () => {
  const SCREEN = 874;
  const KEYBOARD = 336;
  const p = page();
  const classes = new Set();
  const timers = [];
  let clock = 50_000;
  let seq = 0;
  Object.assign(p.html, {
    clientHeight: SCREEN,
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
    style: { setProperty() {} },
  });
  const vvListeners = [];
  Object.assign(p.win, {
    innerHeight: SCREEN,
    innerWidth: 402,
    visualViewport: { height: SCREEN, scale: 1, addEventListener: (type, fn) => vvListeners.push(fn) },
    matchMedia: (query) => ({ matches: query === OPEN.PHONE_QUERY }),
    unNative: { platform: 'ios', physics },
    performance: { now: () => clock },
    setTimeout(fn, ms) { seq += 1; timers.push({ id: seq, fn, due: clock + ms }); return seq; },
    clearTimeout(id) { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
  });
  const run = (ms) => {
    clock += ms;
    for (const t of timers.splice(0).sort((a, b) => a.due - b.due)) {
      if (t.due <= clock) t.fn(); else timers.push(t);
    }
  };
  const resized = (h) => {
    p.win.innerHeight = h; p.html.clientHeight = h; p.win.visualViewport.height = h;
    p.fire('resize', {});
    vvListeners.forEach((fn) => fn());
  };
  // The shell's document: the kit's listener (native.js, in <head>), then
  // the bundle's keyboard tracker.
  vm.runInNewContext(KIT_LISTENER, { window: p.win, document: p.doc, platform: 'ios' });
  OPEN.initKeyboardOpen(p.doc, p.win);

  const composer = p.field('textarea');
  p.focus(composer);
  resized(SCREEN - KEYBOARD); // Flutter shortens the web view for the keys
  assert.ok(classes.has(OPEN.KB_OPEN_CLASS), 'the keyboard is up');

  // A tap on the transcript: the field lets go as the finger lifts, but the
  // bars stay away (the composer stays put) until the tap's click is out.
  p.tap(p.el('p'));
  assert.equal(composer.blurs, 1);
  assert.ok(classes.has(OPEN.KB_OPEN_CLASS), 'held for the click');
  resized(SCREEN);
  assert.ok(classes.has(OPEN.KB_OPEN_CLASS), 'still held while the web view grows back');
  p.fire('click', { target: p.body });
  run(0);
  assert.ok(!classes.has(OPEN.KB_OPEN_CLASS), 'the bars come back once the click is out');
});

// ── 5. The wiring ───────────────────────────────────────────────────────────

test('the listener prevents nothing and writes nothing to the page but the blur', () => {
  const src = between('  (function keyboardDismiss() {', '\n  })();');
  assert.doesNotMatch(src, /preventDefault\(|stopPropagation\(|style\.|classList|setAttribute/);
  assert.equal((src.match(/\.blur\(\)/g) || []).length, 1);
});

test('the conventions and the kit\'s header tell an app how to keep the keyboard, or turn it off', () => {
  const doc = read('src/prompts/app-conventions.md');
  const at = doc.indexOf('- **Tap outside a field closes the keyboard (automatic).**');
  assert.ok(at >= 0, 'documented among the kit\'s features');
  const entry = doc.slice(at, doc.indexOf('\n- **', at + 4));
  assert.match(entry, /data-keep-keyboard/);
  assert.match(entry, /data-un-keyboard-dismiss="off"/);
  const header = NATIVE_JS.slice(0, NATIVE_JS.indexOf('(function (global)'));
  assert.match(header, /data-keep-keyboard/);
  assert.match(header, /data-un-keyboard-dismiss="off"/);
});

// The opening tag of the JSX element whose attributes include the text at
// `at`: walking back, the first `<Name` outside every attribute's braces;
// then on to the `>` that closes it, braces counted the same way.
function openingTagAt(src, at) {
  let start = -1;
  for (let i = at - 1, depth = 0; i >= 0; i -= 1) {
    if (src[i] === '}') depth += 1;
    else if (src[i] === '{') depth -= 1;
    else if (src[i] === '<' && depth === 0 && /[A-Za-z]/.test(src[i + 1])) { start = i; break; }
  }
  assert.ok(start >= 0, 'no element before it');
  for (let i = start, depth = 0; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    else if (src[i] === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return assert.fail('the element never closes');
}

test('every element in the shell that keeps its field focused through a press is one a tap keeps the keyboard for', () => {
  // A press whose mousedown is prevented keeps the field focused: the
  // composers' Send buttons (lib/keyboard-open.ts), the suggestion lists
  // that pick on mousedown. Blurring at the tap's end would undo that, so
  // each must be something tapKeepsKeyboard keeps: a button, a widget role,
  // or a `data-keep-keyboard` mark. `Button` is the shell's <button>.
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return walk(rel);
    return /\.(tsx|jsx)$/.test(d.name) ? [rel] : [];
  });
  let seen = 0;
  for (const file of walk('frontend/src')) {
    const src = read(file);
    for (let at = src.indexOf('onMouseDown={'); at >= 0; at = src.indexOf('onMouseDown={', at + 1)) {
      let depth = 0;
      let end = at + 'onMouseDown='.length;
      for (; end < src.length; end += 1) {
        if (src[end] === '{') depth += 1;
        else if (src[end] === '}' && --depth === 0) break;
      }
      if (!/\.preventDefault\(\)/.test(src.slice(at, end))) continue;
      const tag = openingTagAt(src, at);
      const name = /^<([\w.]+)/.exec(tag)[1];
      const attrs = {};
      for (const m of tag.matchAll(/\s([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const el = node(name === 'Button' ? 'button' : name, attrs);
      seen += 1;
      assert.ok(physics.keepsKeyboard(el), `${file}: <${name}> keeps its field focused but a tap there would blur it`);
    }
  }
  assert.ok(seen >= 15, `found ${seen}`);
});
