// The divider between a chat and its open thread in Messages (#5691).
//
// On a computer the thread beside the chat with Homeroom bot (or any chat)
// can be dragged wider, so the request's spec and its before/after preview
// have room. The chosen width is remembered on the device; the chat keeps
// 360px and the thread 320px. On a phone the thread covers the chat, so the
// divider is not drawn. A community page's embedded copy of a thread keeps
// its fixed width: only Messages' own ReplyThreadPanel renders the handle.
//
// Run with: node --test tests/messages-reply-resizer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const source = read('frontend/src/features/messages/index.tsx');
const css = read('public/css/app.css');

test('the thread pane carries a vertical separator that says what it does', () => {
  assert.match(source, /role="separator"\s*\n\s*aria-orientation="vertical"\s*\n\s*aria-label=\{t\('messages:replies\.resize'\)\}/);
  assert.match(source, /aria-valuenow=\{replyWidth \?\? undefined\}/);
  assert.match(source, /aria-valuemin=\{REPLY_MIN_WIDTH\}/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /className="messages-reply-resizer"/);
  assert.match(source, /data-reply-resizer=""/);
  assert.match(source, /onPointerDown=\{onResizePointerDown\}/);
  assert.match(source, /onKeyDown=\{onResizeKeyDown\}/);
  // Messages only: the embedded pane on a community page never grows one.
  assert.equal((source.match(/data-reply-resizer=/g) || []).length, 1);
});

test('the width is the reader\'s, remembered on this device under its own key', () => {
  assert.match(source, /const REPLY_WIDTH_KEY = 'messages-reply-width-v1';/);
  assert.match(source, /localStorage\.getItem\(REPLY_WIDTH_KEY\)/);
  assert.match(source, /localStorage\.setItem\(REPLY_WIDTH_KEY/);
  // Never read during the first render: state starts empty, and the effect
  // fills it, so the server's markup and the client's first render agree.
  assert.match(source, /const \[replyWidth, setReplyWidth\] = useState<number \| null>\(null\);/);
  assert.match(source, /useEffect\(\(\) => \{\s*setReplyWidth\(\(current\) => clampReplyWidth\(current \?\? readReplyWidth\(\), layoutWidth\(\)\)\);/);
  // Written when a drag ends and when a key steps it.
  assert.match(source, /writeReplyWidth\(latest\);/);
  assert.match(source, /writeReplyWidth\(next\);/);
});

test('the clamp keeps the thread at 320px and the chat at 360px', () => {
  assert.match(source, /const REPLY_MIN_WIDTH = 320;/);
  assert.match(source, /const REPLY_CHAT_MIN_WIDTH = 360;/);
  assert.match(source, /const ceiling = typeof layoutWidth === 'number' && layoutWidth > 0\s*\n\s*\? Math\.max\(REPLY_MIN_WIDTH, layoutWidth - REPLY_CHAT_MIN_WIDTH - REPLY_MARGIN_WIDTH\)\s*\n\s*: Infinity;/);
  // Dragging left widens: the handle is the pane's left edge.
  assert.match(source, /latest = clampReplyWidth\(startWidth - \(move\.clientX - startX\), layoutWidth\(\)\)/);
  // Arrow keys step 24px, left widening.
  assert.match(source, /const REPLY_WIDTH_STEP = 24;/);
  assert.match(source, /event\.key === 'ArrowLeft' \? REPLY_WIDTH_STEP : -REPLY_WIDTH_STEP/);
  // A spec iframe swallows pointer moves: they are turned off while dragging.
  assert.match(source, /querySelectorAll\('iframe'\)/);
  assert.match(source, /frame\.style\.pointerEvents = 'none';/);
  // Re-clamped when the window resizes, so the chat is never squeezed out.
  assert.match(source, /window\.addEventListener\('resize', onResize\)/);
});

test('the divider is a hairline in the gap on a computer, and absent on a phone', () => {
  assert.match(css, /\.messages-reply-resizer \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 768px\) \{\s*\.messages-reply-resizer \{\s*display: block;\s*position: absolute;\s*left: -7px;\s*top: 0;\s*bottom: 0;\s*width: 6px;\s*border-radius: 3px;\s*cursor: col-resize;\s*touch-action: none;\s*background: var\(--app-sheet-line\);\s*z-index: 1;\s*\}/);
  assert.match(css, /\.messages-reply-resizer:hover,\s*\n\s*\.messages-reply-resizer:focus-visible \{ background: var\(--accent\); outline: none; \}/);
});

test('the divider has a spoken name, and the Expand button words of its own', () => {
  const messages = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.equal(messages['replies.resize'].text, 'Resize the thread');
  assert.ok(messages['replies.resize'].description);
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['shots.viewer.expand'].text, 'Expand');
  assert.equal(changes['shots.viewer.collapse'].text, 'Close');
  assert.ok(changes['shots.viewer.expand'].description);
  assert.ok(changes['shots.viewer.collapse'].description);
});
