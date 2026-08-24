// `#gc-react-bar` — the long-press reaction picker (#25) — after its contents
// became React's.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// The bar had no test either. It was ~380 buttons built by one `innerHTML`
// assignment in public/js/group-chat.js, plus two `classList.toggle` calls
// that reached back into what that assignment had produced. Everything about
// it was implicit; converting the markup is the moment to write down the four
// rules it actually runs on:
//
//   1. Every emoji in both module constants is offered, exactly once, and each
//      button carries the `data-emoji` the delegated click handler reads. That
//      handler is bound ONCE to the host, so a button that stopped carrying
//      the attribute would look right and react to nothing.
//   2. The grid ships collapsed and the `＋` expands it — the class the
//      module used to toggle by hand.
//   3. The pencil is ALWAYS rendered and hidden per row, never conditionally
//      absent, because it is offered on the viewer's own ordinary messages
//      only and the same delegated handler has to find one node either way.
//   4. The module keeps the host: it creates it, points it at a row, measures
//      and places it, and owns its `hidden`. Only the children moved.
//
// Run with: node --test tests/group-chat-reaction-bar.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const BAR = 'frontend/src/features/group-chat/reaction-bar.tsx';
const gcJs = read('public/js/group-chat.js');

// The emoji sets stay module constants and reach the component as props on the
// portal node, so the test reads them from the same place the module does
// rather than restating them.
function constantArray(name) {
  const at = gcJs.indexOf(`${name}: [`);
  assert.ok(at > 0, `located ${name}`);
  const start = gcJs.indexOf('[', at);
  let depth = 0;
  let end = start;
  for (; end < gcJs.length; end += 1) {
    if (gcJs[end] === '[') depth += 1;
    else if (gcJs[end] === ']') { depth -= 1; if (depth === 0) break; }
  }
  // eslint-disable-next-line no-new-func -- a literal array from our own source
  return new Function(`return ${gcJs.slice(start, end + 1)}`)();
}

const QUICK = constantArray('QUICK_REACTIONS');
const GRID = constantArray('GRID_REACTIONS');

const bar = (state) => renderComponent(BAR, 'ReactionBarView', {
  quick: QUICK,
  grid: GRID,
  gridOpen: false,
  editable: false,
  ...state,
});

test('every emoji in both sets is offered, once, with the attribute the handler reads', () => {
  const html = bar();
  assert.ok(QUICK.length >= 6, 'the quick row is a real list');
  assert.ok(GRID.length > 100, 'the grid is the full curated set');

  for (const emoji of QUICK.concat(GRID)) {
    assert.ok(
      html.includes(`data-emoji="${emoji}"`),
      `${emoji} is offered`,
    );
  }
  // One button per entry across both lists, and nothing extra: a stray
  // duplicate would react twice as fast to the same thumb.
  const buttons = html.match(/class="gc-react-bar-emoji"/g) || [];
  assert.equal(buttons.length, QUICK.length + GRID.length);

  // Each button is also its own label — the emoji is the text child, which is
  // what `escapeHtml(e)` was producing in the template this replaces.
  assert.ok(html.includes(`data-emoji="${QUICK[0]}">${QUICK[0]}</button>`));
});

test('the two lists land in their own rows, in order', () => {
  const html = bar();
  const quickAt = html.indexOf('class="gc-react-bar-quick"');
  const gridAt = html.indexOf('class="gc-react-bar-grid');
  assert.ok(quickAt >= 0 && gridAt > quickAt, 'quick row first, grid under it');

  const quickRow = html.slice(quickAt, gridAt);
  for (const emoji of QUICK) {
    assert.ok(quickRow.includes(`data-emoji="${emoji}"`), `${emoji} is in the quick row`);
  }
  // The quick row holds its six and the two controls, and nothing else.
  assert.equal((quickRow.match(/class="gc-react-bar-emoji"/g) || []).length, QUICK.length);

  // Order is the constant's order — the grid is arranged by category so
  // related emoji sit together while scrolling, and a re-sort would undo that.
  const positions = GRID.map((e) => html.indexOf(`data-emoji="${e}"`, gridAt));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `${GRID[i]} follows ${GRID[i - 1]}`);
  }
});

