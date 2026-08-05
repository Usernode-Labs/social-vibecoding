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
//   3. deriveDefault is a DESIGNED starting arrangement, not a pack: the
//      widgets have fixed home cells and the apps fill in around them, so
//      two accounts with different app counts get the same home screen.
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
  { key: 'create', title: 'Create app', removable: true, sizes: { 4: [4, 1], 5: [1, 1] } },
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
  assert.deepEqual(HomeLayout.sizeOf(W('create', 0, 0), 5), [1, 1], 'one cell on desktop');
  assert.deepEqual(HomeLayout.sizeOf(W('create', 0, 0), 4), [4, 1],
    'a full-width row of its own on a phone');
  // A widget this client has never heard of degrades to a small tile rather
  // than throwing — a server may ship a new widget before the client knows it.
  assert.deepEqual(HomeLayout.sizeOf(W('from-the-future', 0, 0), 5), [1, 1]);
});

// ── deriveDefault ─────────────────────────────────────────────────────

// The designed default. Challenges top-left, Discover on the 5th row in the
// 2nd column, Create app on the 6th row in the 4th column — all zero-indexed
// in the model. Apps fill in around them rather than pushing them about.
const cellOf = (layout, id) => {
  const it = layout.find((x) => HomeLayout.idOf(x) === id);
  return it ? [it.col, it.row] : null;
};

test('deriveDefault puts each widget in its designed home cell', () => {
  const layout = HomeLayout.deriveDefault({
    apps: ['a', 'b', 'c'],
    widgets: ['challenges', 'discover', 'create'],
    cols: 5,
  });
  assert.deepEqual(cellOf(layout, 'widget:challenges'), [0, 0], 'top-left');
  assert.deepEqual(cellOf(layout, 'widget:discover'), [1, 4], '5th row, 2nd column');
  assert.deepEqual(cellOf(layout, 'widget:create'), [3, 5], '6th row, 4th column');
  assert.equal(layout.length, 6, 'and every app is still placed');
  assertNoOverlap(layout, 5);
});

// The cells are the DESIGN, so they must not drift with the app count — the
// old behaviour packed apps first and dropped the widgets into whatever gap
// was left, which meant two accounts with different numbers of apps got
// visibly different home screens.
test('the widget cells do not move as the app count changes', () => {
  for (const n of [0, 1, 7, 20]) {
    const apps = Array.from({ length: n }, (_, i) => `app${i}`);
    const layout = HomeLayout.deriveDefault({
      apps, widgets: ['challenges', 'discover', 'create'], cols: 5,
    });
    assert.deepEqual(cellOf(layout, 'widget:challenges'), [0, 0], `${n} apps`);
    assert.deepEqual(cellOf(layout, 'widget:discover'), [1, 4], `${n} apps`);
    assert.deepEqual(cellOf(layout, 'widget:create'), [3, 5], `${n} apps`);
    assertNoOverlap(layout, 5);
  }
});

test('apps fill in AROUND the widgets, in reading order', () => {
  const layout = HomeLayout.deriveDefault({
    apps: ['a', 'b', 'c', 'd'],
    widgets: ['challenges', 'discover', 'create'],
    cols: 5,
  });
  // Challenges occupies (0,0)-(1,1) at five columns, so the first free cell
  // in reading order is (2,0) — the apps start beside it, not under it.
  assert.deepEqual(cellOf(layout, 'app:a'), [2, 0]);
  assert.deepEqual(cellOf(layout, 'app:b'), [3, 0]);
  assert.deepEqual(cellOf(layout, 'app:c'), [4, 0]);
  assert.deepEqual(cellOf(layout, 'app:d'), [2, 1]);
});

// At four columns all three widgets are full-width, so their COLUMN cannot
// survive — the row is the part of the design that does. Create app's cell
// (3,5) clamps to column 0, which lands inside Discover's (0,4)-(3,5)
// footprint, so it slides to the row below and takes that row on its own.
test('at 4 columns the full-width widgets keep their row and lose their column', () => {
  const layout = HomeLayout.deriveDefault({
    apps: ['a', 'b'],
    widgets: ['challenges', 'discover', 'create'],
    cols: 4,
  });
  assert.deepEqual(cellOf(layout, 'widget:challenges'), [0, 0]);
  assert.deepEqual(cellOf(layout, 'widget:discover'), [0, 4], 'row 4 kept, pulled to column 0');
  assert.deepEqual(cellOf(layout, 'widget:create'), [0, 6],
    'pulled to column 0 and pushed one row past the widget it would have overlapped');
  assert.deepEqual(HomeLayout.sizeOf(W('create', 0, 0), 4), [4, 1],
    'and it is the whole row — four columns wide, one tall');
  assertNoOverlap(layout, 4);
});

