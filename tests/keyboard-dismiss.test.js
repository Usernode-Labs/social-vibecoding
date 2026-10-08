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
//   7. up from a frame (request #4314): the shell's side panel is a frame
//      of its own, and while someone types in the app beside it a tap in
//      the panel reaches only the panel's document. Its kit, nothing
//      focused of its own, tells its parent, and the shell applies the
//      same rule: its own field, or the focused app frame's.
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
function kitPage({ platform = 'ios', touch = true, parent = null } = {}) {
  const p = page({ touch });
  if (parent) p.win.parent = parent === 'self' ? p.win : parent;
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
  assert.equal(kitPage({ platform: 'android' }).listeners.length, 6, 'Android gets the same rule, and hears its side panel');
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
  // And sends nothing but the two messages: down to a focused frame's
  // window (part 6), and, from a frame with nothing focused of its own,
  // up to its parent (part 7). Each its own verb, so no listener mistakes
  // one direction for the other.
  assert.equal((src.match(/\.postMessage\(/g) || []).length, 2);
  assert.match(src, /frame\.contentWindow\.postMessage\(keyboardDismissMessage\(\), '\*'\)/);
  assert.match(src, /window\.parent\.postMessage\(keyboardDismissParentMessage\(\), '\*'\)/);
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
  // app author reads what the kit does, and the one a framed page sends
  // up to its parent (part 7).
  assert.match(header, /\{ __usernode_keyboard: 'dismiss' \}/);
  assert.match(header, /\{ __usernode_keyboard: 'dismiss-parent' \}/);
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

test('a top-level page hears no parent\'s dismissal, a desktop nothing at all', () => {
  // A top-level page (the shell) keeps the one message listener part 7
  // gives it — for the side panel's tap report, never a parent's dismiss:
  // it has no parent to hear one from, and no listener acts on one.
  assert.equal(kitPage().listeners.filter((l) => l.type === 'message').length, 1, 'no parent, one panel listener');
  const top = kitPage({ parent: 'self' });
  assert.equal(top.listeners.filter((l) => l.type === 'message').length, 1, 'a top window is its own parent');
  const field = top.field('textarea');
  top.focus(field);
  top.fire('message', { source: { name: 'whoever' }, data: DISMISS });
  top.fire('message', { source: top.win, data: DISMISS });
  assert.equal(field.blurs, 0, 'nobody tells a top-level page to dismiss');
  assert.equal(kitPage({ platform: 'desktop', parent: {} }).listeners.length, 0, 'a framed desktop');
  assert.equal(kitPage({ platform: 'android', parent: {} }).listeners.length, 6, 'a framed phone: the tap\'s five, and the message');
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

// ── 7. Up from a frame: the side panel tells the shell (request #4314) ──────
//
// The shell's side panel is a frame of its own. While someone types in the
// app beside it, a tap in the panel reaches only the panel's document: its
// kit sees no field of its own, the shell and the app never hear the tap,
// and iPad Safari leaves the keyboard up. So in a framed page the finger is
// tracked whatever is focused here, and a qualifying tap on something that
// keeps no keyboard asks its parent to apply the rule —
// `{ __usernode_keyboard: 'dismiss-parent' }`, up to window.parent. The
// shell takes that from its #side-panel-frame only, and does what its own
// tap would have: blurs its own focused field, or tells the focused app
// frame.

// A parent window: records what is posted up to it, as postMessage
// delivers it.
function parentWindow(deliver = null) {
  const posted = [];
  return {
    posted,
    postMessage(data, origin) {
      const copy = structuredClone(data);
      posted.push({ data: copy, origin });
      if (deliver) deliver(copy, origin);
    },
  };
}
const DISMISS_PARENT = { __usernode_keyboard: 'dismiss-parent' };

test('the up-message: one key in the bridge\'s family, a verb of its own', () => {
  const { keyboardDismissParentMessage, isKeyboardDismissParentMessage, isKeyboardDismissMessage } = physics;
  assert.deepEqual(keyboardDismissParentMessage(), DISMISS_PARENT);
  assert.notEqual(keyboardDismissParentMessage(), keyboardDismissParentMessage(), 'a fresh object each time');
  assert.equal(isKeyboardDismissParentMessage(keyboardDismissParentMessage()), true);
  assert.equal(isKeyboardDismissParentMessage({ ...DISMISS_PARENT, extra: 1 }), true);
  // Each direction's listener takes its own verb and nothing else.
  assert.equal(isKeyboardDismissMessage(DISMISS_PARENT), false);
  assert.equal(isKeyboardDismissParentMessage(DISMISS), false);
  for (const data of [null, undefined, '', 'dismiss-parent', 0, [],
    { __usernode_keyboard: 'dismiss' }, { __usernode_keyboard: 'show' }, { __usernode_theme: 'changed' }, {}]) {
    assert.equal(isKeyboardDismissParentMessage(data), false, JSON.stringify(data));
  }
});

test('a tap in a frame with nothing focused of its own asks the parent to dismiss', () => {
  const parent = parentWindow();
  const p = kitPage({ parent });
  const text = p.el('p', {}, p.el('div', { class: 'transcript' }));
  p.tap(text);
  assert.deepEqual(parent.posted, [{ data: DISMISS_PARENT, origin: '*' }],
    'up to the parent window, to any origin, as the down-message goes');
  p.tap(text);
  assert.equal(parent.posted.length, 2, 'every such tap, whatever the parent did with the last');
  // With something focused here the down-rule stands, and the parent hears
  // nothing: this page still puts its own field away.
  const composer = p.field('textarea');
  p.focus(composer);
  p.tap(text);
  assert.equal(composer.blurs, 1);
  assert.equal(parent.posted.length, 2, 'its own field is not the parent\'s problem');
  // And a frame focused here is told directly, as before (part 6).
  const inner = appFrame(p);
  p.focus(inner);
  p.tap(text);
  assert.equal(inner.posted.length, 1);
  assert.equal(parent.posted.length, 2);
});

test('in a frame with nothing focused, the same exceptions keep the keyboard', () => {
  const parent = parentWindow();
  const p = kitPage({ parent });
  const header = p.el('header', { class: 'side-panel-head' });
  const tabs = p.el('nav');
  for (const [what, target] of [
    ['a field', p.el('input')],
    ['a button', p.el('button', { 'aria-label': 'Close panel' }, header)],
    ['a link', p.el('a', { href: '#x' })],
    ['a tab', p.el('span', {}, p.el('div', { role: 'tab' }, tabs))],
    ['a pressable row', p.el('div', { class: 'un-pressable' })],
    ['inside data-keep-keyboard', p.el('p', {}, p.el('div', { 'data-keep-keyboard': '' }))],
  ]) {
    p.tap(target);
    assert.equal(parent.posted.length, 0, what);
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
    p.tap(p.el('p'), opts);
    assert.equal(parent.posted.length, 0, what);
  }
  for (const pointerType of ['mouse', 'pen']) {
    const q = kitPage({ parent: parentWindow(), touch: false });
    q.tap(q.el('p'), { pointerType });
    assert.equal(q.win.parent.posted.length, 0, pointerType);
  }
  p.tap(p.el('p'));
  assert.equal(parent.posted.length, 1, 'and the next real tap is carried up');
});

test('a frame that turned the listener off carries nothing up', () => {
  for (const where of ['html', 'body']) {
    const parent = parentWindow();
    const p = kitPage({ parent });
    p[where].setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
    p.tap(p.el('p'));
    assert.equal(parent.posted.length, 0, where);
    p[where].setAttribute(physics.KB_DISMISS_OFF_ATTR, 'on');
    p.tap(p.el('p'));
    assert.equal(parent.posted.length, 1, `${where}: any other value leaves it on`);
  }
});

test('the shell answers the panel: its own field, or the frame the keyboard is up behind', () => {
  // The keyboard is up behind the app beside the panel: the shell tells
  // that frame, and moves no focus of its own.
  const p = kitPage();
  const panel = appFrame(p, { id: 'side-panel-frame' });
  const app = appFrame(p, { id: 'app-iframe' });
  p.doc.getElementById = (id) => (id === 'side-panel-frame' ? panel : id === 'app-iframe' ? app : null);
  p.focus(app);
  p.fire('message', { source: panel.contentWindow, data: DISMISS_PARENT });
  assert.deepEqual(app.posted, [{ data: DISMISS, origin: '*' }]);
  assert.equal(p.doc.activeElement, app, 'the frame still has it');

  // The keyboard is up behind a field of the shell's own: it puts that away.
  const q = kitPage();
  const qPanel = appFrame(q, { id: 'side-panel-frame' });
  q.doc.getElementById = (id) => (id === 'side-panel-frame' ? qPanel : null);
  const search = q.field('input', {}, { type: 'text' });
  q.focus(search);
  q.fire('message', { source: qPanel.contentWindow, data: DISMISS_PARENT });
  assert.equal(search.blurs, 1);
  assert.equal(q.doc.activeElement, q.body);
  q.fire('message', { source: qPanel.contentWindow, data: DISMISS_PARENT });
  assert.equal(search.blurs, 1, 'nothing focused, nothing to do');
});

test('the shell takes the up-message from the panel\'s window only', () => {
  const p = kitPage();
  const panel = appFrame(p, { id: 'side-panel-frame' });
  const app = appFrame(p, { id: 'app-iframe' });
  p.doc.getElementById = (id) => (id === 'side-panel-frame' ? panel : id === 'app-iframe' ? app : null);
  p.focus(app);
  for (const [what, event] of [
    ['an app frame\'s report of its own tap', { source: app.contentWindow, data: DISMISS_PARENT }],
    ['another window', { source: { name: 'elsewhere' }, data: DISMISS_PARENT }],
    ['itself', { source: p.win, data: DISMISS_PARENT }],
    ['no source', { source: null, data: DISMISS_PARENT }],
    ['the down-message, from the panel', { source: panel.contentWindow, data: DISMISS }],
    ['another verb', { source: panel.contentWindow, data: { __usernode_keyboard: 'show' } }],
    ['another family', { source: panel.contentWindow, data: { __usernode_theme: 'changed' } }],
    ['a string', { source: panel.contentWindow, data: 'dismiss-parent' }],
    ['nothing', { source: panel.contentWindow, data: null }],
  ]) {
    p.fire('message', event);
    assert.equal(app.posted.length, 0, what);
  }
  // The frame is looked up as the message lands: a page with no side
  // panel matches nothing, whoever speaks.
  const bare = kitPage();
  const bareApp = appFrame(bare, { id: 'app-iframe' });
  bare.doc.getElementById = () => null;
  bare.focus(bareApp);
  bare.fire('message', { source: bareApp.contentWindow, data: DISMISS_PARENT });
  assert.equal(bareApp.posted.length, 0, 'no panel frame, no answer');
  // And the shell's own opt-out holds, as its taps follow it.
  const off = kitPage();
  const offPanel = appFrame(off, { id: 'side-panel-frame' });
  off.doc.getElementById = (id) => (id === 'side-panel-frame' ? offPanel : null);
  const field = off.field('textarea');
  off.focus(field);
  off.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
  off.fire('message', { source: offPanel.contentWindow, data: DISMISS_PARENT });
  assert.equal(field.blurs, 0, 'the shell turned its listener off');
  off.html.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'on');
  off.fire('message', { source: offPanel.contentWindow, data: DISMISS_PARENT });
  assert.equal(field.blurs, 1, 'any other value leaves it on');
});

test('end to end: a tap in the side panel closes the keyboard of the app beside it', () => {
  // Messages are delivered as tasks, after the tap's own events: queued
  // here, and run once the tap is over.
  const tasks = [];
  const run = () => { while (tasks.length) tasks.shift()(); };
  const deliverTo = (page, from) => (data) => {
    tasks.push(() => page.fire('message', { source: from, data, origin: 'https://homeroom.test' }));
  };
  // A parent window that records what a framed page posts up to it, and
  // delivers it to the parent page as a message from the frame's window.
  const upTo = (page) => {
    const source = { win: null };
    const win = {
      postMessage(data, origin) {
        const copy = structuredClone(data);
        tasks.push(() => page.fire('message', { source: source.win, data: copy, origin }));
      },
    };
    return { win, from: source };
  };

  // The shell, the app beside the panel, and the panel's page.
  const shell = kitPage();
  const app = kitPage({ parent: shell.win });
  const panelUp = upTo(shell);
  const panelPage = kitPage({ parent: panelUp.win });
  panelUp.from.win = panelPage.win;
  const panel = appFrame(shell, { id: 'side-panel-frame' });
  panel.contentWindow = panelPage.win; // the frame's window IS the panel's
  shell.doc.getElementById = (id) => (id === 'side-panel-frame' ? panel : null);
  const frame = appFrame(shell, { id: 'app-iframe' }, deliverTo(app, shell.win));
  const field = app.field('input', {}, { type: 'text' });
  app.focus(field);
  shell.focus(frame);

  // A tap on plain text in the panel: up to the shell, then down to the
  // app, whose field lets go.
  panelPage.tap(panelPage.el('p'));
  assert.equal(field.blurs, 0, 'the tap waits on nothing');
  run();
  assert.equal(field.blurs, 1, 'the app\'s field lets go');
  assert.equal(app.doc.activeElement, app.body);

  // A tap on a control of the panel's (Close) keeps the app's keyboard.
  app.focus(field);
  panelPage.tap(panelPage.el('button', { 'aria-label': 'Close panel' }));
  run();
  assert.equal(field.blurs, 1);

  // The keyboard behind a field of the shell's own: the panel's tap puts
  // that away too.
  const search = shell.field('input', {}, { type: 'text' });
  shell.focus(search);
  panelPage.tap(panelPage.el('p'));
  run();
  assert.equal(search.blurs, 1);
  assert.equal(shell.doc.activeElement, shell.body);

  // A panel page that opted out carries nothing up, whatever is up beside it.
  const shell2 = kitPage();
  const quietUp = upTo(shell2);
  const quiet = kitPage({ parent: quietUp.win });
  quiet.body.setAttribute(physics.KB_DISMISS_OFF_ATTR, 'off');
  const frame2 = appFrame(shell2, { id: 'app-iframe' });
  shell2.focus(frame2);
  quiet.tap(quiet.el('p'));
  run();
  assert.equal(frame2.posted.length, 0, 'the panel keeps its peace');
});
