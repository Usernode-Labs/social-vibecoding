// "Show more" on a long comment (#2556), on both surfaces that draw one.
//
// ── Why one file for two surfaces ──────────────────────────────────────
//
// A card's comments render in two places and they do NOT share a renderer:
// the card's own reply thread is React (frontend/src/features/dev-board/),
// and the Workshop's inline recent-comments slot is an innerHTML string
// written by the legacy `AppView._fillFeedComments`. A React island must not
// reconcile over a node `public/js/**` writes, so the clamp is implemented
// twice on purpose. (A request's own page drew a third, its GitHub thread;
// since #4453 those comments are rows of the page's Messages thread, which
// draws a reply whole, as Messages does.)
//
// Twice is exactly the number of places a behaviour drifts, so this file
// holds the two implementations to the same three promises:
//
//   1. Four lines, then a control. Not three, not six, and the same four on
//      every surface.
//   2. The decision is MEASURED against the rendered box, never counted from
//      the text — so a comment of exactly four short lines gets no control,
//      and the same comment gets one on a phone and not on a desktop card.
//   3. The control is "Show more", then "Show less", and it looks like the
//      one Browse apps already has.
//
// Run with: node --test tests/dev-comment-clamp.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const CLAMP = 'frontend/src/features/dev-board/comment-clamp.tsx';
const APP_VIEW_SRC = read('public/js/app-view.js');
const BUTTON = read('frontend/@/components/ui/button.tsx');
const CSS = read('public/css/app.css');

const mod = () => loadTsx(CLAMP);

// ── 1. The measurement ────────────────────────────────────────────────

test('a comment is long only when the clamped box is hiding something', () => {
  const { overflowsClamp } = mod();
  // Four short lines: the box shows all of it. A control here would expand
  // nothing, which is the pointless case the request called out by name.
  assert.equal(overflowsClamp({ scrollHeight: 80, clientHeight: 80 }), false);
  // Sub-pixel line heights land a fraction over. Still nothing to reveal.
  assert.equal(overflowsClamp({ scrollHeight: 80.6, clientHeight: 80 }), false);
  // A fifth line is a real one.
  assert.equal(overflowsClamp({ scrollHeight: 100, clientHeight: 80 }), true);
  // A box with no layout yet (a folded card, a hidden slot) is not "long":
  // it is unmeasured, and the observer re-asks once it has a box.
  assert.equal(overflowsClamp({ scrollHeight: 0, clientHeight: 0 }), false);
});

test('four lines, and the clamp is a complete literal', () => {
  const { CLAMP_LINES, CLAMP_CLASS } = mod();
  assert.equal(CLAMP_LINES, 4);
  // Tailwind's extractor is a regex over source text, so the utility has to
  // appear spelled out — `line-clamp-${CLAMP_LINES}` compiles to nothing and
  // the comment would simply render in full.
  assert.equal(CLAMP_CLASS, 'line-clamp-4');
  assert.match(read(CLAMP), /'line-clamp-4'/);
});

// ── 2. The React markup, in all four states ───────────────────────────

const body = (props) => renderToHtml(createElement(
  mod().ClampedCommentBody,
  { className: 'dev-feed-msg-text', ...props },
  'the comment',
));

test('a short comment renders exactly as it did before: no control at all', () => {
  const html = body({ expanded: false, overflowing: false });
  assert.equal(html, '<div class="dev-feed-msg-text line-clamp-4">the comment</div>');
  assert.doesNotMatch(html, /Show more|<button/);
});

test('a long comment clamps and offers "Show more"', () => {
  const html = body({ expanded: false, overflowing: true });
  assert.match(html, /class="dev-feed-msg-text line-clamp-4"/);
  assert.match(html, /<button[^>]*>Show more<\/button>/);
  assert.match(html, /aria-expanded="false"/);
  // The hook a declared check selects on. It styles nothing, and it is the
  // React counterpart of the legacy surface's `.dev-feed-comment-toggle`.
  assert.match(html, /class="[^"]*\bdev-comment-more\b/);
});

