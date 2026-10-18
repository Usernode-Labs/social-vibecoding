'use strict';

// #3618 — an active app collapses into its Resume button and grows back out.
//
//   frontend/src/features/nav/recents-list.tsx   the Active row's Resume pill
//   frontend/src/features/nav/parked-strip.tsx   the phone strip's origin
//   frontend/src/features/nav/resume-motion.ts   target lookup, origin, ghost
//   frontend/src/features/nav/mount.ts           the legacy bridge
//   public/js/app.js                            the router's two directions
//   public/usernode-native/v1/native.js          the kit's duration option
//   public/css/app.css                           the pill, the strip, the ghost
//   dapp.json                                    the declared check covers both
//
// The motion is DOM-only, so the tests below drive it against a small fake DOM
// rather than pinning source text alone. The router is pinned by source: it is
// one function per direction, and the order (measure before hide, park before
// collapse) is the whole contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');
const NATIVE = read('public/usernode-native/v1/native.js');
const LIST = read('frontend/src/features/nav/recents-list.tsx');
const STRIP = read('frontend/src/features/nav/parked-strip.tsx');
const MOUNT = read('frontend/src/features/nav/mount.ts');

// ── A fake DOM just large enough for resume-motion.ts ────────────────────

function rect(left, top, width, height) {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
  };
}

function element({ box = null, hidden = false, query = {} } = {}) {
  const classes = hidden ? ['hidden'] : [];
  return {
    classList: { contains: (name) => classes.includes(name) },
    getBoundingClientRect: () => box || rect(0, 0, 0, 0),
    querySelector: (selector) => query[selector] || null,
    querySelectorAll: () => [],
  };
}

function withDom(run) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousElement = global.Element;
  const previousSetTimeout = global.setTimeout;
  const nodes = new Map();
  const rows = new Map();
  const appended = [];
  const animations = [];
  const delays = [];
  const doc = {
    documentElement: { hasAttribute: () => false },
    getElementById: (id) => nodes.get(id) || null,
    querySelector: (selector) => rows.get(selector) || null,
    querySelectorAll: () => [],
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        style: {},
        attributes: {},
        children: [],
        removed: false,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        appendChild(child) { this.children.push(child); return child; },
        animate(keyframes, options) {
          const animation = {
            keyframes, options, onfinish: null, oncancel: null,
            finished: new Promise(() => {}),
          };
          animations.push(animation);
          return animation;
        },
        remove() { this.removed = true; },
      };
      return el;
    },
    body: { appendChild: (el) => { appended.push(el); return el; } },
  };
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false }),
  };
  global.document = doc;
  global.Element = function Element() {};
  global.setTimeout = (fn, ms) => { delays.push(ms); return previousSetTimeout(fn, 0); };
  const restore = () => {
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
    if (previousElement === undefined) delete global.Element; else global.Element = previousElement;
    global.setTimeout = previousSetTimeout;
  };
  return {
    doc, nodes, rows, appended, animations, delays,
    motion: loadTsx('frontend/src/features/nav/resume-motion.ts'),
    run: () => run({
      doc, nodes, rows, appended, animations, delays,
      motion: loadTsx('frontend/src/features/nav/resume-motion.ts'),
    }),
    restore,
  };
}

function activeItems() {
  const { buildActive } = loadTsx('frontend/src/features/nav/recents.ts');
  return buildActive({
    live: ['notes', 'chess'],
    current: 'notes',
    apps: [
      { slug: 'notes', name: 'Notes', iconUrl: null, iconEmoji: '📝', at: '2026-09-20T10:00:00Z' },
      { slug: 'chess', name: 'Chess', iconUrl: null, iconEmoji: '♟️', at: '2026-09-20T09:00:00Z' },
    ],
  });
}

function rowsFrom(html) {
  return html.match(/<a class="platform-recent"[\s\S]*?<\/a>/g) || [];
}

test('the Resume pill is only on a running app that is not on screen', () => {
  const { ActiveApps, RecentsByDay } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const html = renderToHtml(createElement(ActiveApps, { items: activeItems() }));
  const rows = rowsFrom(html);
  assert.equal(rows.length, 2);
  const notes = rows.find((row) => row.includes('data-recent-key="app:notes"'));
  const chess = rows.find((row) => row.includes('data-recent-key="app:chess"'));
  assert.doesNotMatch(notes, /platform-recent-resume/, 'the app you are in offers no Resume');
  assert.match(notes, /platform-recent-live/, 'and keeps the green still-open dot');
  assert.match(chess, /<span class="platform-recent-resume" aria-hidden="true">Resume<\/span>/,
    'a running app you are not in offers it, decoratively');
  assert.match(chess, /platform-recent-live/, 'the dot is still in the DOM, hidden by CSS beside the pill');

  // Recents rows are apps you left; they have no Resume control.
  const recents = renderToHtml(createElement(RecentsByDay, {
    items: [{
      key: 'app:garden', kind: 'app', label: 'Garden', href: '/app/garden',
      at: '2026-09-20T09:00:00Z', unread: false,
      app: { slug: 'garden', name: 'Garden', iconUrl: null, iconEmoji: '🌱' },
    }],
    live: [],
    showOlder: false,
    onToggleOlder: () => {},
  }));
  assert.doesNotMatch(recents, /platform-recent-resume/);
});

