'use strict';

// #5691: the divider between a chat and its open thread, in Messages. A
// source test: the pane is drawn by React and its behaviour lives in pointer
// handlers, so it pins the contract the browser tests cannot reach — the
// separator's role and names, the clamps, and the rule that a remembered
// width is never read during the first render.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the reply pane opens with a separator, named, focusable and clamped to the chat\'s floor', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const pane = src.slice(src.indexOf('const REPLY_WIDTH_KEY'));
  assert.match(pane, /const REPLY_WIDTH_KEY = 'messages-reply-width-v1';/,
    'the width is this device\'s, under a key of its own');
  assert.match(pane, /const REPLY_MIN_WIDTH = 320;/);
  assert.match(pane, /const REPLY_CHAT_MIN_WIDTH = 360;/, 'the chat beside it always keeps 360px');
  assert.match(pane, /const REPLY_WIDTH_STEP = 24;/, 'one arrow key steps the divider');
  const handle = /<div\n\s*role="separator"\n\s*aria-orientation="vertical"\n\s*aria-label=\{t\('messages:replies\.resize'\)\}([\s\S]*?)\/>/.exec(pane);
  assert.ok(handle, 'the handle is a vertical separator with a spoken name');
  for (const part of ['aria-valuenow={replyWidth != null ? Math.round(replyWidth) : undefined}', 'aria-valuemin={REPLY_MIN_WIDTH}',
    'tabIndex={0}', 'className="messages-reply-resizer"', 'data-reply-resizer=""', 'onPointerDown={onReplyResizeStart}', 'onKeyDown={onReplyResizeKey}']) {
    assert.ok(handle[1].includes(part) || handle[0].includes(part), `the handle carries ${part}`);
  }
  // It is the aside's first child: the pane's left edge is the divider.
  assert.match(pane, /data-reply-thread=\{rootId\}\n    >\n\s*\{\/\*[\s\S]*?\*\/\}\n\s*<div\n\s*role="separator"/);
});

test('a remembered width is read in an effect and dragged left to widen the thread', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const pane = src.slice(src.indexOf('const REPLY_WIDTH_KEY'));
  assert.doesNotMatch(pane, /useState<number \| null>\(readReplyWidth/,
    'never read during the first render: the markup every first paint draws is the same');
  assert.match(pane, /useEffect\(\(\) => \{\n\s*const stored = readReplyWidth\(\);/);
  assert.match(pane, /window\.addEventListener\('resize'/, 'a narrower window re-clamps it');
  assert.match(pane, /startWidth - \(move\.clientX - startX\)/, 'dragging left widens it: its left edge is the divider');
  assert.match(pane, /setPointerCapture/, 'the drag keeps its pointer');
  assert.match(pane, /frame\.style\.pointerEvents = 'none'/, 'spec frames do not swallow the drag');
  assert.match(pane, /writeReplyWidth\(latest\)/, 'the chosen width is remembered');
  assert.match(pane, /event\.key === 'ArrowLeft' \? REPLY_WIDTH_STEP : -REPLY_WIDTH_STEP/, 'the arrow keys step it');
  // Only the desktop rule reads the width, so a phone is untouched.
  assert.match(pane, /\{ '--messages-reply-width': `\$\{replyWidth\}px` \} as CSSProperties/);
});

test('the divider CSS: hidden on a phone, a hairline in the gap from 768px, the accent under the pointer', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-reply-resizer \{ display: none; \}/);
  assert.match(css, /\.messages-reply-pane \{ flex: 0 0 var\(--messages-reply-width, min\(420px, 42%\)\); margin: 14px 12px 0 0; \}/,
    'the remembered width is the desktop basis only, over the old default');
  assert.match(css, /\.messages-reply-pane \{ flex: 1 1 auto; width: 100%; margin-top: 12px; \}/,
    'the phone keeps the pane it always had');
  assert.match(css, /\.messages-layout-embedded > \.messages-reply-pane > \.messages-reply-resizer \{ display: none; \}/,
    'a community page\'s embedded copy of a thread keeps no divider');
  const desktop = css.slice(css.indexOf('@media (min-width: 768px) {\n  .messages-reply-pane {'));
  const rule = /\n  \.messages-reply-resizer \{([^}]*)\}/.exec(desktop);
  assert.ok(rule, 'the divider is drawn from tablet width up');
  for (const part of ['display: block', 'position: absolute', 'left: -7px', 'top: 0', 'bottom: 0', 'width: 6px', 'cursor: col-resize', 'touch-action: none']) {
    assert.ok(rule[1].includes(part), `the divider is draggable: ${part}`);
  }
  assert.match(css, /\.messages-reply-resizer:hover, \.messages-reply-resizer:focus-visible \{ background: var\(--accent, #2563eb\); outline: none; \}/);
  assert.match(css, /\.messages-reply-resizer:focus-visible \{ outline: 2px solid var\(--accent, #2563eb\); outline-offset: 1px; \}/,
    'a focused divider is visible');
});

test('the divider says what it is, in the thread pane\'s own words', () => {
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.equal(catalog['replies.resize'].text, 'Resize the thread');
  assert.match(catalog['replies.resize'].description, /divider between a chat and its open thread/);
});
