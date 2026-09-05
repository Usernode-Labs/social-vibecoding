// The Dev FEED reads as a feed, not as a stack of tiles.
//
// Three changes, and each one fails silently if it drifts — a feed that
// quietly gets its card borders back, a merge bar that stops running the full
// width, comment slots that never fill — so each is pinned against the shipped
// source here rather than left to a staging screenshot.
//
// THE CONSTRAINT BEHIND ALL THREE: the card builders (_issueCardModel,
// _proposalCardModel, _mergedCardModel, …) are SHARED with the kanban
// columns, where a bordered tile is exactly right. Nothing here may change
// what those builders emit; the feed's treatment is scoped by ancestor
// (#dev-feed) and carried by a wrapper the FEED adds around each row
// (card/dev-feed.tsx's `.dev-feed-entry`). A test that let a card branch on
// "am I in the feed?" would be pinning the wrong design.
//
// Run with: node --test tests/dev-feed-stream.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const APP_VIEW = read('public/js/app-view.js');
const FEED = read('frontend/src/features/dev-board/card/dev-feed.tsx');
const CSS = read('public/css/app.css');
const dapp = JSON.parse(read('dapp.json'));
const AppView = require('../public/js/app-view.js');

test('the feed wraps each entry, and the card builders stay shared', () => {
  // The wrapper is the FEED's, not the card's — that is what keeps one
  // builder drawing a tile on the board and a stream row here.
  assert.match(FEED, /className="dev-feed-entry"/, 'the feed has an entry wrapper');
  assert.match(FEED, /<ListRowView row=\{row\} \/>/,
    'which wraps the card rather than replacing it');
  assert.match(FEED, /className="dev-feed-stream"/, 'the stream container is rendered');
  // Flush rows, not a gap-separated stack. `space-y-2` was the tile spacing,
  // and it is still what the PINNED BLOCK above the stream uses — so the
  // check has to be scoped to the stream itself.
  const stream = FEED.slice(FEED.indexOf('dev-feed-stream'));
  assert.ok(!stream.includes('space-y-2'), 'the gap between tiles is gone');

  // Every entry type goes through the same wrapper, so none can silently
  // keep the old chrome: _feedView builds one `card` row per kind and the
  // component wraps every row it is given.
  const at = APP_VIEW.indexOf('  _feedView()');
  assert.ok(at !== -1, 'the feed view model is built');
  const loop = APP_VIEW.slice(at, APP_VIEW.indexOf('\n  },', at));
  for (const builder of [
    '_issueCardModel', '_proposalCardModel', '_sharedSessionCardModel',
    '_mergedRowModel', '_govCardModel',
    // The app's general discussion. It is drawn as a CARD here and as chrome
    // above the kanban's columns, and the split is the point: in a stream of
    // what just happened, a conversation is one of the things that happened,
    // so it goes through the same builder-to-wrapper path as everything else
    // rather than being pinned on top of it.
    '_discussionCardModel',
  ]) {
    assert.ok(loop.includes(`AppView.${builder}(`), `${builder} feeds the stream`);
  }
  // Whitespace-tolerant: the issue branch pushes a multi-line object now that
  // its row carries a thread ref as well as a comments ref. What is being
  // counted is that there are six card pushes, one per kind — not how any one
  // of them happens to be wrapped.
  assert.equal((loop.match(/entries\.push\(\{\s*t: 'card'/g) || []).length, 6,
    'and every one of them is pushed as an ordinary card row');
});

test('the feed draws CARDS, and nothing strips the shared tile treatment', () => {
  // The feed used to de-card its rows — `border: 0; border-radius: 0;
  // background: transparent` — to read as a stream. It was removed: the same
  // component renders `v.block` OUTSIDE .dev-feed-entry, so those rows kept
  // their card face and sat directly above the flattened ones, and one list
  // in two visual languages is what a reader actually sees. The de-carded
  // half also gave up the white surface the language separates figure from
  // ground with.
  //
  // So no rule anywhere may strip the row's fill or its corner. The kanban
  // reads the SAME class, which is why this was scoped to #dev-feed in the
  // first place — a bare `.gc-vote-item { border: 0 }` would flatten the
  // board too, and now there is no scoped version either.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const strip = rules.match(/[^\n{]*\.gc-vote-item[^{]*\{[^}]*\}/g) || [];
  for (const rule of strip) {
    assert.doesNotMatch(rule, /border-radius:\s*0/, `a rule still flattens the corner: ${rule.slice(0, 70)}`);
    assert.doesNotMatch(rule, /background:\s*transparent/, `a rule still clears the fill: ${rule.slice(0, 70)}`);
  }
  // And the shared class itself carries the tile treatment, because both the
  // board and the feed read it. Since the widget language landed (#1191) the
  // tile is drawn by SURFACE rather than by hairline — a white card on the
  // grey page ground, with the corner carrying the shape the border used to.
  assert.match(APP_VIEW, /DEV_CARD_CLS: '[^']*rounded-2xl[^']*bg-white[^']*'/,
    'DEV_CARD_CLS draws the tile both surfaces use');
  // Cards need a gap where the stream had a separator.
  assert.match(CSS, /#dev-feed \.dev-feed-entry \+ \.dev-feed-entry \{[^}]*margin-top:\s*0\.5rem/,
    'entries are spaced like the block above them (space-y-2)');
  assert.doesNotMatch(rules, /#dev-feed \.dev-feed-entry \{[^}]*margin-left:\s*-0\.75rem/,
    'entries no longer pull out through the body gutter');
});

test('a landed change still reads as a marker, as a tinted card', () => {
  // Completed work is marked by the CARD BUILDER (both kinds), so the feed
  // can draw it differently without knowing which builder produced the row.
  const marked = APP_VIEW.match(/'data-completed': '1'/g) || [];
  assert.equal(marked.length, 2,
    'both completed builders — merged PR and applied issue-close — are marked');

  // The emerald edge and the tint survive the change from band to card; the
  // edge follows the corner now instead of running flush to the column edge.
  assert.match(CSS, /\[data-completed\]\s*\{[^}]*border-left:\s*3px solid/,
    'the completed row carries an emerald edge');
  assert.match(CSS, /\[data-completed\]\s*\{[^}]*background:/,
    'and a tint that separates it from the in-flight entries');
  // The edge eats 3px, so the padding gives it back — otherwise a merged
  // row's text sits 3px right of every row above it.
  assert.match(CSS, /\[data-completed\]\s*\{[^}]*padding-left:\s*calc\(0\.875rem - 3px\)/,
    'content stays aligned with the un-edged rows');
});

test('inline comments load lazily, per row, off the existing endpoint', () => {
  // A feed of thirty issues must not fire thirty requests on paint.
  assert.match(APP_VIEW, /_feedCommentObserver/, 'there is an observer');
  assert.match(APP_VIEW, /new IntersectionObserver\(/, 'rows fill when scrolled to');

  const at = APP_VIEW.indexOf('  _wireFeedComments(root) {');
  const wire = APP_VIEW.slice(at, APP_VIEW.indexOf('\n  },', at));
  // Rebuilt each render: _rerenderFeed replaces the container's innerHTML,
  // which detaches every node the previous observer was watching.
  assert.match(wire, /disconnect\(\)/, 'the previous observer is torn down');
  // Once per slot, and unobserved BEFORE the await — a fast scroll would
  // otherwise queue the same fetch several times.
  assert.match(wire, /observer\.unobserve\(entry\.target\);\s*\n\s*AppView\._fillFeedComments/,
    'a slot is unobserved before its fetch starts');

  const fillAt = APP_VIEW.indexOf('  async _fillFeedComments(slot) {');
  const fill = APP_VIEW.slice(fillAt, APP_VIEW.indexOf('\n  },', fillAt));
  // Reuses the opened-topic view's cache and endpoint, so a row you have
  // already read paints with no request at all.
  assert.match(fill, /AppView\._ghComments\[number\]/, 'reads the existing cache');
  assert.match(fill, /github-issues\/\$\{number\}\/comments/, 'and the existing endpoint');
  assert.ok(!/POST|method:/.test(fill), 'read-only — no new write path');
  // Re-resolved by number after the await: a WS repaint detaches the node,
  // and writing into an orphan would silently drop the comments.
  assert.match(fill, /querySelector\(`\.dev-feed-comments\[data-comments-for="\$\{number\}"\]`\)/,
    'the slot is re-resolved after the await');

  // The preview is the TAIL of the thread — a thread's live part — and is
  // NOT the opened-topic renderer, which boxes every comment.
  assert.match(APP_VIEW, /FEED_COMMENT_PREVIEW: \d/, 'the preview is bounded');
  const feedAt = APP_VIEW.indexOf('  _feedCommentsHtml(comments) {');
  const feedFn = APP_VIEW.slice(feedAt, APP_VIEW.indexOf('\n  },', feedAt));
  assert.match(feedFn, /list\.slice\(-AppView\.FEED_COMMENT_PREVIEW\)/, 'shows the tail');
  assert.match(feedFn, /earlier \$\{hidden === 1 \? 'reply' : 'replies'\}/,
    'and says how many are behind it');
  // An empty slot collapses rather than reserving space for a thread that
  // does not exist.
  assert.match(CSS, /\.dev-feed-comments:empty \{ display: none; \}/);
});

test('the observer watches the ROW, because an empty slot has no box', () => {
  // The two halves asserted above contradicted each other, and nothing was
  // checking the link between them. The slot ships EMPTY -- that is the whole
  // point of filling it lazily -- and `#dev-feed .dev-feed-comments:empty` is
  // `display: none`, so it leaves no gap under a row with nothing to show. A
  // display:none element has no box, an IntersectionObserver never reports one
  // as intersecting, so the callback never ran, so the slot was never filled,
  // so it stayed :empty. A deadlock: every inline comment preview in the feed
  // was dead, and the declared check for the relative ages (#1585) with it.
  //
  // Driven rather than grepped, because the bug is a RELATIONSHIP between a
  // stylesheet and an observer target and every source read of either half
  // looks correct on its own.
  const observed = [];
  const prevIO = global.IntersectionObserver;
  const prevObserver = AppView._feedCommentObserver;
  const slot = {
    closest: (sel) => (sel === '.dev-feed-entry' ? row : null),
  };
  const row = { querySelector: (sel) => (/dev-feed-comments/.test(sel) ? slot : null) };
  const root = { querySelectorAll: () => [slot] };
  global.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { observed.push(el); }
    unobserve() {}
    disconnect() {}
  };
  try {
    AppView._feedCommentObserver = null;
    AppView._wireFeedComments(root);
  } finally {
    global.IntersectionObserver = prevIO;
    AppView._feedCommentObserver = prevObserver;
  }
  assert.equal(observed.length, 1, 'one target per slot');
  assert.equal(observed[0], row,
    'the ROW is observed -- the slot is display:none until it has content');
});

test('inline comments show a relative age at the right edge', () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-09-04T12:00:00Z');
  try {
    const html = AppView._feedCommentsHtml([{
      author: 'alice',
      body: 'A recent comment',
      createdAt: '2026-09-04T10:00:00Z',
    }]);
    assert.match(html, /class="dev-feed-comment-time">2h ago<\/span>/,
      'the endpoint\'s existing createdAt value becomes a compact relative age');

    const invalid = AppView._feedCommentsHtml([{
      author: 'alice', body: 'No timestamp', createdAt: 'not-a-date',
    }]);
    assert.doesNotMatch(invalid, /dev-feed-comment-time/,
      'a missing or invalid timestamp leaves no empty age label behind');
  } finally {
    Date.now = realNow;
  }

  assert.match(CSS, /#dev-feed \.dev-feed-comment \{[^}]*display:\s*flex/s,
    'the comment row owns a left/right layout');
  assert.match(CSS, /#dev-feed \.dev-feed-comment-main \{[^}]*flex:\s*1[^}]*min-width:\s*0/s,
    'long author and body content wraps in the space left of the age');
  assert.match(CSS, /#dev-feed \.dev-feed-comment-time \{[^}]*flex-shrink:\s*0[^}]*margin-left:\s*auto/s,
    'the age stays visible at the right edge');
});