// The phone shape is a ROW, not a block: one cell tall, so it never costs a
// second row of the eight the canvas has.
test('the create widget spans a whole phone row and only one row', () => {
  const [w, h] = HomeLayout.sizeOf(W('create', 0, 0), 4);
  assert.equal(w, 4, 'the full 4-column width');
  assert.equal(h, 1);
  // A stored 1x1 cell from before the resize no longer fits at column 3 —
  // repair() is what moves it rather than letting it hang off the canvas.
  const { layout, changed } = HomeLayout.repair(
    [W('create', 3, 5), A('a', 0, 0)], 4, ['widget:create', 'app:a']
  );
  assert.equal(changed, true, 'the size change is a repair, not a silent overlap');
  const create = layout.find((i) => i.key === 'create');
  assert.equal(create.col, 0, 'a full-width row can only start at column 0');
  assert.ok(create.col + w <= 4 && create.row + h <= HomeLayout.MAX_ROWS, 'and it fits');
  assertNoOverlap(layout, 4);
});

// A hidden widget is simply absent; the others stay exactly where they are.
test('hiding a widget does not move the ones that remain', () => {
  const full = HomeLayout.deriveDefault({
    apps: [], widgets: ['challenges', 'discover', 'create'], cols: 5,
  });
  const noChallenges = HomeLayout.deriveDefault({
    apps: [], widgets: ['discover', 'create'], cols: 5,
  });
  assert.equal(cellOf(noChallenges, 'widget:challenges'), null);
  assert.deepEqual(cellOf(noChallenges, 'widget:discover'), cellOf(full, 'widget:discover'));
  assert.deepEqual(cellOf(noChallenges, 'widget:create'), cellOf(full, 'widget:create'));
});

