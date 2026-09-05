// Drive the head's boot watchdog for real, in Node.
//
// The watchdog is an inline classic script in frontend/src/head.html, so
// nothing can require it. The tests used to pin its SOURCE with regexes,
// which proves a line is present and nothing about what it does; the two
// flaws found on a real device (#1675) were both in lines the pins already
// covered. This evaluates the script in a `vm` context against a fake
// document, a fake window and a clock the test advances by hand, so a test
// can put an empty overlay on top, let eight seconds pass, and read the
// panel that painted.
//
// The fakes are the minimum the script touches. Anything it reaches for that
// is not here throws, which the script is written to survive -- so a test
// that wants a guarantee must assert the outcome, not the absence of a throw.

'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/** The watchdog IIFE, cut out of the head source. */
function watchdogSource() {
  const head = fs.readFileSync(path.join(ROOT, 'frontend/src/head.html'), 'utf8');
  const at = head.indexOf('The boot watchdog');
  if (at < 0) throw new Error('the boot watchdog is not in the head');
  const block = head.slice(at, head.indexOf('</script>', at));
  return block.slice(block.indexOf('(function () {'));
}

/**
 * A clock with two faces. `now` is what timers run on; `wall` is what
 * `Date.now()` answers. `suspend(ms)` moves the wall without running a
 * timer, which is what an app switch does to a WebView: the deadline fires
 * on resume, late by the whole absence.
 */
function makeClock() {
  let now = 0;
  let wallOffset = 0;
  let seq = 0;
  const timers = [];
  const clock = {
    get now() { return now; },
    get wall() { return now + wallOffset; },
    suspend(ms) { wallOffset += ms; },
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.push({ id, at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Run every timer due within the next `ms`, in order, then land there. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers.find((t) => t.at <= target);
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending() { return timers.length; },
  };
  return clock;
}

/**
 * A fake element. `text` becomes its own text node; `innerText` defaults to
 * that text, and can be set separately to model text that lives in a
 * descendant. `rect` and `bg` feed the painted-box rule.
 */
function makeElement(tag, opts = {}, registry) {
  const classes = opts.classes || [];
  const classList = Object.assign([...classes], {
    contains(c) { return classes.includes(c); },
  });
  const el = {
    tagName: tag.toUpperCase(),
    id: opts.id || '',
    hidden: !!opts.hidden,
    classList,
    className: classes.join(' '),
    style: {},
    children: [],
    firstChild: null,
    innerText: opts.innerText != null ? opts.innerText : (opts.text || ''),
    src: opts.src,
    href: opts.href,
    _rect: opts.rect || { width: 0, height: 0 },
    _bg: opts.bg || 'rgba(0, 0, 0, 0)',
    _textContent: '',
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = String(v); },
    appendChild(child) {
      this.children.push(child);
      if (child.id && registry) registry.set(child.id, child);
      return child;
    },
    setAttribute(k, v) { this['attr:' + k] = v; },
    addEventListener() { /* the retry button's click is not exercised */ },
    getBoundingClientRect() { return this._rect; },
  };
  if (opts.text) el.firstChild = { nodeType: 3, nodeValue: opts.text, nextSibling: null };
  return el;
}

/**
 * Boot the watchdog against a document.
 *
 *   topAt            what elementFromPoint returns: an element, or (x, y) => element
 *   screens          what querySelectorAll('[id$="-screen"], #app-view') returns
 *   readyState       'loading' | 'interactive' | 'complete' (default complete)
 *   visibilityState  'visible' | 'hidden'
 *   location         { pathname, search, hash }
 *   globals          extra properties to put on window (App, UsernodeReact, ...)
 */
function bootWatchdog(opts = {}) {
  const clock = makeClock();
  const registry = new Map();
  const make = (tag, o) => makeElement(tag, o, registry);

  const body = make('body');
  const html = make('html');
  const doc = {
    readyState: opts.readyState || 'complete',
    visibilityState: opts.visibilityState || 'visible',
    body,
    documentElement: html,
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    dispatch(type, ev = {}) { for (const fn of [...(this._listeners[type] || [])]) fn({ type, ...ev }); },
    getElementById(id) { return registry.get(id) || null; },
    createElement(tag) { return make(tag); },
    querySelectorAll() { return opts.screens || []; },
    elementFromPoint(x, y) {
      const t = win._topAt;
      return typeof t === 'function' ? t(x, y) : (t || null);
    },
  };

  const win = {
    document: doc,
    innerWidth: opts.innerWidth != null ? opts.innerWidth : 390,
    innerHeight: opts.innerHeight != null ? opts.innerHeight : 780,
    navigator: { onLine: opts.onLine != null ? opts.onLine : true, serviceWorker: opts.serviceWorker },
    location: { pathname: '/', search: '', hash: '', ...(opts.location || {}) },
    performance: { now: () => clock.now },
    getComputedStyle(el) { return { backgroundColor: el && el._bg }; },
    _listeners: {},
    _topAt: opts.topAt || null,
    addEventListener(type, fn, capture) { (this._listeners[type] ||= []).push({ fn, capture: !!capture }); },
    /**
     * Fire an event on window. `bubbles: false` models a resource `error`,
     * which the browser delivers to capture listeners only.
     */
    dispatch(type, ev = {}, { bubbles = true } = {}) {
      for (const l of [...(this._listeners[type] || [])]) {
        if (bubbles || l.capture) l.fn({ type, ...ev });
      }
    },
    ...(opts.globals || {}),
  };
  win.window = win;

  const context = vm.createContext({
    window: win,
    document: doc,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: () => clock.wall },
    URLSearchParams,
    URL,
  });
  vm.runInContext(watchdogSource(), context, { filename: 'head.html#boot-watchdog' });

  return {
    win,
    doc,
    clock,
    /** Change what is on top from here on. */
    setTop(topAt) { win._topAt = topAt; },
    panel() { return doc.getElementById('boot-watchdog'); },
    errorsShown() { return doc.getElementById('boot-watchdog-errors'); },
    state() {
      const el = doc.getElementById('boot-watchdog-state');
      return el ? el.textContent : null;
    },
    /** The boot record, as plain data: the vm context has its own Array. */
    record() { return JSON.parse(JSON.stringify(win.__unBoot)); },
    make,
  };
}

module.exports = { bootWatchdog, makeClock, makeElement, watchdogSource };