test('expanding drops the clamp and the control becomes "Show less"', () => {
  const html = body({ expanded: true, overflowing: true });
  assert.doesNotMatch(html, /line-clamp/,
    'the whole comment is on screen, so nothing is clamped');
  assert.match(html, /class="dev-feed-msg-text"/);
  assert.match(html, /<button[^>]*>Show less<\/button>/);
  assert.match(html, /aria-expanded="true"/);
});

test('the control is the Browse screen\'s "Show more", not a new one', () => {
  // frontend/src/features/apps/browse-list.tsx draws
  // `<Button variant="neutral" ink="neutral">`; this one is the same pair at
  // the compact size the comment surfaces are written at.
  const html = body({ expanded: false, overflowing: true });
  for (const cls of ['rounded-lg', 'bg-zinc-100', 'dark:bg-zinc-800', 'px-3', 'py-1',
    'text-xs', 'text-zinc-900', 'dark:text-zinc-100']) {
    assert.ok(html.includes(cls), `the control carries ${cls}`);
  }
});

test('the sanitized-markdown case lands on the clamped node itself', () => {
  // NOT in a wrapper around it: `public/js/**` and dapp.json select on these
  // chains, and the topic sheet's markdown styling is written against the
  // element that carries `.dev-issue-body`.
  const html = renderToHtml(createElement(mod().ClampedCommentBody, {
    className: 'dev-feed-msg-text dev-issue-body',
    expanded: false,
    overflowing: false,
    html: { __html: '<p>hello</p>' },
  }));
  assert.equal(html, '<div class="dev-feed-msg-text dev-issue-body line-clamp-4"><p>hello</p></div>');
});

// ── 3. The card's own reply thread ────────────────────────────────────

test('the card\'s thread panel clamps a long reply and keeps its newlines', () => {
  const { MessageLine } = loadTsx('frontend/src/features/dev-board/card/feed-thread.tsx');
  const html = renderToHtml(createElement(MessageLine, {
    m: {
      id: 42,
      author: 'bob',
      userId: null,
      content: 'First line\nSecond line',
      createdAt: '2026-09-04T11:00:00Z',
      postedVia: null,
    },
  }));
  assert.match(html, /class="dev-feed-msg-text whitespace-pre-wrap break-words line-clamp-4"/);
  // The clamp is a class on the node that already held the text; the reply
  // is still React-escaped text with its line break intact.
  assert.match(html, /dev-feed-msg-text[^>]*>First line\nSecond line<\/div>/);
  assert.doesNotMatch(html, /Show more/);
});

// ── 5. Surface three: the Workshop's inline recent comments ───────────

function makeAppView(globals) {
  const sandbox = {
    console,
    relTime: () => ({ text: '2h ago', title: 'two hours ago' }),
    relStamp: () => ({ text: '2h ago', title: 'two hours ago' }),
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo-app' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    // Globals the module reads as BARE IDENTIFIERS at call time. Absent by
    // default, which is also the real no-ResizeObserver browser: the clamp
    // then measures once and does not track the width.
    ...(globals || {}),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  return AppView;
}

test('the Workshop slot clamps the author and the body together', () => {
  const AppView = makeAppView();
  const html = AppView._feedCommentsHtml([
    { author: 'evan', body: 'a long comment. '.repeat(80), createdAt: '2026-03-04T15:30:00Z' },
  ]);
  // The body renders INLINE after the name on this surface, so a clamp on
  // the body alone would count its first line from the wrong left edge.
  assert.match(html, /<span class="dev-feed-comment-clamp">\s*<span class="dev-feed-comment-author">/);
  assert.match(html, /<span class="dev-feed-comment-body">/);
  // The control is the clamp's SIBLING — never inside the box it hides.
  assert.match(
    html,
    /<\/span>\s*<button type="button" class="dev-feed-comment-toggle [^"]+" aria-expanded="false" hidden>Show more<\/button>/,
  );
  // And it ships hidden, because nothing has been measured yet.
  assert.match(html, /hidden>Show more/);
});