test('the pill is in the row, after the label, and the row keeps its own name', () => {
  const { ActiveApps } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const html = renderToHtml(createElement(ActiveApps, { items: activeItems() }));
  const chess = rowsFrom(html).find((row) => row.includes('data-recent-key="app:chess"'));
  assert.match(chess, /aria-label="App: Chess, still open"/,
    'the pill adds nothing to the row name: the row is still the app');
  const label = chess.indexOf('platform-recent-label');
  const pill = chess.indexOf('platform-recent-resume');
  assert.ok(label > 0 && pill > label, 'Resume follows the name');
  assert.match(LIST, /resume=\{!item\.current\}/, 'the current app gets none');
});

test('both Resume controls are the accent fill', () => {
  const rail = CSS.slice(CSS.indexOf('  .platform-recent-resume {'));
  const railRule = rail.slice(0, rail.indexOf('}'));
  assert.match(railRule, /background: var\(--accent\);/);
  assert.match(railRule, /color: var\(--accent-ink\);/);
  assert.match(railRule, /border-radius: 999px;/);
  const parked = CSS.slice(CSS.indexOf('.platform-parked-pill {'));
  const parkedRule = parked.slice(0, parked.indexOf('}'));
  assert.match(parkedRule, /background: var\(--accent\);/);
  assert.match(parkedRule, /color: var\(--accent-ink\);/);
  assert.doesNotMatch(parkedRule, /--brand-tint|--brand-ink/, 'no longer the header periwinkle');
  // The green dot and the pill say the same thing; the pill wins.
  assert.match(CSS, /\.platform-recent-resume ~ \.platform-recent-live \{\s*display: none;\s*\}/);
});

test('the target is the pill, then the row, then the parked strip', () => {
  const dom = withDom(() => {});
  try {
    const pill = element({ box: rect(200, 300, 58, 22) });
    const row = element({ box: rect(12, 296, 200, 34), query: { '.platform-recent-resume': pill } });
    dom.rows.set('.platform-active .platform-recent[data-recent-key="app:chess"]', row);
    assert.equal(dom.motion.resumeHandleFor('chess'), pill, 'the pill first');

    // No pill drawn (the app on screen): the row itself is the control.
    delete row.querySelector;
    assert.equal(dom.motion.resumeHandleFor('chess'), row, 'then the row');

    // No Active row at all (phone): the parked strip.
    dom.rows.clear();
    const strip = element({ box: rect(0, 700, 390, 52) });
    dom.nodes.set('platform-parked', strip);
    assert.equal(dom.motion.resumeHandleFor('chess'), strip, 'then the phone strip');

    // A hidden control is no target.
    strip.classList.contains = (name) => name === 'hidden';
    assert.equal(dom.motion.resumeHandleFor('chess'), null);
  } finally {
    dom.restore();
  }
});

test('a recorded origin is one-shot, for the right app, and expires', () => {
  const dom = withDom(() => {});
  const realNow = Date.now;
  try {
    let now = 10_000;
    Date.now = () => now;
    const control = element({ box: rect(20, 400, 120, 28) });
    dom.rows.set('.platform-active .platform-recent[data-recent-key="app:chess"]', control);
    dom.motion.noteResumeOrigin('chess', control);
    assert.equal(dom.motion.takeResumeOrigin('chess'), control, 'the pressed control');
    assert.equal(dom.motion.takeResumeOrigin('chess'), null, 'taken once');

    dom.motion.noteResumeOrigin('chess', control);
    assert.equal(dom.motion.takeResumeOrigin('notes'), null, 'another app does not inherit it');
    assert.equal(dom.motion.takeResumeOrigin('chess'), control, 'and the right app still has it');

    dom.motion.noteResumeOrigin('chess', control);
    now += dom.motion.RESUME_ORIGIN_TTL_MS + 1;
    assert.equal(dom.motion.takeResumeOrigin('chess'), null, 'expired after the TTL');
  } finally {
    Date.now = realNow;
    dom.restore();
  }
});

