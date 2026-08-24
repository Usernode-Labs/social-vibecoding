// The Dev FEED reads as a feed, not as a stack of tiles.
//
// Three changes, and each one fails silently if it drifts — a feed that
// quietly gets its card borders back, a merge bar that stops running the full
// width, comment slots that never fill — so each is pinned against the shipped
// source here rather than left to a staging screenshot.
//
// THE CONSTRAINT BEHIND ALL THREE: the row renderers (_renderIssueRow,
// _renderProposalCard, _renderMergedCard, …) are SHARED with the kanban
// columns, where a bordered tile is exactly right. Nothing here may change
// what those renderers emit; the feed's treatment is scoped by ancestor
// (#dev-feed) and carried by a wrapper the feed adds around each row. A test
// that let the renderers branch on "am I in the feed?" would be pinning the
// wrong design.
//
// Run with: node --test tests/dev-feed-stream.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const APP_VIEW = read('public/js/app-view.js');
const CSS = read('public/css/app.css');
const dapp = JSON.parse(read('dapp.json'));

test('the feed wraps each entry, and the row renderers stay shared', () => {
  // The wrapper is added by the FEED, not by the renderers — that is what
  // keeps one renderer drawing a tile on the board and a stream row here.
  assert.match(APP_VIEW, /_feedEntryHtml\(rowHtml, opts\)/,
    'the feed has an entry wrapper');
  assert.match(APP_VIEW, /<div class="dev-feed-entry">\$\{rowHtml\}\$\{slot\}<\/div>/,
    'which wraps the renderer output rather than replacing it');

  // Every branch of the feed loop goes through it, so no entry type can
  // silently keep the old chrome.
  const at = APP_VIEW.indexOf("html += '<div class=\"dev-feed-stream\">'");
  assert.ok(at !== -1, 'the stream container is rendered');
  const loop = APP_VIEW.slice(at, APP_VIEW.indexOf("html += '</div>';", at));
  for (const renderer of [
    '_renderIssueRow', '_renderProposalCard', '_renderSharedSessionCard',
    '_renderMergedRow', '_renderGovCard',
  ]) {
    const call = new RegExp(`_feedEntryHtml\\([\\s\\S]{0,80}AppView\\.${renderer}\\(`);
    assert.match(loop, call, `${renderer}'s output is wrapped`);
  }

  // Flush rows, not a gap-separated stack. `space-y-2` was the tile spacing.
  assert.ok(!loop.includes('space-y-2'), 'the gap between tiles is gone');
});

test('the de-carding is scoped to the feed, so the kanban keeps its cards', () => {
  // Every rule that strips chrome must be under #dev-feed. A bare
  // `.gc-vote-item { border: 0 }` would flatten the board too.
  const stripRules = CSS.match(/^[^\n{]*\.gc-vote-item[^{]*\{[^}]*border:\s*0[^}]*\}/gm) || [];
  assert.ok(stripRules.length > 0, 'the card chrome is stripped somewhere');
  for (const rule of stripRules) {
    assert.match(rule, /#dev-feed/,
      `chrome-stripping rule is not scoped to the feed: ${rule.slice(0, 80)}`);
  }
  // And the shared class itself still carries the tile treatment, because the
  // board reads it.
  assert.match(APP_VIEW, /DEV_CARD_CLS: '[^']*rounded-xl[^']*border[^']*'/,
    'DEV_CARD_CLS still draws a bordered tile for the kanban');
});

test('the merge bar runs the full width of the column', () => {
  // "Full-length" is the whole point: the row pulls back out through
  // #dev-body's gutter so its edge and its separator reach the container
  // edge, instead of floating with a gap at each end.
  assert.match(CSS, /#dev-feed \.dev-feed-entry \{[^}]*margin-left:\s*-0\.75rem/,
    'entries cancel the body gutter to go full-bleed');

  // Completed work is marked by the RENDERER (both kinds), so the feed can
  // draw it as a bar without knowing which renderer produced it.
  const marked = APP_VIEW.match(/data-completed="1"/g) || [];
  assert.equal(marked.length, 2,
    'both completed renderers — merged PR and applied issue-close — are marked');

  // …and the bar itself: an emerald edge along its length, tighter than a row.
  assert.match(CSS, /\[data-completed\]\s*\{[^}]*border-left:\s*3px solid/,
    'the completed row carries a full-length edge');
  assert.match(CSS, /\[data-completed\]\s*\{[^}]*background:/,
    'and a tint that separates it from the in-flight entries');
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

test('the declared checks cover the stream and the comment slots', () => {
  const sels = dapp.tests.map((t) => t.expectSelector || '').join('\n');
  assert.match(sels, /dev-feed-entry/,
    'a check pins the de-carded entry row');
  assert.match(sels, /dev-feed-comments\[data-comments-for\]/,
    'and one pins the inline-comment slot');
  // Deliberately NOT asserting rendered comment TEXT on staging: the demo
  // issues are mock numbers with no GitHub thread behind them, so a text
  // assertion there would be red for a reason that has nothing to do with
  // this code.
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