test('the legacy control is transcribed from the same Button call', () => {
  const AppView = makeAppView();
  const cls = AppView.FEED_COMMENT_TOGGLE_CLASS;
  // The pieces the cva table in @/components/ui/button.tsx emits for
  // `variant="neutral" ink="neutral" size="xsText"`. Read out of that file
  // rather than retyped, so the transcription cannot go stale in silence:
  // the Workshop slot is filled by innerHTML and cannot use the primitive.
  const pick = (group, key) => {
    const at = BUTTON.indexOf(`    ${group}: {`);
    assert.ok(at > 0, `button.tsx declares a ${group} group`);
    const block = BUTTON.slice(at, BUTTON.indexOf('\n    },', at));
    const m = block.match(new RegExp(`\\n\\s*${key}:\\s*\\n?\\s*'([^']*)'`));
    assert.ok(m, `button.tsx's ${group} group declares ${key}`);
    return m[1];
  };
  for (const piece of [pick('variant', 'neutral'), pick('size', 'xsText'), pick('ink', 'neutral')]) {
    assert.ok(cls.includes(piece),
      `the Workshop control must carry "${piece}", the same run browse-list.tsx gets`);
  }
  // Complete literals only: a name assembled at runtime compiles to nothing.
  assert.doesNotMatch(cls, /\$\{/);
});

/**
 * A stand-in for one rendered comment: a clamp span, its main, its button.
 * `log`, when given, receives 'read' for every layout question asked of the
 * clamp and 'write' for every change to the control, in the order they happen.
 */
function fakeComment({ scrollHeight, clientHeight, expanded = false, log = null }) {
  const classes = new Set(['dev-feed-comment-clamp', ...(expanded ? ['is-expanded'] : [])]);
  let hidden = true;
  const btn = {
    get hidden() { return hidden; },
    set hidden(v) { hidden = v; if (log) log.push('write'); },
    textContent: 'Show more',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { if (type === 'click') this.click = fn; },
  };
  const box = { scrollHeight, clientHeight };
  const clamp = {
    get scrollHeight() { if (log) log.push('read'); return box.scrollHeight; },
    set scrollHeight(v) { box.scrollHeight = v; },
    get clientHeight() { return box.clientHeight; },
    set clientHeight(v) { box.clientHeight = v; },
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c) => {
        if (classes.has(c)) { classes.delete(c); return false; }
        classes.add(c);
        return true;
      },
    },
    parentElement: { querySelector: (s) => (s === '.dev-feed-comment-toggle' ? btn : null) },
  };
  return { clamp, btn, root: { querySelectorAll: () => [clamp] } };
}

test('the control appears only on a comment the clamp is actually cutting', () => {
  const AppView = makeAppView();

  const short = fakeComment({ scrollHeight: 80, clientHeight: 80 });
  AppView._clampFeedComments(short.root);
  assert.equal(short.btn.hidden, true, 'four lines that fit get no control');

  const long = fakeComment({ scrollHeight: 240, clientHeight: 80 });
  AppView._clampFeedComments(long.root);
  assert.equal(long.btn.hidden, false, 'a comment with more behind it gets one');
});

test('pressing it expands in place, and says so', () => {
  const AppView = makeAppView();
  const { clamp, btn, root } = fakeComment({ scrollHeight: 240, clientHeight: 80 });
  AppView._clampFeedComments(root);

  let stopped = 0;
  const press = () => btn.click({ preventDefault() {}, stopPropagation() { stopped += 1; } });

  press();
  assert.ok(clamp.classList.contains('is-expanded'));
  assert.equal(btn.textContent, 'Show less');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  // The row sits under #dev-body's delegated handler, which opens the topic
  // for a click anywhere on a card. Expanding a comment is not that.
  assert.equal(stopped, 1);

  press();
  assert.ok(!clamp.classList.contains('is-expanded'));
  assert.equal(btn.textContent, 'Show more');
  assert.equal(btn.attrs['aria-expanded'], 'false');
});