test('the stand-in moves for 250ms with the platform ease and removes itself', async () => {
  const dom = withDom(() => {});
  try {
    const pill = element({ box: rect(600, 300, 58, 22) });
    const row = element({ box: rect(412, 296, 200, 34), query: { '.platform-recent-resume': pill } });
    dom.rows.set('.platform-active .platform-recent[data-recent-key="app:chess"]', row);

    const from = rect(0, 0, 1280, 800);
    assert.equal(dom.motion.collapseIntoResume(
      { slug: 'chess', name: 'Chess', iconEmoji: '♟️' }, from,
    ), true);

    const ghost = dom.appended[0];
    assert.ok(ghost, 'a card was appended to the body');
    assert.equal(ghost.className, 'resume-ghost');
    assert.equal(ghost.style.left, '0px');
    assert.equal(ghost.style.width, '1280px');
    assert.equal(ghost.style.background, 'var(--bg-primary)', 'the page ground when none was reported');
    const tile = ghost.children[0];
    assert.equal(tile.className, 'app-icon-tile resume-ghost-tile');
    assert.equal(tile.attributes['data-icon'], 'emoji');
    assert.equal(tile.children[0].textContent, '♟️');

    assert.equal(dom.animations.length, 1);
    const { keyframes, options } = dom.animations[0];
    assert.equal(options.duration, 250);
    assert.equal(options.duration, dom.motion.RESUME_MOTION_MS);
    assert.equal(options.easing, dom.motion.RESUME_EASE);
    assert.equal(keyframes[2].transform, `translate(${600 - 0}px, ${300 - 0}px) scale(${58 / 1280}, ${22 / 800})`);
    assert.equal(keyframes[2].opacity, 0);
    assert.ok(dom.delays.includes(370), 'a timer removes a card whose animation never fires');

    dom.animations[0].onfinish();
    assert.equal(ghost.removed, true);
  } finally {
    dom.restore();
  }
});

test('reduced motion, no control, or a running page transition draws nothing', () => {
  {
    const dom = withDom(() => {});
    try {
      dom.rows.set('.platform-active .platform-recent[data-recent-key="app:chess"]',
        element({ box: rect(0, 0, 100, 30) }));
      dom.window = global.window;
      global.window.matchMedia = () => ({ matches: true });
      assert.equal(dom.motion.collapseIntoResume({ slug: 'chess', name: 'Chess' }, rect(0, 0, 800, 600)), false);
      assert.equal(dom.appended.length, 0);
    } finally {
      dom.restore();
    }
  }
  {
    const dom = withDom(() => {});
    try {
      assert.equal(dom.motion.collapseIntoResume({ slug: 'chess', name: 'Chess' }, rect(0, 0, 800, 600)), false,
        'no Resume control on screen');
      assert.equal(dom.appended.length, 0);
    } finally {
      dom.restore();
    }
  }
  {
    const dom = withDom(() => {});
    try {
      dom.rows.set('.platform-active .platform-recent[data-recent-key="app:chess"]',
        element({ box: rect(0, 0, 100, 30) }));
      global.document.documentElement.hasAttribute = (name) => name === 'data-un-vt';
      assert.equal(dom.motion.collapseIntoResume({ slug: 'chess', name: 'Chess' }, rect(0, 0, 800, 600)), false,
        'a page transition is already moving the document');
      assert.equal(dom.appended.length, 0);
    } finally {
      dom.restore();
    }
  }
});

