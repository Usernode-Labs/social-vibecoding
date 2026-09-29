// #2345: on a phone the Needs-you rail is laid over the card's right edge, and
// a long title or summary ran under its buttons. Every text block of the item
// keeps the rail's width free; the wide layout, where the rail sits beside the
// card, gives the room back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
const rule = (sel) => {
  const m = css.match(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
  assert.ok(m, sel);
  return m[1];
};

test('the rail lies over the card on a phone, 60px buttons 8px from the edge', () => {
  assert.match(rule('.dev-ws-rail'), /position: absolute; right: 8px;/);
  assert.match(rule('.dev-ws-rail-btn'), /width: 60px;/);
});

test('title, summary, caption and picture all keep the rail\'s 74px free', () => {
  assert.match(rule('.dev-ws-item-title'), /margin: 18px 74px 0 0;/);
  assert.match(rule('.dev-ws-item-summary'), /margin: 10px 74px 0 0;/);
  assert.match(rule('.dev-ws-item-caption'), /padding: 12px 74px 0 0;/);
  assert.match(rule('.dev-ws-media-view'), /margin-right: 74px;/);
});

test('the wide layout, where the rail stands beside the card, gives the room back', () => {
  assert.match(css, /\.dev-ws-item-title \{ font-size: 32px; line-height: 1\.14; margin-right: 0;/);
  assert.match(css, /\.dev-ws-item-summary \{ font-size: 19px; line-height: 1\.45; margin-right: 0;/);
});