// A widget the client has no home cell for (a future registry entry) is not
// a crash and not an overlap — it lands at the first free rectangle after
// the anchored ones, which is the old behaviour for everything.
test('a widget with no designed cell falls back to the first free rectangle', () => {
  const layout = HomeLayout.deriveDefault({
    apps: [], widgets: ['challenges', 'discover', 'create', 'from-the-future'], cols: 5,
  });
  assert.ok(cellOf(layout, 'widget:from-the-future'), 'it is placed');
  assert.deepEqual(cellOf(layout, 'widget:challenges'), [0, 0], 'and disturbs nothing');
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

// Still a swap — it falls out of displacement preferring the vacated cells.
test('place swaps two single cells', () => {
  const before = [A('a', 0, 0), A('b', 3, 2)];
  const after = HomeLayout.place(before, before[0], 3, 2, 5);
  assert.deepEqual([after[0].col, after[0].row], [3, 2]);
  assert.deepEqual([after[1].col, after[1].row], [0, 0]);
});

// DISPLACEMENT, not refusal. Dropping onto something occupied pushes the
// occupant out of the way — this is the behaviour the flow reorder had and
// the free-form grid initially lost.
test('place displaces the occupant of the target rather than refusing', () => {
  const layout = [A('a', 0, 0), A('b', 2, 2), A('c', 4, 4)];
  const after = HomeLayout.place(layout, layout[0], 2, 2, 5);
  assert.ok(after, 'the drop is legal');
  const at = (id) => {
    const it = after.find((x) => HomeLayout.idOf(x) === id);
    return [it.col, it.row];
  };
  assert.deepEqual(at('app:a'), [2, 2], 'the dragged tile takes the target');
  // The occupant lands in the cells the dragged tile vacated — a swap, which
  // is the least surprising outcome and keeps it near where it was.
  assert.deepEqual(at('app:b'), [0, 0]);
  assert.deepEqual(at('app:c'), [4, 4], 'an untouched tile does not move');
  assert.equal(after.length, 3, 'nothing is lost');
  assertNoOverlap(after, 5);
});

// A WIDGET dropped onto occupied cells displaces every tile it covers — the
// old rule refused this outright, which is what made a crowded grid
// impossible to rearrange without first clearing space by hand.
test('place displaces every item a multi-cell footprint covers', () => {
  const layout = [
    W('challenges', 0, 0),          // 2x2 at (0,0)
    A('a', 3, 3), A('b', 4, 3), A('c', 3, 4), A('d', 4, 4),
    A('far', 0, 7),
  ];
  const after = HomeLayout.place(layout, layout[0], 3, 3, 5);
  assert.ok(after);
  const ch = after.find((i) => i.key === 'challenges');
  assert.deepEqual([ch.col, ch.row], [3, 3]);
  assert.equal(after.length, 6, 'all four displaced tiles survive');
  assertNoOverlap(after, 5);
  // The four tiles it covered went into the 2x2 the widget vacated.
  const moved = ['a', 'b', 'c', 'd'].map((slug) => {
    const it = after.find((x) => x.slug === slug);
    return `${it.col},${it.row}`;
  }).sort().join(' ');
  assert.equal(moved, '0,0 0,1 1,0 1,1');
  // ...and the item nowhere near the target held completely still.
  const far = after.find((i) => i.slug === 'far');
  assert.deepEqual([far.col, far.row], [0, 7]);
});

// The second reported bug: a 2x2 widget nudged one cell over overlaps its OWN
// footprint. Excluding the dragged item from the occupancy test is what makes
// that the common case it should be, rather than an impossible move.
test('place allows a target overlapping the item’s own footprint', () => {
  const layout = [W('challenges', 0, 0), A('keep', 4, 4)];
  for (const [col, row] of [[1, 0], [0, 1], [1, 1]]) {
    const after = HomeLayout.place(layout, layout[0], col, row, 5);
    assert.ok(after, `(${col},${row}) must be reachable`);
    const ch = after.find((i) => i.key === 'challenges');
    assert.deepEqual([ch.col, ch.row], [col, row]);
    assert.equal(after.length, 2);
    assertNoOverlap(after, 5);
  }
  // ...and canPlace agrees, so the overlay tints it.
  assert.equal(HomeLayout.canPlace(layout, layout[0], 1, 1, 5), true);
});

// Displacement must not become a general re-pack: a hole the user left
// somewhere unrelated is still there afterwards.
test('place preserves holes and every untouched item', () => {
  const layout = [A('a', 0, 0), A('b', 4, 0), A('c', 2, 5), A('d', 0, 2)];
  const after = HomeLayout.place(layout, layout[3], 4, 0, 5);
  const at = (slug) => {
    const it = after.find((x) => x.slug === slug);
    return [it.col, it.row];
  };
  assert.deepEqual(at('d'), [4, 0]);
  assert.deepEqual(at('b'), [0, 2], 'displaced into the vacated cell');
  // Everything else is byte-identical, gaps and all.
  assert.deepEqual(at('a'), [0, 0]);
  assert.deepEqual(at('c'), [2, 5]);
  assertNoOverlap(after, 5);
});

// When the vacated region can't take the occupant (different footprint), it
// goes to the first free rectangle in reading order instead of being dropped.
test('place falls back to the first free cell when the vacated spot won’t fit', () => {
  // A 1x1 dragged onto a 2x2 widget: the widget cannot fit in one cell.
  const layout = [A('a', 4, 7), W('challenges', 0, 0)];
  const after = HomeLayout.place(layout, layout[0], 0, 0, 5);
  const a = after.find((i) => i.slug === 'a');
  const ch = after.find((i) => i.key === 'challenges');
  assert.deepEqual([a.col, a.row], [0, 0]);
  assert.ok(ch, 'the widget is re-placed, never dropped');
  assert.ok(!(ch.col === 0 && ch.row === 0));
  assertNoOverlap(after, 5);
});

// The one genuinely illegal drop: an item that isn't in the layout.
test('place refuses only an item that is not in the layout', () => {
  const layout = [A('a', 0, 0)];
  assert.equal(HomeLayout.place(layout, A('ghost', 0, 0), 4, 4, 5), null);
  assert.equal(HomeLayout.canPlace(layout, A('ghost', 0, 0), 4, 4, 5), false);
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
