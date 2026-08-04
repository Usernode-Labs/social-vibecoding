// public/js/home-layout.js — the pure geometry behind free-form home-screen
// placement. Everything here is a plain function over plain data, so it is
// tested directly with no DOM at all.
//
// The contracts this file guards:
//
//   1. HOLES SURVIVE. Nothing re-packs a layout except a breakpoint reflow
//      and the overflow region. A drop leaves every other item where it is.
//   2. The breakpoint boundary agrees with the CSS. The JS lays out against
//      the column count the grid actually renders, or every cell is wrong.
//   3. deriveDefault reproduces today's arrangement — apps in flow order,
//      then the widgets — which is what lets this ship with no backfill.
//   4. The create widget is placed regardless of app quota. Quota decides
//      whether it is TAPPABLE, never whether it exists.
//   5. repair() is total: it drops what is gone, adds what is new, resolves
//      overlaps a registry size change introduced, and never loses an item.
//   6. place() clamps at the edges, swaps two single cells, and refuses a
//      partial overlap rather than half-applying it.
//
// Run with: node --test tests/home-layout-model.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { HomeLayout } = require('../public/js/home-layout.js');

const INDEX = read('public/index.html');
const CSS = read('public/css/app.css');
const SW = read('public/sw.js');
const SCHEMA = read('src/db/schema.sql');

// The registry the server serves, mirroring PANEL_REGISTRY.
const REGISTRY = [
  { key: 'challenges', title: 'Challenges', removable: true, sizes: { 4: [4, 2], 5: [2, 2] } },
  { key: 'discover', title: 'Discover', removable: false, sizes: { 4: [4, 2], 5: [2, 2] } },
  { key: 'create', title: 'Create app', removable: true, sizes: { 4: [1, 1], 5: [1, 1] } },
];
HomeLayout.setRegistry(REGISTRY);

const A = (slug, col, row) => ({ type: 'app', slug, col, row });
const W = (key, col, row) => ({ type: 'widget', key, col, row });
const ids = (layout) => HomeLayout.readingOrder(layout).map(HomeLayout.idOf);

// ── The breakpoint ────────────────────────────────────────────────────

test('the column count matches what the CSS actually renders', () => {
  assert.equal(HomeLayout.columnsForWidth(320), 4);
  assert.equal(HomeLayout.columnsForWidth(639), 4);
  assert.equal(HomeLayout.columnsForWidth(640), 5, 'the boundary is inclusive upward');
  assert.equal(HomeLayout.columnsForWidth(1440), 5);
  assert.equal(HomeLayout.MAX_COLS, 5);
  assert.equal(HomeLayout.MAX_ROWS, 8);

  // The grid renders 4 columns below Tailwind's `sm` and 5 at/above it, and
  // `sm` is 640px — the same number BREAKPOINT_PX carries. A drift here
  // would have the JS placing tiles at a column count the CSS isn't using.
  assert.equal(HomeLayout.BREAKPOINT_PX, 640);
  assert.match(INDEX, /id="app-list"[^>]*\bgrid-cols-4\b[^>]*\bsm:grid-cols-5\b/);
  // ...and never wider than the canvas.
  assert.doesNotMatch(INDEX, /id="app-list"[^>]*grid-cols-[6-9]/);
  // The phone density block keys off the same boundary.
  assert.match(CSS, /@media \(max-width: 639\.98px\)/);
  assert.match(CSS, /@media \(min-width: 640px\)/);
});

test('the module is loaded before its consumers and precached', () => {
  const layout = INDEX.indexOf('/js/home-layout.js');
  const panels = INDEX.indexOf('/js/home-panels.js');
  const home = INDEX.indexOf('/js/home.js"');
  assert.ok(layout > 0 && layout < panels && layout < home,
    'geometry loads before the two modules that lay out against it');
  assert.match(SW, /'\/js\/home-layout\.js'/);
});

// ── Footprints ────────────────────────────────────────────────────────