test('an expanded comment keeps its control when the box is re-measured', () => {
  const AppView = makeAppView();
  // Expanded, so `scrollHeight` and `clientHeight` are equal again — there
  // is nothing hidden to measure. The way back must not disappear.
  const { btn, clamp } = fakeComment({ scrollHeight: 240, clientHeight: 240, expanded: true });
  AppView._syncFeedCommentToggle(clamp);
  assert.equal(btn.hidden, false);
});

test('the clamped slot is re-measured when it gains a box or changes width', () => {
  const observed = [];
  const disconnected = [];
  let fire = null;
  const AppView = makeAppView({
    ResizeObserver: function ResizeObserver(cb) {
      fire = cb;
      return {
        observe: (el) => observed.push(el),
        disconnect: () => disconnected.push(true),
      };
    },
  });

  // A card that is still folded gives every clamp a zero height, and an
  // unfilled slot is `display: none` outright — the same deadlock the
  // IntersectionObserver above it already hit. So the first measurement is
  // "no", and only a re-measure can make the control appear.
  const log = [];
  const { clamp, btn, root } = fakeComment({ scrollHeight: 0, clientHeight: 0, log });
  AppView._clampFeedComments(root);
  assert.equal(btn.hidden, true, 'nothing measurable yet');
  assert.deepEqual(observed, [clamp], 'the clamped box is watched');
  // And nothing was ASKED yet either. This runs on the line after the slot's
  // innerHTML was written; a measurement there makes the browser restyle the
  // page before it can answer, and on a board with every card open that was
  // the whole board, once per slot. The observer asks after layout instead.
  assert.deepEqual(log, [], 'no layout read on the line after the write');

  clamp.scrollHeight = 240;
  clamp.clientHeight = 80;
  fire([{ target: clamp }]);
  assert.equal(btn.hidden, false, 'the control appears once the box exists');

  // The other direction, which is the one a phone hits: wide enough for the
  // whole comment, and the control goes away again rather than lying.
  clamp.scrollHeight = 80;
  fire([{ target: clamp }]);
  assert.equal(btn.hidden, true);

  // And a repaint drops it, so it cannot hold detached nodes.
  AppView._wireFeedComments(null);
  assert.deepEqual(disconnected, [true]);
  assert.equal(AppView._feedClampObserver, null);
});

