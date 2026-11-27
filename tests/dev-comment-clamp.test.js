// "Show more" on a long comment (#2556).
//
// A card's reply thread (frontend/src/features/dev-board/card/feed-thread.tsx)
// clamps a long reply through comment-clamp.tsx. A second, hand-written copy
// of the clamp filled the unfolded board card's GitHub comment tail by
// innerHTML (`AppView._fillFeedComments`); it went with that card, so the
// clamp has one implementation now. (A request's own page draws its GitHub
// thread as rows of the page's Messages thread, whole, as Messages does,
// since #4453.)
//
// It keeps three promises:
//
//   1. Four lines, then a control. Not three, not six.
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

// ── 4. The comment cache a request's page reads ────────────────────────

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

// #4178: issue numbers repeat across apps (each has its own repository), and
// the cache outlives the app view, so it is keyed by app AND number.

test('an opened issue does not show another app\'s comments for the same number', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [{ number: 12, htmlUrl: null }];
  const bodies = () => (AppView._requestThreadRows(12)?.rows || []).map((r) => r.text);
  // #6497: the request's first page brings its comments; the cache is keyed
  // by app and issue, so project B's #12 never shows project A's (#4178).
  AppView._takeIssueComments('demo-app', 12, {
    comments: [{ id: 1, author: 'a', body: 'from demo-app', createdAt: '2026-03-04T15:30:00Z' }],
  });
  assert.deepEqual(bodies(), ['from demo-app']);

  AppView.appData = { slug: 'other-app', can_collaborate: true };
  assert.equal(AppView._requestThreadRows(12), null, 'the other app has nothing for #12 yet');
  AppView._takeIssueComments('other-app', 12, {
    comments: [{ id: 2, author: 'a', body: 'from other-app', createdAt: '2026-03-04T15:31:00Z' }],
  });
  assert.deepEqual(bodies(), ['from other-app']);

  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  assert.deepEqual(bodies(), ['from demo-app'], 'each answer is kept for its own app');
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