test('sizeOf reads the registry per column count; apps are always 1x1', () => {
  assert.deepEqual(HomeLayout.sizeOf(A('a', 0, 0), 5), [1, 1]);
  assert.deepEqual(HomeLayout.sizeOf(W('challenges', 0, 0), 5), [2, 2]);
  assert.deepEqual(HomeLayout.sizeOf(W('challenges', 0, 0), 4), [4, 2], 'full width on a phone');
  assert.deepEqual(HomeLayout.sizeOf(W('create', 0, 0), 4), [1, 1]);
  // A widget this client has never heard of degrades to a small tile rather
  // than throwing — a server may ship a new widget before the client knows it.
  assert.deepEqual(HomeLayout.sizeOf(W('from-the-future', 0, 0), 5), [1, 1]);
});

// ── deriveDefault ─────────────────────────────────────────────────────

test('deriveDefault reproduces today’s arrangement: apps, then widgets', () => {
  const layout = HomeLayout.deriveDefault({
    apps: ['a', 'b', 'c'],
    widgets: ['challenges', 'discover', 'create'],
    cols: 5,
  });
  // Apps pack from the top-left in flow order, exactly where they are today.
  assert.deepEqual([layout[0].col, layout[0].row], [0, 0]);
  assert.deepEqual([layout[1].col, layout[1].row], [1, 0]);
  assert.deepEqual([layout[2].col, layout[2].row], [2, 0]);
  // Every widget got a cell, and nothing overlaps.
  assert.equal(layout.length, 6);
  assertNoOverlap(layout, 5);
});

// The regression guard for the old "absent for non-creators" behaviour.
// deriveDefault takes a WIDGET KEY LIST and nothing else — there is no
// quota input it could consult even if someone wanted it to.
test('deriveDefault places the create widget with no notion of quota', () => {
  for (const keys of [['create'], ['challenges', 'discover', 'create']]) {
    const layout = HomeLayout.deriveDefault({ apps: ['a'], widgets: keys, cols: 5 });
    assert.ok(ids(layout).includes('widget:create'), keys.join(','));
  }
  // Matched against code, not comments — the one mention is the note in
  // repair() explaining why quota is deliberately not an input.
  const code = read('public/js/home-layout.js').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /canCreateApps|app_quota/,
    'placement geometry must never read a permission');
});

test('deriveDefault overflows rather than dropping an app', () => {
  // 5 x 8 = 40 cells; 45 apps cannot all be placed.
  const apps = Array.from({ length: 45 }, (_, i) => `app${i}`);
  const layout = HomeLayout.deriveDefault({ apps, widgets: [], cols: 5 });
  assert.equal(layout.length, 45, 'nothing is lost');
  assert.equal(HomeLayout.canvasItems(layout).length, 40, 'the canvas fills');
  assert.equal(HomeLayout.overflowItems(layout).length, 5, 'the rest overflow');
});

// ── reflow ────────────────────────────────────────────────────────────

test('reflow preserves reading order and takes the target’s footprints', () => {
  const wide = [
    A('a', 0, 0), A('b', 4, 0),
    W('discover', 0, 1), W('challenges', 3, 1),
    A('c', 0, 3),
  ];
  const narrow = HomeLayout.reflow(wide, 5, 4);
  // PLACEMENT order is what is preserved — the array order, which is the
  // source's reading order. The RESULT's reading order can differ once a
  // 4-wide widget pushes later items below it, and that is not a defect.
  assert.equal(narrow.map(HomeLayout.idOf).join(','),
    'app:a,app:b,widget:discover,widget:challenges,app:c');
  assertNoOverlap(narrow, 4);
  // A 2-wide widget becomes 4-wide on a phone, so it can only start at 0.
  for (const key of ['discover', 'challenges']) {
    assert.equal(narrow.find((i) => i.key === key).col, 0, key);
  }
  // Holes are NOT preserved — that lossiness is exactly why each width
  // stores its own arrangement instead of one being derived from the other.
  assert.deepEqual([narrow[0].col, narrow[0].row], [0, 0]);
  assert.deepEqual([narrow[1].col, narrow[1].row], [1, 0]);
});