test('a repaint rebuilds the clamp observer with the comment observer', () => {
  // Both watch nodes that `_rerenderWorkshop` replaces outright, so both are
  // disconnected in the same place, on the same schedule.
  const src = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _wireFeedComments(root) {'));
  const head = src.slice(0, src.indexOf('if (!root) {'));
  assert.ok(head.length < 600, 'the head is the two disconnects, not the function after it');
  assert.match(head, /AppView\._feedCommentObserver\.disconnect\(\)/);
  assert.match(head, /AppView\._feedClampObserver\.disconnect\(\)/);
});

test('the observer measures every comment before it changes any control', () => {
  // Showing or hiding a control is a style change, and the next
  // `scrollHeight` makes the browser apply it before answering. Read, write,
  // read, write pays for that once per comment; all the reads first pays once.
  let fire = null;
  const AppView = makeAppView({
    ResizeObserver: function ResizeObserver(cb) {
      fire = cb;
      return { observe() {}, disconnect() {} };
    },
  });
  const log = [];
  const a = fakeComment({ scrollHeight: 240, clientHeight: 80, log });
  const b = fakeComment({ scrollHeight: 240, clientHeight: 80, log });
  AppView._clampFeedComments(a.root);
  AppView._clampFeedComments(b.root);
  fire([{ target: a.clamp }, { target: b.clamp }]);
  assert.deepEqual(log, ['read', 'read', 'write', 'write']);
  assert.equal(a.btn.hidden, false);
  assert.equal(b.btn.hidden, false);

  // Reported again with nothing changed (the observer reports every box
  // after each wiring pass): measured, and no control is touched.
  log.length = 0;
  fire([{ target: a.clamp }, { target: b.clamp }]);
  assert.deepEqual(log, ['read', 'read'], 'an unchanged answer writes nothing');
});

test('every painted slot is clamped, not just the one that was asked for', () => {
  // The same issue holds a slot in more than one place at once (the
  // Workshop's stage pane IS the Board's columns), and `paint` writes to all
  // of them. Each gets its own measurement and its own listeners.
  const src = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  async _fillFeedComments(slot) {'));
  assert.match(
    src.slice(0, src.indexOf('const cached')),
    /for \(const node of live\) \{[\s\S]*?if \(AppView\._feedSlotShows\(node, html\)\) continue;\s*node\.innerHTML = html;\s*AppView\._feedCommentsPainted\.set\(node, html\);\s*AppView\._clampFeedComments\(node\);\s*\}/,
  );
});

// ── 5b. How often the slots are wired, fetched and written ────────────
//
// Measured on the platform's own board with every card open (October 2026):
// one load called `_wireFeedComments` 17 times, fetched the same three
// threads six times each and wrote them 24 times, and each write was followed
// by a measurement that restyled about 9,000 elements. These pin the three
// things that stopped it.

/** A page of comment slots, enough of a DOM for the wiring and the fill. */
function fakeBoard(numbers) {
  const slots = numbers.map((n) => {
    const slot = {
      number: n,
      writes: 0,
      html: '',
      firstChild: null,
      getAttribute: (k) => (k === 'data-comments-for' ? String(n) : null),
      closest: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    Object.defineProperty(slot, 'innerHTML', {
      get() { return slot.html; },
      set(v) { slot.html = v; slot.writes += 1; slot.firstChild = v ? {} : null; },
    });
    return slot;
  });
  const root = {
    isConnected: true,
    querySelectorAll: (sel) => (sel.startsWith('.dev-feed-comments') ? slots : []),
  };
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
    body: { appendChild: () => {} },
    querySelectorAll: (sel) => {
      const m = /data-comments-for="(\d+)"/.exec(sel);
      return m ? slots.filter((s) => s.number === Number(m[1])) : [];
    },
  };
  return { slots, root, document };
}

/** Let every queued microtask and resolved fetch run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('however many callers ask in one paint, the slots are wired once', async () => {
  const { root, document } = fakeBoard([11, 12, 13, 14, 15]);
  const requests = [];
  const AppView = makeAppView({
    document,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ comments: [{ author: 'a', body: 'hi', createdAt: '2026-03-04T15:30:00Z' }] }) };
    },
  });
  let passes = 0;
  const now = AppView._wireFeedCommentsNow;
  AppView._wireFeedCommentsNow = function wire() { passes += 1; return now.apply(this, arguments); };

  // The Workshop's effect, four columns and the repaint, as one load makes them.
  for (let i = 0; i < 6; i += 1) AppView._wireFeedComments(root);
  assert.equal(passes, 0, 'nothing is wired on the caller\'s line');
  await settle();
  assert.equal(passes, 1, 'one pass for the six calls');
  assert.equal(requests.length, AppView.FEED_COMMENT_EAGER, 'and only the first few slots are fetched');

  // A teardown forgets what was queued before it.
  AppView._wireFeedComments(root);
  AppView._wireFeedComments(null);
  await settle();
  assert.equal(passes, 2, 'the pass still runs, and finds nothing to do');
  assert.equal(AppView._feedCommentObserver, null);
});

test('a thread is requested once and written once, however often it is asked for', async () => {
  const { slots, root, document } = fakeBoard([21, 22, 23]);
  const requests = [];
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const AppView = makeAppView({
    document,
    fetch: async (url) => {
      requests.push(url);
      await gate;
      return { ok: true, json: async () => ({ comments: [{ author: 'a', body: 'hi', createdAt: '2026-03-04T15:30:00Z' }] }) };
    },
  });

  // Asked for again and again while the first answers are still on the wire:
  // the cache is only written when an answer lands, so it cannot stop this.
  for (let i = 0; i < 4; i += 1) {
    AppView._wireFeedComments(root);
    await settle();
  }
  assert.equal(requests.length, 3, 'one request per thread, not one per ask');
  assert.match(requests[0], /\/api\/apps\/demo-app\/github-issues\/21\/comments/);

  release();
  await settle();
  assert.deepEqual(slots.map((s) => s.writes), [1, 1, 1], 'each slot is written when its answer lands');
  assert.deepEqual(Object.keys(AppView._ghCommentsInFlight), [], 'and nothing is left marked as on the wire');

  // And asked for after that, with the answer cached and already on screen:
  // no request, and no second write of the same HTML.
  for (let i = 0; i < 4; i += 1) {
    AppView._wireFeedComments(root);
    await settle();
  }
  assert.equal(requests.length, 3);
  assert.deepEqual(slots.map((s) => s.writes), [1, 1, 1], 'a slot showing the cached answer is left alone');

  // A slot something emptied is not believed: it is filled again.
  slots[0].html = '';
  slots[0].firstChild = null;
  AppView._wireFeedComments(root);
  await settle();
  assert.equal(slots[0].writes, 2);

  // A new answer for the same issue (the opened topic refetches the thread)
  // is a different entry, and replaces what the slot shows.
  AppView._ghComments.set(AppView._ghCommentsKey('demo-app', 22),
    { comments: [{ author: 'b', body: 'newer', createdAt: '2026-03-05T15:30:00Z' }], truncated: false });
  AppView._wireFeedComments(root);
  await settle();
  assert.equal(slots[1].writes, 2);
  assert.match(slots[1].html, /newer/);

  // What is compared is the HTML a fill would write, not the answer it came
  // from, because a comment's age ("5m ago") is rendered into it and nothing
  // else keeps that fresh. Same answer, a minute later: written again, once.
  const render = AppView._feedCommentsHtml;
  AppView._feedCommentsHtml = (comments) => render(comments).replace(/dev-feed-comment-time"/g, 'dev-feed-comment-time" data-later="1"');
  AppView._wireFeedComments(root);
  await settle();
  assert.deepEqual(slots.map((s) => s.writes), [3, 3, 2], 'a slot is rewritten when what it would say has changed');
  AppView._wireFeedComments(root);
  await settle();
  assert.deepEqual(slots.map((s) => s.writes), [3, 3, 2], 'and only then');
  assert.equal(requests.length, 3, 'none of it asked the server again');
});

test('a failed request is forgotten, so the next ask can try again', async () => {
  const { root, document } = fakeBoard([31]);
  let calls = 0;
  const AppView = makeAppView({
    document,
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { ok: true, json: async () => ({ comments: [] }) };
    },
  });
  AppView._wireFeedComments(root);
  await settle();
  assert.deepEqual(Object.keys(AppView._ghCommentsInFlight), []);
  AppView._wireFeedComments(root);
  await settle();
  assert.equal(calls, 2);
});

// #4178: issue numbers repeat across apps (each has its own repository), and
// the cache outlives the app view, so it is keyed by app AND number.
const commentsFor = (body) => ({ ok: true, json: async () => ({ comments: [{ author: 'a', body, createdAt: '2026-03-04T15:30:00Z' }] }) });

test('the same issue number in another app is its own thread, not a cache hit', async () => {
  const { slots, document } = fakeBoard([12]);
  const requests = [];
  const AppView = makeAppView({
    document,
    fetch: async (url) => {
      requests.push(url);
      return commentsFor(url.includes('/apps/other-app/') ? 'from other-app' : 'from demo-app');
    },
  });

  await AppView._fillFeedComments(slots[0]);
  assert.match(slots[0].html, /from demo-app/);

  AppView.appData = { slug: 'other-app', can_collaborate: true };
  await AppView._fillFeedComments(slots[0]);
  assert.equal(requests.length, 2, 'the other app\'s #12 is asked for, not answered from cache');
  assert.match(requests[1], /\/api\/apps\/other-app\/github-issues\/12\/comments/);
  assert.match(slots[0].html, /from other-app/);
  assert.doesNotMatch(slots[0].html, /from demo-app/);

  // Back in the first app, its own answer is still cached.
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  await AppView._fillFeedComments(slots[0]);
  assert.equal(requests.length, 2);
  assert.match(slots[0].html, /from demo-app/);
});

test('an answer that lands after another app opened is cached, not painted', async () => {
  const { slots, document } = fakeBoard([12]);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const AppView = makeAppView({
    document,
    fetch: async () => { await gate; return commentsFor('from demo-app'); },
  });

  const pending = AppView._fillFeedComments(slots[0]);
  await settle();
  AppView.appData = { slug: 'other-app', can_collaborate: true };
  release();
  await pending;
  assert.equal(slots[0].writes, 0, 'other-app\'s slot for #12 is left alone');
  assert.ok(AppView._ghComments.has(AppView._ghCommentsKey('demo-app', 12)), 'the answer is kept for its own app');
  assert.ok(!AppView._ghComments.has(AppView._ghCommentsKey('other-app', 12)));
});

test('an opened issue does not show another app\'s comments for the same number', async () => {
  let renders = 0;
  const AppView = makeAppView({
    fetch: async (url) => commentsFor(url.includes('/apps/other-app/') ? 'from other-app' : 'from demo-app'),
    // #4453: the comments are rows of the request page's thread, which the
    // loader redraws once they are in hand.
    GroupChat: { activeThread: { type: 'issue', ref: 12 }, renderThread: () => { renders += 1; } },
  });
  AppView._devTopic = { kind: 'issue', id: 12 };
  const bodies = () => [...(AppView._requestThreadRows(12)?.rows || []).map((r) => r.text)];
  await AppView._loadIssueComments({ number: 12, htmlUrl: null });
  assert.deepEqual(bodies(), ['from demo-app']);

  AppView.appData = { slug: 'other-app', can_collaborate: true };
  await AppView._loadIssueComments({ number: 12, htmlUrl: null });
  assert.deepEqual(bodies(), ['from other-app']);
  assert.equal(renders, 2, 'each answer redraws the open request\'s stream');
});

test('a row\'s own thread under the card is keyed by app too', () => {
  // The Workshop draws rows from several apps on one screen, and the store
  // lives for the whole page, so two apps' issue #12 are two threads.
  const { threadKey, patchThread, readThread } = loadTsx('frontend/src/features/dev-board/card/feed-thread-store.ts');
  const a = threadKey('demo-app', 'issue', 12);
  const b = threadKey('other-app', 'issue', 12);
  assert.notEqual(a, b);
  assert.equal(threadKey('demo-app', 'issue', 12), a, 'the same thread is the same key');
  assert.notEqual(threadKey('demo-app', 'issue', 13), a);
  assert.notEqual(threadKey('demo-app', 'session', 12), a);
  patchThread(a, { loaded: true, total: 3 });
  assert.equal(readThread(a).total, 3);
  assert.equal(readThread(b).loaded, false, 'the other app\'s #12 is still to load');
});

// ── 6. The stylesheet the legacy surface clamps with ──────────────────

test('the Workshop clamp is four lines, and expanding releases it', () => {
  const at = CSS.indexOf(':is(#dev-workshop, #dev-kanban) .dev-feed-comment-clamp {');
  assert.ok(at > 0, 'app.css clamps the Workshop slot');
  const block = CSS.slice(at, at + 1400);
  // `-webkit-line-clamp` is the only cross-browser way to ellipsise at a
  // line COUNT; the standard property rides alongside it, as it does in
  // every other clamp in this stylesheet.
  assert.match(block, /-webkit-line-clamp: 4;/);
  assert.match(block, /\n  line-clamp: 4;/);
  assert.match(block, /-webkit-box-orient: vertical;/);
  assert.match(block, /overflow: hidden;/);
  assert.match(block, /\.dev-feed-comment-clamp\.is-expanded \{[^}]*overflow: visible;/);
  assert.match(CSS, /\.dev-feed-comment-toggle\[hidden\] \{ display: none; \}/);
});

test('both implementations clamp at the same number of lines', () => {
  const AppView = makeAppView();
  assert.equal(AppView.FEED_COMMENT_CLAMP_LINES, mod().CLAMP_LINES);
  assert.match(CSS, new RegExp(`-webkit-line-clamp: ${AppView.FEED_COMMENT_CLAMP_LINES};`));
});
