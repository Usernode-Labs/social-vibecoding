// #2345: on a phone the Needs-you rail is laid over the card's right edge, and
// a long title or summary ran under its buttons. The reel keeps the rail's
// lane free where the words are, in the caption at the card's foot, and lets
// the picture run under the rail, as a short video's frame does; the wide
// layout, where the rail stands beside the card, gives the room back.
// #5039: a diagram's picture is words too, so it keeps the rail's lane free
// as well, and its caption leaves the overlay and sits below the picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');
const rule = (sel) => {
  const m = css.match(new RegExp(`\\n${sel.replace(/[.[\]()=":]/g, '\\$&')} \\{([^}]*)\\}`));
  assert.ok(m, sel);
  return m[1];
};
const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(css)[1];

test('the rail lies over the card on a phone, 60px buttons 8px from the edge', () => {
  assert.match(rule('.dev-ws-rail'), /position: absolute; right: 8px; bottom: 10px;/);
  assert.match(rule('.dev-ws-rail-btn'), /width: 60px;/);
});

test('the caption keeps the rail\'s 80px free on a phone, bottom-left as on a reel', () => {
  assert.match(rule('.dev-ws-item-caption'), /position: absolute; left: 14px; right: 80px; bottom: 16px;/);
  // The words are all in it, so they keep the lane; screenshots still run
  // under the rail, as a reel's frame does. But a diagram's picture is words
  // too ("7 files", "6 files"), so it keeps the lane free as well (#5039).
  const feed = css.slice(css.indexOf('NEEDS YOU: A FEED OF DECISIONS'), css.indexOf('/* ── The deck at the top, on a wide screen'));
  assert.ok(feed.length > 1000, 'the feed\'s rules are found');
  assert.doesNotMatch(feed, /74px/, 'no text block or picture keeps the old 74px lane of its own');
  assert.doesNotMatch(rule('.dev-ws-media-view'), /margin-right/);
  assert.ok(!/data-ws-head=|railClear/.test(src), 'and nothing measures where the rail starts any more');
});

test('#5039: a diagram keeps the rail\'s lane free, and its caption sits below it', () => {
  // The card's diagram ("What it touches" or the author's) is drawn to the
  // card's edges; on a phone it now stops short of the rail.
  assert.match(rule('.dev-ws-item > .dev-ws-diagram'), /padding: 0 80px 16px 24px;/);
  // Its caption leaves the overlay and sits below the picture, in the flow,
  // still clear of the rail. Open ("more") it keeps the whole-card overlay.
  assert.match(rule('.dev-ws-item:not([data-ws-open]):has(> .dev-ws-diagram) > .dev-ws-item-caption'),
    /position: relative; left: auto; right: auto; bottom: auto;\s*flex: none; margin: 12px 80px 16px 14px;/);
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(wide, /\.dev-ws-item:not\(\[data-ws-open\]\):has\(> \.dev-ws-diagram\) > \.dev-ws-item-caption \{ margin: 12px 18px 20px; \}/,
    'beside the card, the caption needs no rail lane');
});

test('the wide layout, where the rail stands beside the card, gives the room back', () => {
  assert.match(wide, /\.dev-ws-item-caption \{ left: 18px; right: 18px; bottom: 20px;/);
  assert.match(wide, /\.dev-ws-rail \{\n\s*position: relative; right: auto; bottom: auto; z-index: auto;\n\s*flex: 0 0 64px; justify-content: flex-end;/,
    'beside the card, its buttons at the card\'s foot');
});
