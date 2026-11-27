// #2345: on a phone the Needs-you rail is laid over the card's right edge.
// (The reel's caption, which kept the rail's lane free, went with the reel.)
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
  assert.match(rule('.dev-ws-rail'), /position: absolute; inset-inline-end: 8px; bottom: 10px;/);
  assert.match(rule('.dev-ws-rail-btn'), /width: 60px;/);
});