test('the declared checks cover the stream and the comment slots', () => {
  const sels = dapp.tests.map((t) => t.expectSelector || '').join('\n');
  assert.match(sels, /dev-feed-entry/,
    'a check pins the de-carded entry row');
  assert.match(sels, /dev-feed-comments\[data-comments-for\]/,
    'and one pins the inline-comment slot');
  assert.match(sels, /dev-feed-comment-time/,
    'and staging must render a relative age inside that slot');
  // Pin the timestamp element rather than its text: staging mock threads
  // carry real relative timestamps, so their displayed ages necessarily
  // move as the preview clock advances.
});

// ── The staging demo has to contain what the testing steps ask for ──
//
// Not feed work, but the same failure mode and caught the same way: a review
// surface that renders nothing in a preview because the data behind it does
// not exist there. The drawer's "older notifications" view is invisible
// without an already-read row, and a staging clone has none.

test('the notifications demo seeds an already-read row', () => {
  const ROUTE = read('src/routes/notifications.js');

  const at = ROUTE.indexOf('function stagingMockNotifications()');
  assert.ok(at !== -1, 'the mock feed survives');
  const fn = ROUTE.slice(at, ROUTE.indexOf('\n}', at));

  // Exactly one read row: enough for "See 1 older notification" and the
  // caught-up state to be reachable, without burying the unread ones the
  // other checks read.
  const readRows = fn.match(/readAt: new Date\(/g) || [];
  assert.equal(readRows.length, 1, 'one already-read demo row');
  assert.match(fn, /\[Mock\] Something you already read/,
    'and it is obviously fake, like every other row here');

  // The unread COUNT must not include it. This was `mocks.length` while every
  // mock was unread; leaving it that way would claim a read row as unread —
  // inflating the red badge and leaving "Mark all read" enabled with nothing
  // to mark.
  assert.match(ROUTE, /payload\.unread \+= mocks\.filter\(\(m\) => !m\.readAt\)\.length;/,
    'only the unread mocks are counted');
  assert.ok(!/payload\.unread \+= mocks\.length;/.test(ROUTE),
    'the unconditional count is gone');

  // Still strictly staging + ?demo=1, never persisted.
  assert.match(ROUTE, /IS_STAGING && req\.query\.demo === '1'/,
    'the injection stays gated on staging and the demo flag');
});