// ── repair ────────────────────────────────────────────────────────────

test('repair drops what is gone and adds what is new', () => {
  const stored = [A('a', 0, 0), A('gone', 1, 0), W('challenges', 3, 0)];
  const { layout, changed } = HomeLayout.repair(stored, 5,
    ['app:a', 'app:brand-new', 'widget:challenges']);
  assert.equal(changed, true);
  const got = ids(layout).sort().join(',');
  assert.equal(got, 'app:a,app:brand-new,widget:challenges');
  assertNoOverlap(layout, 5);
});

test('repair is a no-op on a clean layout — a plain load writes nothing', () => {
  const stored = [A('a', 0, 0), W('challenges', 3, 0), W('create', 4, 4)];
  const { layout, changed } = HomeLayout.repair(stored, 5,
    ['app:a', 'widget:challenges', 'widget:create']);
  assert.equal(changed, false);
  // Every cell held exactly still, holes included.
  assert.deepEqual(layout.map((i) => [i.col, i.row]), [[0, 0], [3, 0], [4, 4]]);
});

test('repair resolves an overlap a registry size change introduced', () => {
  // Two widgets stored side by side at 2 wide; imagine one grew to 4.
  HomeLayout.setRegistry([
    { key: 'challenges', removable: true, sizes: { 4: [4, 2], 5: [4, 2] } },
    { key: 'discover', removable: false, sizes: { 4: [4, 2], 5: [2, 2] } },
  ]);
  const stored = [W('challenges', 0, 0), W('discover', 2, 0)];
  const { layout, changed } = HomeLayout.repair(stored, 5,
    ['widget:challenges', 'widget:discover']);
  assert.equal(changed, true);
  assert.equal(layout.length, 2, 'nothing is dropped to resolve the clash');
  assertNoOverlap(layout, 5);
  // Reading order wins: the item nearer the top-left holds still.
  assert.deepEqual([layout[0].col, layout[0].row], [0, 0]);
  HomeLayout.setRegistry(REGISTRY);
});

// A quota change must not look like "this item disappeared" — that would
// delete the widget from the layout and re-place it somewhere else on the
// way back.
test('repair keeps the create widget for a viewer with no quota', () => {
  const stored = [A('a', 0, 0), W('create', 4, 4)];
  const { layout, changed } = HomeLayout.repair(stored, 5, ['app:a', 'widget:create']);
  assert.equal(changed, false);
  assert.deepEqual(layout.find((i) => i.key === 'create'), W('create', 4, 4));
});

test('repair dedupes and rescues an out-of-bounds cell', () => {
  const stored = [A('a', 0, 0), A('a', 2, 2), W('challenges', 4, 7)];
  const { layout } = HomeLayout.repair(stored, 5, ['app:a', 'widget:challenges']);
  assert.equal(layout.filter((i) => i.slug === 'a').length, 1, 'deduped');
  const ch = layout.find((i) => i.key === 'challenges');
  assert.ok(ch.col + 2 <= 5 && ch.row + 2 <= 8, 'nudged back onto the canvas');
});

// ── place ─────────────────────────────────────────────────────────────

test('place moves an item into a free cell and touches nothing else', () => {
  const before = [A('a', 0, 0), A('b', 4, 0), W('challenges', 0, 2)];
  const after = HomeLayout.place(before, before[0], 2, 3, 5);
  assert.deepEqual([after[0].col, after[0].row], [2, 3]);
  assert.deepEqual([after[1].col, after[1].row], [4, 0], 'b did not move');
  assert.deepEqual([after[2].col, after[2].row], [0, 2], 'the widget did not move');
  // The original array is untouched — the caller decides when to commit.
  assert.deepEqual([before[0].col, before[0].row], [0, 0]);
});

test('place swaps two single cells', () => {
  const before = [A('a', 0, 0), A('b', 3, 2)];
  const after = HomeLayout.place(before, before[0], 3, 2, 5);
  assert.deepEqual([after[0].col, after[0].row], [3, 2]);
  assert.deepEqual([after[1].col, after[1].row], [0, 0]);
});

