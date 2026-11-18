'use strict';

// ONE THREAD, ONE HEADER (18 Nov 2026). A request's or a change's page is
// drawn on its own page, in the Workshop's side panel beside the list, and in
// the column beside Homeroom bot's list. It now draws the same header on all
// three, a sticky pill, and no panel draws chrome of its own around it:
//
//   - the sheet's bar (ChangeBar, RequestBar) leads with the project's tile,
//     says the project and the topic on its second line (the card's kicker
//     said them before) and ends with ↗ and × (thread-exits.tsx), which
//     app.css shows only inside a panel;
//   - the Workshop's panel hands those two discs its own close and
//     open-as-page (workshop/side-actions.ts) and draws no sheet or bar;
//   - the bot column puts its own header row away for those pages
//     (`data-thread-pill`) and the page in it paints no ground;
//   - the line between two columns is a grip that drags (lib/split-drag.ts),
//     shown only for a pointer that moved onto it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CHANGE = 'frontend/src/features/dev-board/topic/change-head.tsx';
const REQUEST = 'frontend/src/features/dev-board/topic/request-head.tsx';
const CSS = read('public/css/app.css');
// Loaded before any test fakes a window: the bundles run their module code once.
const { ChangeBar } = loadTsx(CHANGE);
const { RequestBar } = loadTsx(REQUEST);
const EXITS = loadTsx('tests/fixtures/thread-exits-api.ts');

function withProject(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AppView: { appData: { slug: 'homeroom-x', name: 'Homeroom', icon_emoji: '🏠', icon_url: null } } };
  try { return fn(); } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

const changeView = (patch = {}) => ({
  number: 9200, category: 'Project workflows', author: 'admin', at: null, time: '', timeTitle: '',
  via: null, status: null, votes: {}, testing: {}, shots: null, thanks: false, ...patch,
});

