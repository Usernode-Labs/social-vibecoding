'use strict';

// #3618 — an app you close shrinks into its Resume button, and Resume grows
// it back out.
//
//   frontend/src/features/nav/resume-motion.ts  the control, the origin and
//                                               the stand-in card
//   frontend/src/features/nav/recents-list.tsx  the Active row's Resume pill
//   frontend/src/features/nav/parked-strip.tsx  the phone strip's origin
//   public/js/app.js                            measuring and the zooms
//   public/usernode-native/v1/native.js         the caller-supplied duration
//   public/css/app.css                          the pill and the stand-in
//   dapp.json                                   the kept-apps check
//
// The motion module is EXERCISED, not grepped: the small DOM below is enough
// for its control lookup, its origin lifetime and the stand-in's lifecycle,
// and the rest is pinned where it lives (the two callers, the router and the
// kit) the way the surrounding suites pin their own wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── A tiny DOM, enough for resume-motion.ts ─────────────────────────────

class ClassList {
  constructor() { this.set = new Set(); }
  contains(name) { return this.set.has(name); }
  add(...names) { for (const name of names) this.set.add(name); }
  remove(name) { this.set.delete(name); }
  toggle(name, on) {
    if (on === undefined) { if (this.set.has(name)) this.set.delete(name); else this.set.add(name); }
    else if (on) this.set.add(name); else this.set.delete(name);
  }
}

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.classList = new ClassList();
    this.attrs = new Map();
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.isConnected = false;
    this.listeners = {};
    this.offsetWidth = 1;
    this._rect = { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
  }

  get className() { return [...this.classList.set].join(' '); }
  set className(value) {
    this.classList = new ClassList();
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classList.add(name);
  }

  setAttribute(name, value) { this.attrs.set(String(name), String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }

  appendChild(child) {
    child.parent = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
    this.isConnected = false;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    for (const fn of this.listeners[event.type] || []) fn(event);
    return true;
  }

  getBoundingClientRect() { return this._rect; }

  querySelector(selector) { return queryAll(this, selector)[0] || null; }
  querySelectorAll(selector) { return queryAll(this, selector); }

  cloneNode() {
    const copy = new El(this.tagName);
    copy.className = this.className;
    for (const [name, value] of this.attrs) copy.attrs.set(name, value);
    copy._rect = { ...this._rect };
    for (const child of this.children) copy.appendChild(child.cloneNode());
    return copy;
  }
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function make(tag, options = {}) {
  const el = new El(tag);
  if (options.id) {
    el.id = options.id;
    el.attrs.set('id', options.id);
  }
  if (options.className) el.className = options.className;
  for (const [name, value] of Object.entries(options.dataset || {})) {
    el.dataset[name] = String(value);
    el.attrs.set(`data-${kebab(name)}`, String(value));
  }
  for (const [name, value] of Object.entries(options.attrs || {})) {
    el.attrs.set(name, String(value));
  }
  if (options.rect) setRect(el, options.rect);
  return el;
}

function setRect(el, { top = 0, left = 0, width = 0, height = 0 }) {
  el._rect = { top, left, width, height, bottom: top + height, right: left + width };
  return el;
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) { out.push(child); walk(child); }
  };
  walk(root);
  return out;
}

function parseSimple(part) {
  const match = String(part).trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!match) return null;
  const simple = { tag: match[1] ? match[1].toLowerCase() : null, classes: [], ids: [], attrs: [] };
  for (const token of (match[2] || '').match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
    if (token[0] === '.') simple.classes.push(token.slice(1));
    else if (token[0] === '#') simple.ids.push(token.slice(1));
    else {
      const body = token.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) simple.attrs.push({ name: body.trim() });
      else {
        simple.attrs.push({
          name: body.slice(0, eq).trim(),
          value: body.slice(eq + 1).trim().replace(/^["']|["']$/g, ''),
        });
      }
    }
  }
  return simple;
}