test('place refuses anything that is not a clean 1x1 swap', () => {
  const layout = [A('a', 0, 0), W('challenges', 2, 0), W('discover', 0, 2)];
  // A widget onto an occupied cell: no meaning-preserving exchange exists
  // between two rectangles, so it springs back rather than half-applying.
  assert.equal(HomeLayout.place(layout, layout[1], 0, 2, 5), null);
  // A 1x1 onto a cell a WIDGET covers is likewise refused.
  assert.equal(HomeLayout.place(layout, layout[0], 2, 0, 5), null);
  // An item that isn't in the layout at all.
  assert.equal(HomeLayout.place(layout, A('ghost', 0, 0), 4, 4, 5), null);
});

test('place clamps at the right and bottom edges instead of refusing', () => {
  const layout = [W('challenges', 0, 0)];
  // A 2x2 dragged past the right edge lands flush against it.
  const right = HomeLayout.place(layout, layout[0], 4, 0, 5);
  assert.deepEqual([right[0].col, right[0].row], [3, 0]);
  const bottom = HomeLayout.place(layout, layout[0], 0, 7, 5);
  assert.deepEqual([bottom[0].col, bottom[0].row], [0, 6]);
  // canPlace is the same rule, so the highlight and the drop agree.
  assert.equal(HomeLayout.canPlace(layout, layout[0], 4, 0, 5), true);
});

// ── Overflow ──────────────────────────────────────────────────────────

test('overflow is dense, separate, and excluded from the wire payload', () => {
  const layout = [A('a', 0, 0), A('x', 0, 8), A('y', 1, 8)];
  assert.equal(HomeLayout.canvasItems(layout).length, 1);
  assert.equal(HomeLayout.overflowItems(layout).length, 2);
  // The server's CHECK rejects row >= 8, and an overflow item has no
  // placement worth remembering — it comes back from the same derivation.
  const wire = HomeLayout.toWire(layout);
  assert.equal(wire.length, 1);
  assert.deepEqual(wire[0], { type: 'app', slug: 'a', col: 0, row: 0 });
  assert.match(SCHEMA, /CONSTRAINT user_home_layout_row CHECK \(grid_row >= 0 AND grid_row < 8\)/);
});

test('toWire emits the shape the route parses', () => {
  const wire = HomeLayout.toWire([W('create', 4, 4), A('a', 0, 0)]);
  // Reading order, and each item carries exactly one identity field.
  assert.deepEqual(wire[0], { type: 'app', slug: 'a', col: 0, row: 0 });
  assert.deepEqual(wire[1], { type: 'widget', key: 'create', col: 4, row: 4 });
});

// ── Removability ──────────────────────────────────────────────────────

test('the registry’s removable flag reaches the geometry layer', () => {
  assert.equal(HomeLayout.isRemovable('discover'), false);
  assert.equal(HomeLayout.isRemovable('challenges'), true);
  assert.equal(HomeLayout.isRemovable('create'), true);
});

test('setRegistry ignores an empty payload rather than blanking footprints', () => {
  HomeLayout.setRegistry(null);
  HomeLayout.setRegistry([]);
  assert.deepEqual(HomeLayout.sizeOf(W('challenges', 0, 0), 5), [2, 2],
    'a failed refresh must not silently resize every widget to 1x1');
});

// Every cell covered by at most one item's footprint.
function assertNoOverlap(layout, cols) {
  const seen = new Set();
  for (const item of layout) {
    if (item.row >= HomeLayout.MAX_ROWS) continue;
    const [w, h] = HomeLayout.sizeOf(item, cols);
    assert.ok(item.col + w <= cols, `${HomeLayout.idOf(item)} fits horizontally`);
    assert.ok(item.row + h <= HomeLayout.MAX_ROWS, `${HomeLayout.idOf(item)} fits vertically`);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        const cell = `${item.col + dx},${item.row + dy}`;
        assert.ok(!seen.has(cell), `${cell} claimed twice`);
        seen.add(cell);
      }
    }
  }
}
