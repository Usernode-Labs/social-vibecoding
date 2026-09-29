// "Show more" on a long comment (#2556), on all three surfaces that draw one.
//
// ── Why one file for three surfaces ────────────────────────────────────
//
// A card's comments render in three places and they do NOT share a renderer:
// the topic sheet's GitHub discussion and the card's own reply thread are
// React (frontend/src/features/dev-board/), and the Workshop's inline
// recent-comments slot is an innerHTML string written by the legacy
// `AppView._fillFeedComments`. A React island must not reconcile over a node
// `public/js/**` writes, so the clamp is implemented twice on purpose.
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

// ── 3. Surface one: the topic sheet's GitHub discussion ───────────────

test('the issue discussion clamps each comment body', () => {
  const html = renderToHtml(createElement(
    loadTsx('frontend/src/features/dev-board/issue-comments.tsx').IssueCommentsView,
    {
      comments: [{
        key: '1',
        author: 'evan',
        bot: false,
        createdAt: '2026-03-04T15:30:00Z',
        bodyHtml: `<p>${'a long comment. '.repeat(80)}</p>`,
      }],
      truncated: false,
      htmlUrl: null,
    },
  ));
  assert.match(html, /class="dev-feed-msg-text dev-issue-body line-clamp-4"/);
  // The control is NOT in the first paint: only a laid-out box can say
  // whether this comment is long, and an island's initial render has to be
  // the markup the prerendered document carries.
  assert.doesNotMatch(html, /Show more/);
});

// ── 4. Surface two: the card's own reply thread ───────────────────────

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

/** A stand-in for one rendered comment: a clamp span, its main, its button. */
function fakeComment({ scrollHeight, clientHeight, expanded = false }) {
  const classes = new Set(['dev-feed-comment-clamp', ...(expanded ? ['is-expanded'] : [])]);
  const btn = {
    hidden: true,
    textContent: 'Show more',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { if (type === 'click') this.click = fn; },
  };
  const clamp = {
    scrollHeight,
    clientHeight,
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
  const { clamp, btn, root } = fakeComment({ scrollHeight: 0, clientHeight: 0 });
  AppView._clampFeedComments(root);
  assert.equal(btn.hidden, true, 'nothing measurable yet');
  assert.deepEqual(observed, [clamp], 'the clamped box is watched');

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
  const head = src.slice(0, src.indexOf('if (!root) return;'));
  assert.match(head, /AppView\._feedCommentObserver\.disconnect\(\)/);
  assert.match(head, /AppView\._feedClampObserver\.disconnect\(\)/);
});

test('every painted slot is clamped, not just the one that was asked for', () => {
  // The same issue holds a slot in more than one place at once (the
  // Workshop's stage pane IS the Board's columns), and `paint` writes to all
  // of them. Each gets its own measurement and its own listeners.
  const src = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  async _fillFeedComments(slot) {'));
  assert.match(
    src.slice(0, src.indexOf('const cached')),
    /for \(const node of live\) \{\s*node\.innerHTML = html;\s*AppView\._clampFeedComments\(node\);\s*\}/,
  );
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