test('a change\'s bar is the pill: the project\'s tile first, "Change #N", the project and topic, ⋯, then ↗ and ×', () => {
  const html = withProject(() => renderToHtml(createElement(ChangeBar, { v: changeView(), menuKey: 'change:17' })));
  assert.match(html, /^<header class="messages-thread-header"><span class="app-icon-tile dev-thread-bar-tile"[^>]*aria-hidden="true">/,
    'the tile leads the header');
  assert.match(html, /<div class="messages-thread-name min-w-0">Change #9200<\/div>/);
  assert.match(html, /<div class="messages-thread-sub" data-change-category="">Homeroom · Project workflows<\/div>/,
    'the project, then the topic, on the second line');
  // ⋯ stays a direct child of the header (a declared check selects on it), and
  // the two discs end the row after it.
  assert.match(html, /<button type="button" class="messages-thread-action dev-card-menu-btn" data-card-menu="change:17"[\s\S]*?<\/button><span class="dev-thread-exits" data-thread-exits="">/);
  assert.match(html, new RegExp(`data-thread-exit="expand" aria-label="${message('project:sidePanel.openAsPage')}"`));
  assert.match(html, new RegExp(`data-thread-exit="close" aria-label="${message('core:common.close')}"`));
  // With no topic, the project alone, and no category attribute.
  const bare = withProject(() => renderToHtml(createElement(ChangeBar, { v: changeView({ category: null }), menuKey: '' })));
  assert.match(bare, /<div class="messages-thread-sub">Homeroom<\/div>/);
  assert.doesNotMatch(bare, /data-change-category/);
});

test('a request\'s bar is the same pill, its name kept beside its category for the checks that select on it', () => {
  const r = {
    number: 9107, title: 'Staging demo: a request', category: 'Project workflows', menuKey: null,
    status: { closed: false, stage: 'asked' },
  };
  const html = withProject(() => renderToHtml(createElement(RequestBar, { r, pill: null, threadMenu: true })));
  assert.match(html, /^<header class="messages-thread-header"><span class="app-icon-tile dev-thread-bar-tile"/);
  assert.match(html, /<div class="messages-thread-kicker" data-request-kicker="">Request #9107<\/div>/);
  assert.match(html, /<div class="messages-thread-name line-clamp-2 dev-request-bar-title">Staging demo: a request<\/div><div class="messages-thread-sub" data-request-category="">Homeroom · Project workflows<\/div>/);
  assert.match(html, /<span class="dev-thread-exits" data-thread-exits="">/);
});

test('the discs do what the panel they are in offers: the Workshop\'s own actions, or the top window\'s panel', () => {
  const { act } = EXITS;
  const ws = EXITS;
  const calls = [];
  ws.setWorkshopSideActions({ close: () => calls.push('ws-close'), openFull: () => calls.push('ws-full') });
  const inWorkshop = { currentTarget: { closest: (sel) => (sel === '.dev-ws-side' ? {} : null) } };
  act(inWorkshop, 'expand');
  act(inWorkshop, 'close');
  assert.deepEqual(calls, ['ws-full', 'ws-close']);
  ws.setWorkshopSideActions(null);

  // In the column beside the bot's list: the panel's own document, same
  // origin, asking the top window's controller.
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { documentElement: { classList: { contains: (c) => c === 'in-side-panel' } } };
  globalThis.window = { parent: { UsernodeReact: { sidePanel: { close: () => calls.push('top-close'), expand: () => calls.push('top-expand') } } } };
  try {
    const inColumn = { currentTarget: { closest: () => null } };
    act(inColumn, 'expand');
    act(inColumn, 'close');
  } finally {
    if (had) globalThis.document = prevDoc; else delete globalThis.document;
    globalThis.window = prevWin;
    if (prevWin === undefined) delete globalThis.window;
  }
  assert.deepEqual(calls.slice(2), ['top-expand', 'top-close']);
});

test('the Workshop\'s panel offers the pill its actions while open, and draws a handle on its edge', () => {
  const src = read('frontend/src/features/dev-board/workshop/side-panel.tsx');
  assert.match(src, /setWorkshopSideActions\(\{ close: onClose, openFull \}\);\s+return \(\) => setWorkshopSideActions\(null\);/);
  assert.match(src, /<SideDivider \/>\s+<div className="dev-ws-side-bar">/, 'the handle is the panel\'s first child');
  assert.match(src, /role="separator"[\s\S]{0,80}aria-orientation="vertical"/);
  assert.match(src, /const LIST_W_KEY = 'homeroom:ws-side-list-w';/, 'the width is kept for the next visit');
});

test('the bot column steps its header aside for a request\'s or a change\'s page, never for a decision\'s', () => {
  const src = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(src, /const ownPill = s\.route && \/\\\/dev\\\/\(issues\|changes\|proposals\|sessions\)\\\/\\d\+\/\.test\(s\.route\) \? '' : undefined;/);
  assert.match(src, /data-thread-pill=\{ownPill\}/);
  assert.match(CSS, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel\[data-thread-pill\] > \.side-panel-head \{ display: none; \}/,
    'only under the looks whose page draws the pill: the frame\'s looks keep the column\'s row and its ×');
});

test('app.css: the pill floats over the scroller, the panels draw no sheet, the card starts at its title', () => {
  const at = CSS.indexOf('ONE THREAD, ONE HEADER (18 Nov 2026)');
  assert.ok(at > 0);
  assert.ok(at < CSS.indexOf('/* looks:begin'), 'outside the generated looks section');
  const block = CSS.slice(at);
  assert.match(block, /#dev-topic-thread \.dev-request:has\(\.dev-thread-card\) \.dev-request-bar \{\s+display: block !important;\s+position: absolute;/);
  assert.match(block, /\.dev-request-bar \.messages-thread-header \{\s+pointer-events: auto;[\s\S]{0,200}border-radius: 999px;/);
  assert.match(block, /\.dev-request-scroll \{\s+padding-top: var\(--pill-under\) !important;\s+scroll-padding-top: var\(--pill-under\);/);
  assert.match(block, /\.dev-request:has\(\.dev-thread-card\) \.dev-thread-kicker \{ display: none; \}/);
  assert.match(block, /:is\(\.dev-ws-side, html\.in-side-panel\.side-panel-beside-ai\) \.dev-thread-exits \{ display: inline-flex; \}/,
    'the discs show only in a panel');
  assert.match(block, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) \.dev-ws-side \{\s+background: transparent;\s+box-shadow: none;/);
  assert.match(block, /\.dev-ws-side:has\(\.dev-thread-card\) > \.dev-ws-side-bar \{ display: none; \}/);
});

test('app.css: the Workshop panel covers the list below 1760px only while a plan is open beside the page', () => {
  assert.match(CSS, /@media \(max-width: 1759px\) \{\s+body:has\(\.dev-ws-side-body > #gc-spec-side-panel\.gc-spec-side-panel-open\) #dev-workshop:has\(> \.dev-ws\[data-ws-side-open\]\) \{ margin-inline-start: 0; max-width: none; \}/);
  assert.doesNotMatch(CSS, /@media \(max-width: 1759px\) \{\s+#dev-workshop:has/, 'not whenever the window is under 1760px');
});

test('app.css: the halves layout draws its edge only while the detail is open', () => {
  assert.match(CSS, /\.gc-tab-body:has\(> #gc-spec-side-panel\.gc-spec-side-panel-open\[data-detail="halves"\]\) > #dev-topic-thread,/);
  assert.doesNotMatch(CSS, /\.gc-tab-body:has\(> #gc-spec-side-panel\[data-detail="halves"\]\) > #dev-topic-thread,/);
});

test('the grip shows for a pointer that moved onto the line, never one the line arrived under, and at rest on touch', () => {
  assert.match(CSS, /@media \(hover: hover\) \{\s+:is\(\.split-handle\[data-armed\], \.side-panel-divider\):hover::before \{ opacity: \.5; \}/);
  assert.match(CSS, /@media \(pointer: coarse\) \{\s+:is\(\.split-handle, \.side-panel-divider\)::before \{ opacity: \.5; \}/);
  const { armOnMove } = loadTsx('frontend/src/lib/split-drag.ts');
  const listeners = {};
  const attrs = new Set();
  const el = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t) => { delete listeners[t]; },
    setAttribute: (n) => attrs.add(n),
    removeAttribute: (n) => attrs.delete(n),
  };
  const off = armOnMove(el);
  listeners.pointermove({ movementX: 0, movementY: 0 });
  assert.equal(attrs.has('data-armed'), false, 'the browser\'s own re-hover after a layout reports no movement');
  listeners.pointermove({ movementX: 3, movementY: 0 });
  assert.equal(attrs.has('data-armed'), true);
  listeners.pointerleave();
  assert.equal(attrs.has('data-armed'), false);
  off();
  assert.deepEqual(Object.keys(listeners), []);
});

test('a drag moves the line from the width the column had, towards whichever side the column is on', () => {
  const lib = loadTsx('frontend/src/lib/split-drag.ts');
  const listeners = {};
  const classes = new Set();
  const prevDoc = globalThis.document;
  globalThis.document = { documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, dir: 'ltr', getAttribute: () => 'ltr' } };
  try {
    const el = { addEventListener: (t, fn) => { listeners[t] = fn; }, removeEventListener: (t) => { delete listeners[t]; }, setPointerCapture() {} };
    const widths = [];
    let done = 0;
    lib.startSplitDrag({ button: 0, clientX: 500, pointerId: 1, currentTarget: el, preventDefault() {} },
      { start: () => 300, apply: (px) => widths.push(px), done: () => { done += 1; } });
    assert.ok(classes.has('side-panel-resizing'), 'held: frames stand aside, nothing selects');
    listeners.pointermove({ clientX: 540 });
    listeners.pointerup();
    assert.deepEqual(widths, [340]);
    assert.equal(done, 1);
    assert.ok(!classes.has('side-panel-resizing'));
    // The timeline is on the far side of its line: moving towards it widens it.
    lib.startSplitDrag({ button: 0, clientX: 500, pointerId: 1, currentTarget: el, preventDefault() {} },
      { start: () => 332, apply: (px) => widths.push(px), done: () => {}, trailing: true });
    listeners.pointermove({ clientX: 460 });
    listeners.pointerup();
    assert.equal(widths.at(-1), 372);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
});
