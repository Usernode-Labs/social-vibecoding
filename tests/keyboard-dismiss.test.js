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
// Six parts:
//   1. the decisions: what a tap is, and what keeps the keyboard;
//   2. the listener, executed from native.js in a sandbox against a fake
//      page that fires events in a browser's order;
//   3. its opt-out and its desktop no-op, and the shell running it as is;
//   4. in the shell, with lib/keyboard-open.ts: a tap that closes the
//      keyboard is a press, so the tab bar waits for its click (the
//      composer does not fall under the finger first);
//   5. the conventions document it, and every element in the shell that
//      keeps its field focused through a press is one a tap keeps the
//      keyboard for;
//   6. around a frame (request #4273): with an app's field up, a tap on
//      the shell's own chrome reaches only the shell, so the shell's
//      listener tells the app's frame, and the kit in the frame puts its
//      field away when its parent says so;
//   7. from the side panel (request #4314): on an iPad the panel is a
//      document of its own beside the app, so a tap in it that closes the
//      keyboard is reported up to the shell, which applies its own rule.
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

// `parent`: the window that frames this page ('self' for a top-level
// window, whose parent is itself); none, as in a sandbox, by default.
// `origin`: the page's own; `frameElement`: the element framing it, as a
// parent of the same origin shows it (null under any other).
const ORIGIN = 'https://homeroom.test';
function kitPage({ platform = 'ios', touch = true, parent = null, origin = ORIGIN, frameElement = null } = {}) {
  const p = page({ touch });
  if (parent) p.win.parent = parent === 'self' ? p.win : parent;
  p.win.location = { origin };
  p.win.frameElement = frameElement;
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
    ['iframe', {}, {}, 0], // an app's own field: its kit closes it, in its frame (part 6)
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
  assert.equal(kitPage({ platform: 'android' }).listeners.length, 6, 'Android gets the same rule: the tap\'s five, and the message');
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
    assert.doesNotMatch(src, /isKeyboardDismissTap|tapKeepsKeyboard|__usernode_keyboard/, `${file} runs a second copy`);
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
  // And sends nothing but two messages: the dismiss, to a focused frame's
  // window (part 6), and the report, to its parent at its own origin only
  // (part 7), never a dismiss up or a report to any origin.
  assert.equal((src.match(/\.postMessage\(/g) || []).length, 2);
  assert.match(src, /frame\.contentWindow\.postMessage\(keyboardDismissMessage\(\), '\*'\)/);
  assert.match(src, /window\.parent\.postMessage\(keyboardTapMessage\(\), origin\(\)\)/);
  assert.doesNotMatch(src, /parent\.postMessage\(keyboardDismissMessage/);
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
  // The message a page sends a focused frame (part 6), named where every
  // app author reads what the kit does.
  assert.match(header, /\{ __usernode_keyboard: 'dismiss' \}/);
  // And the report a marked frame sends up (part 7).
  assert.match(header, /data-un-keyboard-relay[\s\S]*\{ __usernode_keyboard: 'tap' \}/);
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

// ── 6. Around a frame: the shell tells the app (request #4273) ──────────────
//
// With the field inside an app's frame, the shell's document.activeElement is
// the frame, and a tap on the shell's own chrome (its header, the space
// around a panel) reaches only the shell: the kit in the app never hears it.
// So the shell's listener, the same kit, posts `{ __usernode_keyboard:
// 'dismiss' }` to the focused frame, and the kit in the frame takes it from
// its parent window only, as the bridge takes the shell's other messages.

// The shell's frame for an app: an <iframe> whose window records (or
// delivers) what is posted to it, as the shell's #app-iframe would. What
// arrives is a structured clone, as postMessage delivers it.
function appFrame(p, attrs = {}, deliver = null) {
  const posted = [];
  const contentWindow = {
    postMessage(data, origin) {
      const copy = structuredClone(data);
      posted.push({ data: copy, origin });
      if (deliver) deliver(copy, origin);
    },
  };
  const el = node('iframe', attrs, p.body, { contentWindow, posted });
  return el;
}
const DISMISS = { __usernode_keyboard: 'dismiss' };

test('the message: one key in the bridge\'s family, and nothing else is it', () => {
  const { keyboardDismissMessage, isKeyboardDismissMessage } = physics;
  assert.deepEqual(keyboardDismissMessage(), DISMISS);
  assert.notEqual(keyboardDismissMessage(), keyboardDismissMessage(), 'a fresh object each time');
  assert.equal(isKeyboardDismissMessage(keyboardDismissMessage()), true);
  assert.equal(isKeyboardDismissMessage({ __usernode_keyboard: 'dismiss', extra: 1 }), true);
  for (const data of [null, undefined, '', 'dismiss', '__usernode_keyboard', 0, [],
    { __usernode_keyboard: 'show' }, { __usernode_keyboard: true }, { __usernode_theme: 'changed' }, {}]) {
    assert.equal(isKeyboardDismissMessage(data), false, JSON.stringify(data));
  }
});

test('the shell, with an app\'s frame focused: a tap on its own chrome tells the frame, and blurs nothing of its own', () => {
  const p = kitPage();
  const frame = appFrame(p, { id: 'app-iframe', 'data-app-slug': 'notes' });
  p.focus(frame);
  const title = p.el('span', {}, p.el('header', { class: 'app-header' }));
  p.tap(title);
  assert.deepEqual(frame.posted, [{ data: DISMISS, origin: '*' }],
    'to the frame\'s window, to any origin, as the shell\'s other messages to an app go');
  assert.equal(p.doc.activeElement, frame, 'the shell moves no focus: the frame still has it');
  p.tap(title);
  assert.equal(frame.posted.length, 2, 'every such tap, whatever the frame did with the last');
  assert.ok(p.listeners.every((l) => l.passive), 'passive: the tap and its click go on as they were');
  // Pointer events from a finger, where a page has no touch events.
  const q = kitPage({ touch: false });
  const other = appFrame(q);
  q.focus(other);
  q.tap(q.el('p'));
  assert.equal(other.posted.length, 1, 'a finger\'s pointer events');
});

test('a tap around the frame on something that keeps the keyboard, or that is no tap, tells it nothing', () => {
  const p = kitPage();
  const frame = appFrame(p, { id: 'app-iframe' });
  p.focus(frame);
  const header = p.el('header', { class: 'app-header' });
  const tabs = p.el('nav', { id: 'platform-tabs' });
  for (const [what, target] of [
    ['Back, in the header', p.el('svg', {}, p.el('button', { 'aria-label': 'Back' }, header))],
    ['a link', p.el('a', { href: '#home' }, header)],
    ['a tab', p.el('span', {}, p.el('div', { role: 'tab' }, tabs))],
    ['a pressable row', p.el('div', { class: 'un-pressable' })],
    ['inside data-keep-keyboard', p.el('p', {}, p.el('div', { 'data-keep-keyboard': '' }))],
    ['a shell field', p.el('input')],
  ]) {
    p.tap(target);
    assert.equal(frame.posted.length, 0, what);
  }
  for (const [what, opts] of [
    ['a scroll', { scroll: true }],
    ['a drag', { to: [120, 330] }],
    ['a long press', { ms: 800 }],
    ['two fingers', { fingers: 2 }],
    ['a cancelled touch', { cancel: true }],
    ['a tap a handler cancelled', { prevented: true }],
    ['a tap a handler stopped', { stopped: true }],
  ]) {
    p.tap(p.el('p', {}, header), opts);
    assert.equal(frame.posted.length, 0, what);
  }
  for (const pointerType of ['mouse', 'pen']) {
    const q = kitPage({ touch: false });
    const f = appFrame(q);
    q.focus(f);
    q.tap(q.el('p'), { pointerType });
    assert.equal(f.posted.length, 0, pointerType);
  }
  p.tap(p.el('p', {}, header));
  assert.equal(frame.posted.length, 1, 'and the next real tap on the header is heard');
});

test('the shell tells a frame only while it has focus, on a phone, and not when its own page opted out', () => {
  const p = kitPage();
  const frame = appFrame(p);
  p.tap(p.el('p'));
  assert.equal(frame.posted.length, 0, 'nothing focused');
  p.focus(frame);
  p.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
  p.tap(p.el('p'));
  assert.equal(frame.posted.length, 0, 'a page that turned the listener off');
  p.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'on');
  p.tap(p.el('p'));
  assert.equal(frame.posted.length, 1);

  const desk = kitPage({ platform: 'desktop' });
  const deskFrame = appFrame(desk);
  desk.focus(deskFrame);
  desk.tap(desk.el('p'));
  assert.equal(deskFrame.posted.length, 0, 'a desktop: no on-screen keyboard, no listener');
  assert.equal(desk.listeners.length, 0);

  // A frame mid-teardown (no window yet, or one that throws) is no error.
  const q = kitPage();
  const gone = q.el('iframe');
  q.focus(gone);
  assert.doesNotThrow(() => q.tap(q.el('p')));
  const broken = node('iframe', {}, q.body, { contentWindow: { postMessage() { throw new Error('detached'); } } });
  q.focus(broken);
  assert.doesNotThrow(() => q.tap(q.el('p')));
});

test('in the frame, the kit puts its field away when its parent says so, and only then', () => {
  const shell = { name: 'the shell' };
  const app = kitPage({ parent: shell });
  assert.equal(app.listeners.filter((l) => l.type === 'message').length, 1, 'one message listener, in a frame');
  const field = app.field('textarea');
  app.focus(field);
  for (const [what, event] of [
    ['another frame', { source: { name: 'a sibling' }, data: DISMISS }],
    ['a frame of its own', { source: { name: 'an embed' }, data: DISMISS }],
    ['itself', { source: app.win, data: DISMISS }],
    ['no source', { source: null, data: DISMISS }],
    ['another message', { source: shell, data: { __usernode_theme: 'changed', value: { theme: 'dark' } } }],
    ['another verb', { source: shell, data: { __usernode_keyboard: 'show' } }],
    ['a string', { source: shell, data: 'dismiss' }],
    ['nothing', { source: shell, data: null }],
  ]) {
    app.fire('message', event);
    assert.equal(field.blurs, 0, what);
  }
  app.fire('message', { source: shell, data: DISMISS });
  assert.equal(field.blurs, 1, 'from its parent');
  assert.equal(app.doc.activeElement, app.body);
  app.fire('message', { source: shell, data: DISMISS });
  assert.equal(field.blurs, 1, 'nothing focused, nothing to do');
});

test('in the frame, only a field that raises keys is put away, and the app\'s own opt-out holds', () => {
  const shell = {};
  for (const [extra, want] of [
    [{ type: 'text' }, 1],
    [{ type: 'checkbox' }, 0],
    [{ type: 'text', readOnly: true }, 0],
  ]) {
    const app = kitPage({ parent: shell });
    const el = app.field('input', {}, extra);
    app.focus(el);
    app.fire('message', { source: shell, data: DISMISS });
    assert.equal(el.blurs, want, JSON.stringify(extra));
  }
  for (const where of ['html', 'body']) {
    const app = kitPage({ parent: shell });
    const field = app.field('textarea');
    app.focus(field);
    app[where].setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
    app.fire('message', { source: shell, data: DISMISS });
    assert.equal(field.blurs, 0, `${where} says off`);
    app[where].setAttribute(physics.KB_DISMISS_OFF_ATTR, 'on');
    app.fire('message', { source: shell, data: DISMISS });
    assert.equal(field.blurs, 1, `${where}: any other value leaves it on`);
  }
});

test('a top-level page takes no dismiss message, even from itself; a desktop hears nothing', () => {
  // A top-level page listens too (request #4314: the side panel's frame
  // reports to it), but a dismiss is a parent's to send, and it has none.
  for (const [what, opts] of [['no parent', {}], ['a top window is its own parent', { parent: 'self' }]]) {
    const top = kitPage(opts);
    assert.equal(top.listeners.filter((l) => l.type === 'message').length, 1, what);
    const field = top.field('textarea');
    top.focus(field);
    for (const source of [top.win, null, undefined, {}]) {
      top.fire('message', { source, data: DISMISS, origin: ORIGIN });
    }
    assert.equal(field.blurs, 0, what);
  }
  assert.equal(kitPage({ platform: 'desktop', parent: {} }).listeners.length, 0, 'a framed desktop');
  assert.equal(kitPage({ platform: 'android', parent: {} }).listeners.length, 6, 'a framed phone: the same six');
});

test('end to end: a tap on the shell\'s header closes the keyboard of the field in the app, through every frame between', () => {
  // Messages are delivered as tasks, after the tap's own events: queued
  // here, and run once the tap is over.
  const tasks = [];
  const run = () => { while (tasks.length) tasks.shift()(); };
  const deliverTo = (page, from) => (data) => {
    tasks.push(() => page.fire('message', { source: from, data, origin: 'https://homeroom.test' }));
  };

  // The shell around one app.
  const shell = kitPage();
  const app = kitPage({ parent: shell.win });
  const frame = appFrame(shell, { id: 'app-iframe' }, deliverTo(app, shell.win));
  const field = app.field('input', {}, { type: 'text' });
  app.focus(field);
  shell.focus(frame);
  shell.tap(shell.el('div', {}, shell.el('header', { class: 'app-header' })));
  assert.equal(field.blurs, 0, 'the tap waits on nothing: the message comes after it');
  run();
  assert.equal(field.blurs, 1, 'the app\'s field lets go');
  assert.equal(app.doc.activeElement, app.body);

  // A tap on a control of the shell's (Back) leaves the app's field alone.
  app.focus(field);
  shell.tap(shell.el('button', { 'aria-label': 'Back' }));
  run();
  assert.equal(field.blurs, 1);

  // The platform inside a frame of its own (a preview of a change to it),
  // around an app: the message is passed down to the frame that holds the
  // field, and each hop is a parent speaking to its own frame.
  const outer = kitPage();
  const inner = kitPage({ parent: outer.win });
  const nested = kitPage({ parent: inner.win });
  const innerFrame = appFrame(outer, { id: 'preview' }, deliverTo(inner, outer.win));
  const appFrameInside = appFrame(inner, { id: 'app-iframe' }, deliverTo(nested, inner.win));
  const deep = nested.field('textarea');
  nested.focus(deep);
  inner.focus(appFrameInside);
  outer.focus(innerFrame);
  outer.tap(outer.el('p'));
  run();
  assert.equal(deep.blurs, 1, 'passed down to the frame that holds the field');
  assert.deepEqual(appFrameInside.posted.map((m) => m.data), [DISMISS]);

  // An app that opted out keeps its field, whatever the shell heard.
  const shell2 = kitPage();
  const optedOut = kitPage({ parent: shell2.win });
  optedOut.body.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
  const frame2 = appFrame(shell2, {}, deliverTo(optedOut, shell2.win));
  const kept = optedOut.field('textarea');
  optedOut.focus(kept);
  shell2.focus(frame2);
  shell2.tap(shell2.el('p'));
  run();
  assert.equal(frame2.posted.length, 1, 'the shell still tells it');
  assert.equal(kept.blurs, 0, 'the app keeps its keyboard');
});

// ── 7. From the side panel: the panel tells the shell (request #4314) ───────
//
// On iPad Safari the side panel is the platform's own document
// (`/?panel=1`) in a frame beside the app. With the app's field up, a tap in
// the panel reaches only the panel, whose kit has no field of its own, so
// neither the shell nor the app ever heard it. The shell marks the panel's
// frame `data-un-keyboard-relay`; the kit in a frame so marked reports a tap
// that closes the keyboard with `{ __usernode_keyboard: 'tap' }`, and the
// shell takes that from such a frame of its own, of its own origin, and does
// what it does for a tap on its own chrome.

const TAP = { __usernode_keyboard: 'tap' };

// The shell's #side-panel-frame: marked to relay, in the shell's document.
function panelFrame(shell, attrs = { id: 'side-panel-frame', 'data-un-keyboard-relay': '' }) {
  return node('iframe', attrs, shell.body, { ownerDocument: shell.doc, contentWindow: {} });
}
// A parent window that records what a frame posts to it.
function recordingParent() {
  const posted = [];
  return { posted, postMessage(data, origin) { posted.push({ data: structuredClone(data), origin }); } };
}

test('the report: its own verb in the same family, and neither message is the other', () => {
  const { keyboardTapMessage, isKeyboardTapMessage, isKeyboardDismissMessage, KB_RELAY_ATTR } = physics;
  assert.equal(KB_RELAY_ATTR, 'data-un-keyboard-relay');
  assert.deepEqual(keyboardTapMessage(), TAP);
  assert.notEqual(keyboardTapMessage(), keyboardTapMessage(), 'a fresh object each time');
  assert.equal(isKeyboardTapMessage(TAP), true);
  assert.equal(isKeyboardTapMessage(DISMISS), false);
  assert.equal(isKeyboardDismissMessage(TAP), false);
  for (const data of [null, undefined, '', 'tap', 0, [], { __usernode_keyboard: 'show' }, {}]) {
    assert.equal(isKeyboardTapMessage(data), false, JSON.stringify(data));
  }
});

test('in the panel, with no field of its own: a tap that closes the keyboard is reported to the shell', () => {
  const shell = recordingParent();
  const p = kitPage({ parent: shell, frameElement: node('iframe', { 'data-un-keyboard-relay': '' }) });
  p.tap(p.el('p', {}, p.el('div', { class: 'transcript' })));
  assert.deepEqual(shell.posted, [{ data: TAP, origin: ORIGIN }],
    'to the parent, at the panel\'s own origin: only a parent of that origin can see it');
  // The same exceptions as a tap on any page, checked where it landed.
  for (const [what, target] of [
    ['a button', p.el('svg', {}, p.el('button', { 'aria-label': 'Back' }))],
    ['a link', p.el('a', { href: '#messages' })],
    ['a tab', p.el('span', {}, p.el('div', { role: 'tab' }))],
    ['a pressable row', p.el('div', { class: 'un-pressable' })],
    ['inside data-keep-keyboard', p.el('p', {}, p.el('div', { 'data-keep-keyboard': '' }))],
    ['a field', p.el('textarea')],
  ]) {
    p.tap(target);
    assert.equal(shell.posted.length, 1, what);
  }
  for (const [what, opts] of [
    ['a scroll', { scroll: true }], ['a drag', { to: [120, 330] }], ['a long press', { ms: 800 }],
    ['two fingers', { fingers: 2 }], ['a cancelled touch', { cancel: true }],
    ['a tap a handler cancelled', { prevented: true }], ['a tap a handler stopped', { stopped: true }],
  ]) {
    p.tap(p.el('p'), opts);
    assert.equal(shell.posted.length, 1, what);
  }
  p.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
  p.tap(p.el('p'));
  assert.equal(shell.posted.length, 1, 'the panel\'s own page opted out');
  p.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'on');
  p.tap(p.el('p'));
  assert.equal(shell.posted.length, 2, 'and the next real tap is heard');

  // With a field of its own focused, the panel puts that away and says nothing.
  const field = p.field('input', {}, { type: 'text' });
  p.focus(field);
  p.tap(p.el('p'));
  assert.equal(field.blurs, 1);
  assert.equal(shell.posted.length, 2);
});

test('only a frame its parent marked reports, and a parent of another origin cannot mark one', () => {
  for (const [what, opts] of [
    ['an unmarked frame (an app in the shell)', { frameElement: node('iframe', { id: 'app-iframe' }) }],
    ['a parent of another origin: frameElement is null', { frameElement: null }],
    ['a frameElement that throws', { frameElement: { tagName: 'IFRAME', getAttribute() { throw new Error('gone'); } } }],
  ]) {
    const shell = recordingParent();
    const p = kitPage({ parent: shell, ...opts });
    p.tap(p.el('p'));
    assert.equal(shell.posted.length, 0, what);
  }
  // A top-level page has no parent to report to, even marked.
  const top = kitPage({ parent: 'self', frameElement: node('iframe', { 'data-un-keyboard-relay': '' }) });
  top.win.postMessage = () => assert.fail('a top window posted to itself');
  top.tap(top.el('p'));
  // A desktop has no listener at all.
  const desk = recordingParent();
  const d = kitPage({ platform: 'desktop', parent: desk, frameElement: node('iframe', { 'data-un-keyboard-relay': '' }) });
  d.tap(d.el('p'));
  assert.equal(desk.posted.length, 0, 'a desktop');
  // A parent mid-teardown is no error.
  const gone = kitPage({ parent: { postMessage() { throw new Error('detached'); } },
    frameElement: node('iframe', { 'data-un-keyboard-relay': '' }) });
  assert.doesNotThrow(() => gone.tap(gone.el('p')));
});

test('the shell takes a report only from its own marked frame, of its own origin', () => {
  const shell = kitPage();
  const app = appFrame(shell, { id: 'app-iframe' });
  const panel = panelFrame(shell);
  const panelWin = { frameElement: panel };
  shell.focus(app);
  const other = kitPage();
  for (const [what, event] of [
    ['an unmarked frame', { source: { frameElement: appFrame(shell) }, data: TAP, origin: ORIGIN }],
    ['another origin', { source: panelWin, data: TAP, origin: 'https://notes.apps.homeroom.test' }],
    ['no origin', { source: panelWin, data: TAP }],
    ['no source', { source: null, data: TAP, origin: ORIGIN }],
    ['a window with no frame', { source: {}, data: TAP, origin: ORIGIN }],
    ['a marked frame in another document', { source: { frameElement: panelFrame(other) }, data: TAP, origin: ORIGIN }],
    ['a window that throws', { source: { get frameElement() { throw new Error('cross-origin'); } }, data: TAP, origin: ORIGIN }],
    ['another verb', { source: panelWin, data: { __usernode_keyboard: 'show' }, origin: ORIGIN }],
    ['a dismiss, which only a parent sends', { source: panelWin, data: DISMISS, origin: ORIGIN }],
  ]) {
    shell.fire('message', event);
    assert.equal(app.posted.length, 0, what);
  }
  shell.fire('message', { source: panelWin, data: TAP, origin: ORIGIN });
  assert.deepEqual(app.posted, [{ data: DISMISS, origin: '*' }], 'the focused app frame is told, as for a tap on the shell');

  // Its own field is blurred, the shell's rule for its own taps.
  const field = shell.field('input', {}, { type: 'text' });
  shell.focus(field);
  shell.fire('message', { source: panelWin, data: TAP, origin: ORIGIN });
  assert.equal(field.blurs, 1);
  assert.equal(app.posted.length, 1);

  // The panel itself focused: it already had the tap; nothing goes back to it.
  panel.contentWindow.postMessage = () => assert.fail('told the frame the report came from');
  shell.focus(panel);
  shell.fire('message', { source: panelWin, data: TAP, origin: ORIGIN });

  // The shell's own opt-out holds.
  shell.focus(app);
  shell.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
  shell.fire('message', { source: panelWin, data: TAP, origin: ORIGIN });
  assert.equal(app.posted.length, 1, 'the shell opted out');
});

test('end to end: a tap in the side panel closes the keyboard of the field in the app beside it', () => {
  const tasks = [];
  const run = () => { while (tasks.length) tasks.shift()(); };

  function rig({ panelOff = false, appOff = false } = {}) {
    const shell = kitPage();
    // The shell's #app-iframe, delivering to the app as a browser would.
    const app = kitPage({ parent: shell.win, origin: 'https://notes.apps.homeroom.test' });
    const appEl = appFrame(shell, { id: 'app-iframe' }, (data) => {
      tasks.push(() => app.fire('message', { source: shell.win, data, origin: ORIGIN }));
    });
    // The shell's #side-panel-frame, with the platform's own page in it.
    const panelEl = panelFrame(shell);
    const panel = kitPage({ parent: shell.win, frameElement: panelEl });
    panelEl.contentWindow = panel.win;
    // A message reaches the shell only at the shell's own origin.
    shell.win.postMessage = (data, targetOrigin) => {
      if (targetOrigin !== '*' && targetOrigin !== shell.win.location.origin) return;
      const copy = structuredClone(data);
      tasks.push(() => shell.fire('message', { source: panel.win, data: copy, origin: panel.win.location.origin }));
    };
    if (panelOff) panel.body.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
    if (appOff) app.body.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
    const field = app.field('textarea');
    app.focus(field);
    shell.focus(appEl);
    return { shell, app, appEl, panel, field };
  }

  const r = rig();
  r.panel.tap(r.panel.el('p', {}, r.panel.el('div', { class: 'message-list' })));
  assert.equal(r.field.blurs, 0, 'posted, never waited on');
  run();
  assert.equal(r.field.blurs, 1, 'panel to shell to app: the app\'s field lets go');
  assert.equal(r.app.doc.activeElement, r.app.body);
  assert.deepEqual(r.appEl.posted.map((m) => m.data), [DISMISS]);

  // A control in the panel (its Send, a tab, a row) keeps the app's keyboard.
  r.app.focus(r.field);
  for (const target of [
    r.panel.el('button', { 'aria-label': 'Send' }),
    r.panel.el('div', { role: 'tab' }),
    r.panel.el('li', { class: 'un-pressable' }),
    r.panel.el('span', {}, r.panel.el('div', { 'data-keep-keyboard': '' })),
  ]) {
    r.panel.tap(target);
    run();
  }
  assert.equal(r.field.blurs, 1, 'the panel\'s controls keep it');

  const panelOff = rig({ panelOff: true });
  panelOff.panel.tap(panelOff.panel.el('p'));
  run();
  assert.equal(panelOff.field.blurs, 0, 'the panel\'s page opted out: nothing is reported');

  const appOff = rig({ appOff: true });
  appOff.panel.tap(appOff.panel.el('p'));
  run();
  assert.equal(appOff.appEl.posted.length, 1, 'the shell still tells the app');
  assert.equal(appOff.field.blurs, 0, 'an app that opted out keeps its keyboard');
});