test('the grid ships collapsed, and `＋` is what expands it', () => {
  assert.match(bar({ gridOpen: false }), /class="gc-react-bar-grid hidden"/);
  assert.match(bar({ gridOpen: true }), /class="gc-react-bar-grid"/);
  assert.doesNotMatch(bar({ gridOpen: true }), /gc-react-bar-grid hidden/);

  // The control that flips it, and the label a screen reader gets for it.
  const html = bar();
  assert.match(html, /<button class="gc-react-bar-more" aria-label="More emoji">＋<\/button>/);

  // The module publishes that flip now rather than toggling the class on a
  // node it had built.
  assert.match(gcJs, /closest\('\.gc-react-bar-more'\)[\s\S]{0,160}?_reactBarGridOpen = !GroupChat\._reactBarGridOpen/);
  assert.match(gcJs, /_publishReactBar\(\)/);
});

test('the pencil is always present and hidden per row', () => {
  // Present-but-hidden, not absent: the delegated handler finds it with
  // `closest('.gc-react-bar-edit')`, and it is the same node every open.
  const off = bar({ editable: false });
  assert.match(off, /<button class="gc-react-bar-edit hidden" aria-label="Edit message">/);

  const on = bar({ editable: true });
  assert.match(on, /<button class="gc-react-bar-edit" aria-label="Edit message">/);
  assert.doesNotMatch(on, /gc-react-bar-edit hidden/);
  assert.equal((on.match(/gc-react-bar-edit/g) || []).length, 1);

  // …and `editable` is still "the viewer's own ordinary message", decided
  // where the row's classes are known.
  assert.match(
    gcJs,
    /_reactBarEditable = row\.classList\.contains\('gc-msg'\)\s*&&\s*row\.classList\.contains\('gc-msg-self'\)/,
  );
});

test('an emoji reaches the DOM as text, never as markup', () => {
  // The sets are our own constants, so this is a property of the renderer
  // rather than a live threat — but `escapeHtml(e)` was in the template for a
  // reason, and the conversion should not be the moment it quietly leaves.
  const html = bar({ quick: ['<img src=x onerror=alert(1)>'], grid: [] });
  assert.ok(!html.includes('<img'), 'the tag never lands as markup');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-emoji="&lt;img/);
});

test('the module still owns the host — it just stopped painting inside it', () => {
  const code = gcJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const start = code.indexOf('  _ensureReactionBar() {');
  assert.ok(start > 0, 'located the reaction bar block');
  // The next member after the bar's five — the comment banner between them is
  // gone with the rest of the comments.
  const end = code.indexOf('  _unreadDotHtml(msg) {', start);
  assert.ok(end > start, 'located the end of the reaction bar block');
  const body = code.slice(start, end);

  assert.doesNotMatch(body, /innerHTML/, 'the bar builds no markup');
  assert.doesNotMatch(body, /querySelector/, 'and reaches into none of it');
  assert.match(body, /mountReactionBar\?\.\(bar, \{/, 'it mounts the portal once');
  assert.match(body, /document\.body\.appendChild\(bar\)/, 'it still owns the floating host');
  assert.match(body, /bar\.style\.left = /, 'it still places it');
  assert.match(body, /bar\.classList\.remove\('hidden'\)/, 'it still opens it');
  assert.match(body, /bar\.classList\.add\('hidden'\)/, 'and closes it');
  // Which row the bar is pointed at stays on the host, where `_reactFromBar`
  // and the Edit action read it back.
  assert.match(body, /bar\.dataset\.msgId = String\(id\)/);
  assert.match(body, /parseInt\(bar\.dataset\.msgId \|\| '', 10\)/);
});

test('the publish is flushed, because the open measures the bar it just filled', () => {
  const mount = read('frontend/src/features/group-chat/mount.ts');
  assert.match(mount, /reactionBarStore\.setFlush\(flushSync\)/);
  // The measurement that depends on it: whether the pencil is in the DOM
  // changes the bar's width, and the width decides where it is placed.
  assert.match(gcJs, /_publishReactBar\(\);\s*\n\s*bar\.classList\.remove\('hidden'\);/);
  assert.match(gcJs, /const bw = bar\.offsetWidth \|\| 280;/);
});