test('the bridge exposes collapse, resumeHandle, takeResumeOrigin and resumeMotionMs', () => {
  const previousWindow = global.window;
  global.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  try {
    loadTsx('frontend/src/features/nav/mount.ts');
    const nav = global.window.UsernodeReact.nav;
    assert.equal(typeof nav.collapse, 'function');
    assert.equal(typeof nav.resumeHandle, 'function');
    assert.equal(typeof nav.takeResumeOrigin, 'function');
    assert.equal(typeof nav.resumeMotionMs, 'function');
    assert.equal(nav.resumeMotionMs(), 250);
    assert.match(MOUNT, /collapseIntoResume\(app, from\)/);
    assert.match(MOUNT, /resumeHandleFor\(slug\)/);
    assert.match(MOUNT, /takeResumeOrigin\(slug\)/);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('pressing either Resume control records the origin before routing', () => {
  const rowNote = LIST.indexOf('noteResumeOrigin(slug,');
  const rowRoute = LIST.indexOf("window.App?.openAppTab?.(slug, 'app');");
  assert.ok(rowNote > 0 && rowRoute > rowNote, 'the rail row notes, then opens');
  const stripNote = STRIP.indexOf('noteResumeOrigin(app.slug, ref.current);');
  const stripRoute = STRIP.indexOf("window.App?.openAppTab?.(app.slug, 'app');");
  assert.ok(stripNote > 0 && stripRoute > stripNote, 'the phone strip notes, then opens');
  assert.match(STRIP, /if \(!app\) return;[\s\S]{0,300}noteResumeOrigin/,
    'a leaving strip, which has no app, records nothing');
});

test('the router measures the app before hiding it, and collapses after parking', () => {
  const reveal = APP_JS.slice(APP_JS.indexOf('  _showOnlyScreen(revealId, keepAlso) {'));
  const measure = reveal.indexOf('App._leavingAppRect =');
  const hide = reveal.indexOf('for (const id of App.SCREEN_IDS)');
  assert.ok(measure > 0 && hide > measure, 'measured before the roots are hidden');
  assert.match(reveal, /!keep\.includes\('app-view'\)/, 'Home keeps the view for its own zoom');

  const sync = APP_JS.slice(APP_JS.indexOf('  _syncParkedApp(inApp) {'));
  const body = sync.slice(0, sync.indexOf('\n  },'));
  const park = body.indexOf('bridge.park(left);');
  const collapse = body.indexOf('bridge.collapse(left, from);');
  assert.ok(park > 0 && collapse > park, 'parked first');
  assert.match(body, /!App\._isScreenVisible\('app-view'\)[\s\S]{0,120}bridge\.collapse/,
    'and only once the app view has actually left the screen');
  assert.match(APP_JS, /_appViewRect\(\) \{[\s\S]{0,300}getBoundingClientRect\(\)/);
});

test('resume grows out of the pressed control, and Home prefers it over the tile', () => {
  assert.match(APP_JS, /const resumeFrom = App\._takeResumeOrigin\(slug\);/,
    'navigateToApp takes the recorded origin once');
  assert.match(APP_JS, /fromEl: \(\) => resumeFrom \|\| App\._tileFor\(slug\),/);
  assert.match(APP_JS, /\.\.\.\(resumeFrom \? \{ duration: App\._resumeMotionMs\(\) \} : null\)/,
    'with the shorter motion');

  const home = APP_JS.slice(APP_JS.indexOf('  navigateHome(opts) {'));
  assert.match(home, /fromEl: \(\) => \(leavingSlug\s*\n\s*\? \(App\._resumeHandleFor\(leavingSlug\) \|\| App\._tileFor\(leavingSlug\)\)/,
    'the Resume control, then the Home tile');
  assert.match(home, /duration: \(\) => \(leavingSlug && App\._resumeHandleFor\(leavingSlug\)[\s\S]{0,80}App\._resumeMotionMs\(\)/,
    'resolved after the parked control has been drawn');
});

test('the kit keeps its default zoom timings unless a duration is asked for', () => {
  assert.match(NATIVE, /function zoomDuration\(opts, sourceRect, fallback\)/);
  assert.match(NATIVE, /typeof value === 'function'/, 'a function is resolved after the source rect');
  assert.match(NATIVE, /zoomDuration\(opts, fromRect, 380\)/);
  assert.match(NATIVE, /zoomDuration\(opts, source, 340\)/);
  assert.match(NATIVE, /var inFade = Math\.round\(inMs \* 220 \/ 380\);/,
    'the fade scales with the zoom');
  assert.match(NATIVE, /setTimeout\(finish, inMs \+ 120\);/);
  assert.match(NATIVE, /var outFade = Math\.round\(outMs \* 200 \/ 340\);/);
  assert.match(NATIVE, /setTimeout\(finish, outMs \+ 140\);/);
});

test('the declared check covers the rail pill as well as the Home dot', () => {
  const check = JSON.parse(read('dapp.json')).tests.find((entry) => entry.id === 'kept-apps.home-dot');
  assert.ok(check, 'the existing check is kept');
  assert.match(check.expectSelector,
    /^body:has\(#platform-recents \.platform-active > a\[data-live\]:not\(\[aria-current\]\) > \.platform-recent-resume\) /);
  assert.match(check.expectSelector, /#app-list \.app-card\[data-live="true"\]/);
});

test('the stand-in is drawn above app content and never takes a click', () => {
  const rule = CSS.slice(CSS.indexOf('.resume-ghost {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /position: fixed;/);
  assert.match(body, /z-index: 9960;/);
  assert.match(body, /pointer-events: none;/);
  const reduced = CSS.slice(CSS.indexOf('.resume-ghost {'));
  assert.match(reduced, /@media \(prefers-reduced-motion: reduce\) \{\s*[\s\S]{0,300}\.resume-ghost \{ display: none; \}/);
});
