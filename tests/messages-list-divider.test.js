'use strict';

// Desktop polish 09, 10 and 11 (24 Nov 2026), the three Messages changes of
// the desktop hand-off:
//
//   09 the line between the list and the pane beside it is a handle, and
//      the list's heading says DMs & groups;
//   10 the list's foot says Jump to bottom, and on a desktop the list fades
//      out under it to its bottom edge;
//   11 a continuation line's hover bar sits on its bubble.
//
// They run the real modules where there is something to run (the width's
// value and its <html> property, the bubble's measure, the separator's
// markup) and pin the stylesheet's rules where the browser does the rest.
//
// Run with: node --test tests/messages-list-divider.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CSS = read('public/css/app.css');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const DIVIDER = 'frontend/src/features/messages/list-divider.tsx';

/** The body of the first rule whose selector is exactly `selector`. */
function rule(selector, from = 0) {
  const at = CSS.indexOf(`${selector} {`, from);
  assert.ok(at >= 0, `${selector} is in app.css`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

test('09: the list\'s width is Messages\' own, clamped to 280px..42%, and never the bot tab\'s', () => {
  const mod = loadTsx(DIVIDER);
  assert.equal(mod.LIST_WIDTH_KEY, 'messages-list-width-v1', 'kept on this device under its own key');
  assert.notEqual(mod.LIST_WIDTH_KEY, 'messages-reply-width-v1', 'not the reply thread\'s');
  assert.equal(mod.LIST_WIDTH_PROPERTY, '--messages-list-chosen-w');
  assert.equal(mod.LIST_MIN, 280);
  assert.equal(mod.listWidthValue(360.4), 'clamp(280px, 360px, 42%)');
  assert.equal(mod.listWidthValue(90), 'clamp(280px, 90px, 42%)', 'the floor is the stylesheet\'s to hold');

  // On <html>: set for a width, gone for the default.
  const props = new Map();
  const root = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  mod.applyListWidth(400, root);
  assert.equal(props.get('--messages-list-chosen-w'), 'clamp(280px, 400px, 42%)');
  mod.applyListWidth(null, root);
  assert.equal(props.has('--messages-list-chosen-w'), false);

  // The pane reads it, with the inbox's measure as the default; the bot
  // tab's floor still reads `--list-pane-w`, which is left as it was.
  assert.match(CSS, /:root \{ --list-pane-w: 22rem; \}/);
  assert.match(CSS, /\.messages-list-pane \{\n\s*position: relative;\n\s*flex: 0 0 var\(--messages-list-chosen-w, var\(--list-pane-w\)\);\n\s*width: var\(--messages-list-chosen-w, var\(--list-pane-w\)\);/);
  assert.match(CSS, /--ai-list-min: var\(--list-pane-w\);/, 'the bot tab\'s list is untouched');
  assert.doesNotMatch(CSS, /--list-pane-w:\s*var\(--messages-list-chosen-w/, 'the shared measure is never the chosen width');
  // With nothing open, the standard look's two-up page keeps its 26rem default.
  assert.match(CSS, /html:root \.messages-layout\.messages-list-page > \.messages-list-pane \{ flex: none; width: var\(--messages-list-chosen-w, 26rem\); max-width: 42%;/);
});

test('09: the handle is a focusable separator with the bot tab\'s grip, after the list\'s foot', () => {
  const { ListDivider } = loadTsx(DIVIDER);
  const html = renderToHtml(createElement(ListDivider));
  assert.match(html, /^<div class="messages-list-divider split-handle" role="separator" aria-orientation="vertical" aria-label="Resize the conversation list" title="Drag to resize · double-click to reset" tabindex="0" data-messages-list-divider=""><\/div>$/,
    'the first render carries no width: it is read after mount, so the prerender and hydration agree');
  assert.equal(message('messages:inbox.resize'), 'Resize the conversation list');
  // After InboxToEnd, which has to stay the scroller's next sibling for the fade.
  assert.match(SCREEN, /<InboxToEnd scroller=\{scrollRef\} \/>\n(\s*\{\/\*[\s\S]*?\*\/\}\n)?\s*<ListDivider \/>\n\s*<\/section>/);
  // The grip is `.split-handle`'s: 6 x 48, unseen at rest, half strength
  // under an armed pointer, the accent while held.
  assert.match(CSS, /:is\(\.split-handle, html:root \.side-panel-divider\)::before \{[^}]*width: 6px;[^}]*height: 48px;/);
  const src = read(DIVIDER);
  assert.match(src, /armOnMove\(ref\.current\)/, 'armed by a real move, as the Workshop\'s handle');
  assert.match(src, /startSplitDrag\(e, drag\)/);
  assert.match(src, /splitKey\(e\.key, e\.shiftKey \? LIST_KEY_STEP \* 4 : LIST_KEY_STEP, drag\)/);
  assert.match(src, /onDoubleClick=\{\(\) => \{\n\s*writeSplitWidth\(LIST_WIDTH_KEY, null\);\n\s*applyListWidth\(null\);/, 'a double-click goes back to the default');
  // Applied when the module loads, before the screen is first drawn.
  assert.match(src, /\nif \(typeof document !== 'undefined' && typeof window !== 'undefined'\) \{\n\s*applyListWidth\(readSplitWidth\(LIST_WIDTH_KEY, LIST_MIN\)\);\n\}/);
});

test('09: the handle is drawn from 768px only, and not where nothing stands beside the list', () => {
  assert.match(CSS, /\.messages-list-divider \{ display: none; \}\n@media \(min-width: 768px\) \{\n\s*\.messages-list-pane \{/);
  const desk = rule('  .messages-list-divider');
  assert.match(desk, /display: block;/);
  assert.match(desk, /cursor: col-resize;/);
  assert.match(desk, /touch-action: none;/);
  assert.match(CSS, /\.messages-layout\.messages-list-page > \.messages-list-pane > \.messages-list-divider \{ display: none; \}/,
    'a look that draws the list as the page alone has no handle');
  assert.match(CSS, /html:root \.messages-layout\.messages-list-page > \.messages-list-pane > \.messages-list-divider \{ display: block;/,
    'the standard look\'s two-up page has one');
});

test('09: the heading reads DMs & groups', () => {
  assert.equal(message('messages:inbox.section.people'), 'DMs & groups');
  const entry = JSON.parse(read('frontend/locales/en/messages.json'))['inbox.section.people'];
  assert.match(entry.description, /direct messages and group chats/);
  // Small caps are the stylesheet's: the words stay a sentence.
  assert.match(SCREEN, /<span className="messages-section-name">\{t\('messages:inbox\.section\.people'\)\}<\/span>/);
});

test('10: Jump to bottom, and on a desktop the list fades out to its bottom edge while it is up', () => {
  assert.equal(message('messages:inbox.toEnd.label'), 'Jump to bottom');
  assert.equal(message('messages:inbox.toEnd.name'), 'Jump to the bottom of the list');
  const sel = '.messages-list-scroll:has(+ [data-inbox-to-end] button:not([inert]))';
  const phone = rule(sel);
  assert.match(phone, /#000 calc\(100% - var\(--inbox-foot\)\)\)/, 'a phone keeps the band under its tab bar solid');
  const at = CSS.indexOf(`@media (min-width: 768px) {\n  ${sel} {`);
  assert.ok(at > 0, 'a desktop rule follows it');
  const desk = rule(`  ${sel}`, at);
  for (const prop of ['-webkit-mask-image', 'mask-image']) {
    assert.ok(desk.includes(`${prop}: linear-gradient(to bottom, #000 calc(100% - var(--inbox-foot) - 72px), transparent calc(100% - var(--inbox-foot) - 48px));`),
      `${prop} ends transparent, with no solid band under the pill`);
  }
});

test('11: a continuation line of theirs puts its bar on the bubble', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  // Dedupe step 2: `barPlacement` decides it for every place that draws the
  // shared row, and the place names the class on its bar.
  assert.match(row, /if \(!sided \|\| mine\) return 'row';\n\s*return grouped \? 'bubble' : 'head';/);
  assert.match(row, /barClassName: `messages-message-actions \$\{placement === 'bubble' \? 'msgx-bar-on-bubble' : ''\}`,/);
  assert.ok(row.indexOf('const placement = barPlacement(') < row.indexOf('const controls = useMessageControls('), 'decided before the bar reads it');

  const onBubble = rule('.messages-message-actions.msgx-bar-on-bubble');
  assert.match(onBubble, /top: var\(--msgx-bubble-top, 0px\);/);
  assert.match(onBubble, /inset-inline-start: var\(--msgx-bubble-start, 0px\);/);
  assert.match(onBubble, /inset-inline-end: auto;/);
  assert.match(onBubble, /translate: calc\(var\(--rtl-sign, 1\) \* max\(0px, var\(--msgx-bubble-w, 0px\) - 100%\)\) calc\(2px - 100%\);/,
    'ends at the bubble\'s end, or starts at its start when the bubble is narrower; 2px over its top');
  const below = rule('.messages-message-actions.msgx-bar-on-bubble.msgx-bar-below');
  assert.match(below, /top: calc\(100% \+ 4px\);/, 'with no room above, under the row as every row\'s is');
  // The first message of a run keeps its place beside its name line.
  assert.match(CSS, /\.messages-message-head > \.messages-message-actions \{ top: -10px; inset-inline-end: auto; inset-inline-start: calc\(100% \+ 8px\); \}/);
});

test('11: bubbleBox measures the bubble (or the pictures first above it) in the row\'s own terms', () => {
  const { bubbleBox } = loadTsx('frontend/src/features/message-actions/action-bar.tsx');
  const el = (cls, box, children = []) => ({
    classList: { contains: (name) => cls.split(' ').includes(name) },
    children,
    getBoundingClientRect: () => box,
  });
  const make = (dir, kids) => {
    const wrap = el('min-w-0 flex-1 messages-bubble-wrap', null, kids);
    const avatar = el('avatar', null);
    const row = el('messages-message messages-message-grouped', { left: 100, right: 900, top: 50 }, [avatar, wrap]);
    row.direction = dir;
    return row;
  };
  global.window = {};
  global.getComputedStyle = (node) => ({ direction: node.direction || 'ltr' });
  try {
    const words = el('messages-bubble', { left: 160, right: 460, top: 54, width: 300 });
    assert.deepEqual(bubbleBox(make('ltr', [words])), { start: 60, width: 300, top: 4 });
    assert.deepEqual(bubbleBox(make('rtl', [words])), { start: 440, width: 300, top: 4 }, 'measured from the right in Arabic');
    const pictures = el('messages-message-images', { left: 160, right: 360, top: 54, width: 200 });
    const later = el('messages-bubble', { left: 160, right: 700, top: 260, width: 540 });
    assert.deepEqual(bubbleBox(make('ltr', [pictures, later])), { start: 60, width: 200, top: 4 }, 'pictures above the words take the bubble\'s part');
    assert.equal(bubbleBox(make('ltr', [el('messages-message-meta', {})])), null, 'nothing to sit on');
  } finally {
    delete global.window;
    delete global.getComputedStyle;
  }
  const bar = read('frontend/src/features/message-actions/action-bar.tsx');
  assert.match(bar, /if \(node\.classList\.contains\('msgx-bar-on-bubble'\)\) \{\n\s*const box = bubbleBox\(target\);/,
    'measured as the pointer or the keyboard comes in, with the rest of the bar\'s place');
});