function matches(el, simple) {
  if (!simple) return false;
  if (simple.tag && el.tagName !== simple.tag.toUpperCase()) return false;
  for (const name of simple.classes) if (!el.classList.contains(name)) return false;
  for (const id of simple.ids) if (el.getAttribute('id') !== id) return false;
  for (const attr of simple.attrs) {
    if (!el.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && el.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const parts = String(selector).split('>').map((part) => part.trim());
  if (parts.length === 2 && parts[0] === ':scope') {
    const simple = parseSimple(parts[1]);
    return root.children.filter((child) => matches(child, simple));
  }
  if (parts.length === 2) {
    const parent = parseSimple(parts[0]);
    const child = parseSimple(parts[1]);
    const out = [];
    for (const node of descendants(root)) {
      if (!matches(node, parent)) continue;
      for (const candidate of node.children) if (matches(candidate, child)) out.push(candidate);
    }
    return out;
  }
  const simple = parseSimple(parts[0]);
  return descendants(root).filter((node) => matches(node, simple));
}

function makeDocument(motion) {
  const body = new El('body');
  const documentElement = new El('html');
  const findById = (node, id) => {
    if (node.getAttribute('id') === id) return node;
    for (const child of node.children) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };
  const document = {
    documentElement,
    body,
    getElementById: (id) => findById(body, id) || (documentElement.getAttribute('id') === id ? documentElement : null),
    createElement: (tag) => new El(tag),
    querySelector: (selector) => queryAll(body, selector)[0] || null,
    querySelectorAll: (selector) => queryAll(body, selector),
  };
  let nextTimer = 1;
  const timers = new Map();
  const window = {
    innerHeight: 800,
    matchMedia: (query) => ({
      matches: query.includes('prefers-reduced-motion') ? !!motion.reduce : false,
    }),
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  return { document, window, body, motion, timers };
}

function withDom(motion, run) {
  const dom = makeDocument(motion || { reduce: false });
  const savedWindow = global.window;
  const savedDocument = global.document;
  global.window = dom.window;
  global.document = dom.document;
  try {
    return run(dom);
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
    if (savedDocument === undefined) delete global.document; else global.document = savedDocument;
  }
}

/** The rail's Active row for `slug`, with its Resume pill and icon tile. */
function activeRow(slug, { pill = true, rowRect = { top: 300, left: 10, width: 200, height: 34 } } = {}) {
  const row = make('a', {
    className: 'platform-recent',
    dataset: { recentKey: `app:${slug}`, live: 'true' },
    attrs: { 'data-live': 'true' },
    rect: rowRect,
  });
  row.appendChild(make('span', { className: 'app-icon-tile platform-recent-tile', rect: { top: 308, left: 18, width: 18, height: 18 } }));
  row.appendChild(make('span', { className: 'platform-recent-label' }));
  if (pill) {
    row.appendChild(make('span', {
      className: 'platform-recent-resume',
      attrs: { 'aria-hidden': 'true' },
      rect: { top: 306, left: 160, width: 42, height: 22 },
    }));
  }
  row.appendChild(make('span', { className: 'app-live-dot platform-recent-live' }));
  return row;
}

function railWith(rows) {
  const list = make('div', { id: 'platform-recents', className: 'platform-recents' });
  const active = make('div', { className: 'platform-active' });
  list.appendChild(active);
  for (const row of rows) active.appendChild(row);
  return list;
}

function stripFor(slug, { hidden = false, rect = { top: 700, left: 0, width: 390, height: 52 } } = {}) {
  const strip = make('div', { id: 'platform-parked', className: hidden ? 'platform-parked hidden' : 'platform-parked' });
  const open = make('a', {
    id: 'platform-parked-resume',
    className: 'platform-parked-open',
    attrs: { href: `/app/${encodeURIComponent(slug)}` },
    rect,
  });
  open.appendChild(make('span', { className: 'app-icon-tile platform-parked-tile' }));
  open.appendChild(make('span', { className: 'platform-parked-pill' }));
  strip.appendChild(open);
  return strip;
}

function install(dom, ...nodes) {
  for (const node of nodes) dom.body.appendChild(node);
}

// ── The pill ────────────────────────────────────────────────────────────

test('#3618: a running app you are not in carries a filled Resume pill', () => {
  const { ActiveApps } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const item = (slug, current) => ({
    key: `app:${slug}`,
    kind: 'app',
    label: slug === 'notes' ? 'Notes' : 'Chess',
    href: `/app/${slug}`,
    at: null,
    unread: false,
    app: { slug, name: slug === 'notes' ? 'Notes' : 'Chess', iconUrl: null, iconEmoji: null },
    current,
  });
  const html = renderToHtml(createElement(ActiveApps, {
    items: [item('notes', true), item('chess', false)],
  }));
  const rows = html.match(/<a class="platform-recent"[^>]*>[\s\S]*?<\/a>/g);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows[0], /platform-recent-resume/, 'the app on screen offers no Resume');
  assert.match(rows[0], /aria-current="true"/);
  assert.match(rows[1], /<span class="platform-recent-resume" aria-hidden="true">Resume<\/span>/,
    'a running app that is not on screen offers the way back in words');
  assert.match(rows[1], /aria-label="App: Chess, still open"/,
    'the pill is decorative; the row keeps its one name');
  assert.match(rows[1], /class="app-live-dot platform-recent-live"/,
    'the dot stays in the markup, hidden by CSS where the pill is drawn');

  // Recents rows never carry one, even when the app is still loaded.
  const { RecentsByDay } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const recents = renderToHtml(createElement(RecentsByDay, {
    items: [{ ...item('chess', false), current: false }],
    live: ['chess'],
    showOlder: false,
    onToggleOlder: () => {},
    now: Date.now(),
  }));
  assert.doesNotMatch(recents, /platform-recent-resume/);
  assert.match(recents, /class="app-live-dot platform-recent-live"/);

  const css = read('public/css/app.css');
  assert.match(css, /\.platform-recent-resume \{[\s\S]*?background: var\(--accent\);[\s\S]*?color: var\(--accent-ink\);/);
  assert.match(css, /\.platform-recent-resume ~ \.platform-recent-live \{\s*display: none;\s*\}/,
    'one mark per row');
});

// ── The control ─────────────────────────────────────────────────────────

test('#3618: the control is the pill, then the row, then the phone strip', () => {
  withDom({ reduce: false }, (dom) => {
    const { resumeHandleFor } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    const notesRow = activeRow('notes');
    const pill = notesRow.querySelector('.platform-recent-resume');
    install(dom, railWith([notesRow]), stripFor('notes'));

    assert.equal(resumeHandleFor('notes'), pill, 'the pill first');
    notesRow.children = notesRow.children.filter((child) => child !== pill);
    assert.equal(resumeHandleFor('notes'), notesRow, 'then the row it sits in');
    assert.equal(resumeHandleFor('nobody'), null, 'no control for an app with no row or strip');

    // A hidden phone strip is not on screen.
    const strip = dom.document.getElementById('platform-parked');
    strip.classList.add('hidden');
    assert.equal(resumeHandleFor('notes'), notesRow, 'a hidden strip does not answer');

    // An off-screen row is not an origin either.
    setRect(notesRow, { top: 900, left: 10, width: 200, height: 34 });
    assert.equal(resumeHandleFor('notes'), null, 'off screen resolves to null');

    // The strip answers only for its own app.
    strip.classList.remove('hidden');
    assert.equal(resumeHandleFor('notes'), dom.document.getElementById('platform-parked-resume'));
    assert.equal(resumeHandleFor('other'), null, 'another app\'s strip is not this app\'s control');
  });
});

test('#3618: a pressed control is taken once, for the same slug, while fresh and on screen', () => {
  withDom({ reduce: false }, (dom) => {
    const { noteResumeOrigin, takeResumeOrigin, RESUME_ORIGIN_MS } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    assert.equal(RESUME_ORIGIN_MS, 1500);
    const pill = make('span', { className: 'platform-recent-resume', rect: { top: 10, left: 10, width: 42, height: 22 } });
    install(dom, pill);

    noteResumeOrigin('notes', pill);
    assert.equal(takeResumeOrigin('other'), null, 'another slug never takes it');
    assert.equal(takeResumeOrigin('notes'), pill, 'and it is still there for its own slug');
    assert.equal(takeResumeOrigin('notes'), null, 'taken once');

    // Still on screen: an element that left the document is not an origin.
    noteResumeOrigin('notes', pill);
    pill.remove();
    assert.equal(takeResumeOrigin('notes'), null, 'a control no longer on screen is not an origin');

    // Freshness, with the clock stepped past the lifetime.
    const detached = make('span', { rect: { top: 10, left: 10, width: 42, height: 22 } });
    install(dom, detached);
    const realNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      noteResumeOrigin('notes', detached);
      now += RESUME_ORIGIN_MS;
      assert.equal(takeResumeOrigin('notes'), detached, 'fresh at the boundary');
      noteResumeOrigin('notes', detached);
      now += RESUME_ORIGIN_MS + 1;
      assert.equal(takeResumeOrigin('notes'), null, 'stale origins are not origins');
    } finally {
      Date.now = realNow;
    }
  });
});

// ── The stand-in ────────────────────────────────────────────────────────

test('#3618: the stand-in shrinks into the control and takes itself away', () => {
  withDom({ reduce: false }, (dom) => {
    const { collapseIntoResume, RESUME_MOTION_MS } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    assert.equal(RESUME_MOTION_MS, 250);
    const row = activeRow('notes');
    const pill = row.querySelector('.platform-recent-resume');
    install(dom, railWith([row]));
    // A close to a screen that is not Home: #app-view is already hidden.
    const appView = make('main', { id: 'app-view', className: 'hidden' });
    install(dom, appView);

    const from = { top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 };
    assert.equal(collapseIntoResume('notes', from), true);
    const ghost = dom.body.children.find((child) => child.classList.contains('resume-ghost'));
    assert.ok(ghost, 'one stand-in under the body');
    assert.equal(ghost.getAttribute('aria-hidden'), 'true');
    assert.match(ghost.style.transition, /transform 250ms ease-out/);
    assert.match(ghost.style.transition, /opacity 90ms ease-in 160ms/, 'the fade at the landing end');
    const to = pill.getBoundingClientRect();
    assert.match(ghost.style.transform, new RegExp(
      `translate\\(${to.left}px, ${to.top}px\\) scale\\(${to.width / from.width}, ${to.height / from.height}\\)`,
    ));
    assert.equal(ghost.style.opacity, '0');

    // It ends on the transition's end.
    ghost.dispatchEvent({ type: 'transitionend', propertyName: 'transform' });
    assert.ok(!dom.body.children.includes(ghost), 'removed when the motion ends');

    // It ends on its timer too, if no transitionend comes.
    assert.equal(collapseIntoResume('notes', from), true);
    const second = dom.body.children.find((child) => child.classList.contains('resume-ghost'));
    for (const { fn } of dom.timers.values()) fn();
    assert.ok(!dom.body.children.includes(second), 'removed by the safety timer');

    // Starting another cancels the one in flight.
    assert.equal(collapseIntoResume('notes', from), true);
    assert.equal(dom.body.children.filter((child) => child.classList.contains('resume-ghost')).length, 1);
    assert.equal(collapseIntoResume('notes', from), true);
    assert.equal(dom.body.children.filter((child) => child.classList.contains('resume-ghost')).length, 1,
      'a second collapse replaces the first');
  });
});

test('#3618: no stand-in when a condition says the motion should not be drawn', () => {
  // Reduced motion.
  withDom({ reduce: true }, (dom) => {
    const { collapseIntoResume } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    install(dom, railWith([activeRow('notes')]));
    install(dom, make('main', { id: 'app-view', className: 'hidden' }));
    assert.equal(collapseIntoResume('notes', { top: 0, left: 0, width: 800, height: 600 }), false);
    assert.equal(dom.body.children.filter((child) => child.classList.contains('resume-ghost')).length, 0);
  });

  // No control on screen.
  withDom({ reduce: false }, (dom) => {
    const { collapseIntoResume } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    install(dom, make('main', { id: 'app-view', className: 'hidden' }));
    assert.equal(collapseIntoResume('notes', { top: 0, left: 0, width: 800, height: 600 }), false);
  });

  // A View Transition is drawing snapshots.
  withDom({ reduce: false }, (dom) => {
    const { collapseIntoResume } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    install(dom, railWith([activeRow('notes')]));
    install(dom, make('main', { id: 'app-view', className: 'hidden' }));
    dom.document.documentElement.setAttribute('data-un-vt', 'push');
    assert.equal(collapseIntoResume('notes', { top: 0, left: 0, width: 800, height: 600 }), false);
  });

  // The app view is still painted: the kit's own zoom-out owns it.
  withDom({ reduce: false }, (dom) => {
    const { collapseIntoResume } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    install(dom, railWith([activeRow('notes')]));
    install(dom, make('main', { id: 'app-view', className: 'app-view' }));
    assert.equal(collapseIntoResume('notes', { top: 0, left: 0, width: 800, height: 600 }), false);
  });

  // No measurable rect.
  withDom({ reduce: false }, (dom) => {
    const { collapseIntoResume } = loadTsx('frontend/src/features/nav/resume-motion.ts');
    install(dom, railWith([activeRow('notes')]));
    install(dom, make('main', { id: 'app-view', className: 'hidden' }));
    assert.equal(collapseIntoResume('notes', null), false);
  });
});

// ── The callers and the router ──────────────────────────────────────────

test('#3618: both Resume callers note the control before opening the app', () => {
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list,
    /const row = event\.currentTarget;\s*\n\s*noteResumeOrigin\(slug, row\.querySelector\('\.platform-recent-resume'\) \|\| row\);\s*\n\s*window\.App\?\.openAppTab\?\.\(slug, 'app'\);/);
  const strip = read('frontend/src/features/nav/parked-strip.tsx');
  assert.match(strip,
    /noteResumeOrigin\(app\.slug, event\.currentTarget\);\s*\n\s*window\.App\?\.openAppTab\?\.\(app\.slug, 'app'\);/);
});

test('#3618: the router measures before hiding, parks then collapses, and prefers the control', () => {
  const app = read('public/js/app.js');
  const showOnly = app.slice(app.indexOf('_showOnlyScreen(revealId, keepAlso) {'));
  assert.ok(showOnly.indexOf('App._leavingAppRect = App._appViewRect();')
    < showOnly.indexOf('App._setScreenVisible(id, false)'),
  'the app view is measured before any root is hidden');
  assert.match(showOnly, /App\._leavingAppRect = App\._appViewRect\(\);/);

  assert.match(app,
    /const leavingRect = App\._leavingAppRect;\s*\n\s*App\._leavingAppRect = null;[\s\S]{0,700}?bridge\.park\(left\);[\s\S]{0,400}?bridge\.collapse\?\.\(left\.slug, leavingRect\);/,
    'the rect is read once, the app is parked, then the stand-in is offered its rect');

  assert.match(app, /_resumeHandleFor\(slug\) \{[\s\S]{0,400}bridge\.takeResumeOrigin\?\.\(slug\) \|\| bridge\.resumeHandle\?\.\(slug\)/);
  assert.match(app, /_resumeMotionMs\(\) \{[\s\S]{0,300}nav\?\.resumeMotionMs/);

  // Both zooms: the control first, the Home tile as the fallback, the
  // shorter motion only when the control is the target.
  const zooms = app.match(/fromEl: \(\) => resumeSource\(\) \|\| [^\n]+/g) || [];
  assert.equal(zooms.length, 2, 'zoom-in and zoom-out both prefer the control');
  const durations = app.match(/duration: \(\) => \(resumeSource\(\) \? App\._resumeMotionMs\(\) : 0\)/g) || [];
  assert.equal(durations.length, 2);

  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount, /resumeHandle: resumeHandleFor,/);
  assert.match(mount, /takeResumeOrigin,/);
  assert.match(mount, /collapse: collapseIntoResume,/);
  assert.match(mount, /resumeMotionMs: RESUME_MOTION_MS,/);
});

// ── The kit ─────────────────────────────────────────────────────────────

test('#3618: the kit keeps 380ms/340ms as defaults and scales a supplied duration', () => {
  const kit = read('public/usernode-native/v1/native.js');
  assert.match(kit, /function zoomDuration\(opts, fallbackMs\) \{[\s\S]*?typeof value === 'function'[\s\S]*?return ms > 0 \? ms : fallbackMs;/);
  assert.match(kit, /var inMs = zoomDuration\(opts, 380\);/);
  assert.match(kit, /var outMs = zoomDuration\(opts, 340\);/);
  assert.match(kit, /var inFadeMs = Math\.round\(inMs \* 220 \/ 380\);/);
  assert.match(kit, /var outFadeMs = Math\.round\(outMs \* 200 \/ 340\);/);
  assert.match(kit, /var outDelayMs = Math\.round\(outMs \* 60 \/ 340\);/);
  assert.match(kit, /'transform ' \+ inMs \+ 'ms '/);
  assert.match(kit, /'transform ' \+ outMs \+ 'ms '/);
  assert.match(kit, /setTimeout\(finish, inMs \+ 120\);/);
  assert.match(kit, /setTimeout\(finish, outMs \+ 140\);/);
});

// ── The declared check ──────────────────────────────────────────────────

test('#3618: the kept-apps check selects the Active-row Resume pill too', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find((entry) => entry.id === 'kept-apps.home-dot');
  assert.ok(check, 'the existing check is extended, not replaced');
  assert.match(check.expectSelector,
    /\.app-card-live-dot\.app-live-dot/,
    'the Home tile dot is still required');
  assert.match(check.expectSelector,
    /#platform-tabs \.platform-active > a\[data-live\]:not\(\[aria-current\]\) > \.platform-recent-resume/,
    'and so is the Active row\'s Resume pill');
  assert.match(check.expectSelector, /\):has\(/, 'both in one :has() selector, not a comma');
  assert.ok(check.impact.includes('frontend/src/features/nav/**'));
  assert.equal(manifest.tests.filter((entry) => entry.id === 'kept-apps.home-dot').length, 1,
    'extended in place; the declared count is pinned by dev-board-fold.test.js');
});
