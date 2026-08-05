// Free-form home-screen grid geometry — the pure, testable half of "put
// apps and widgets anywhere". Everything here is a plain function over plain
// data: no DOM, no fetch, no Home state. The drag handlers in home.js call
// into it and persist the result; tests/home-layout-model.test.js exercises
// it directly.
//
// THE MODEL. A layout is a flat array of items, each occupying a rectangle
// of grid cells:
//     { type: 'app',    slug: 'chess',      col: 0, row: 0 }
//     { type: 'widget', key:  'challenges', col: 3, row: 1 }
// The footprint (w x h) is NOT stored — it is looked up per column count
// from the widget registry the server serves (GET /api/home-layout →
// `widgets`), so a widget can be resized in code without migrating anyone's
// saved cells. `repair()` cleans up any overlap such a change introduces.
//
// HOLES ARE THE POINT. Nothing here re-packs a layout to remove gaps except
// `reflow()` (which crosses breakpoints and cannot preserve them) and the
// overflow region (which is dense by definition). A drop leaves every other
// item exactly where it was.
//
// ONE LAYOUT PER COLUMN COUNT. 4 columns below 640px, 5 at and above it. A
// layout with intentional holes has no round-trip between the two widths, so
// each width remembers its own arrangement; a width with nothing stored is
// DERIVED (reflowed from the other, or packed from flow order) and only
// persisted once the user actually drags there.
'use strict';

const HomeLayout = {
  // The canvas. Mirrors MAX_COLS / MAX_ROWS in src/routes/home-layout.js and
  // the CHECK constraints on user_home_layout.
  MAX_COLS: 5,
  MAX_ROWS: 8,

  // The breakpoint. MUST stay in step with #app-list's
  // `grid-cols-4 sm:grid-cols-5` in index.html — Tailwind's `sm` is 640px,
  // and a mismatch would have the JS laying out against a column count the
  // CSS isn't rendering. tests/home-layout-model.test.js greps both files.
  BREAKPOINT_PX: 640,

  columnsForWidth(w) {
    return Number(w) < HomeLayout.BREAKPOINT_PX ? 4 : 5;
  },

  // Widget footprints, keyed by widget key → { 4: [w,h], 5: [w,h] }. Filled
  // from the server's registry by setRegistry(); the fallback keeps the pure
  // helpers usable (and tests independent of a fetch) before that lands.
  _sizes: Object.create(null),

  // Registry order — also the default PLACEMENT order in deriveDefault().
  _order: [],

  // Keys the server marked non-removable (Discover: the shell's only door to
  // the app directory).
  _fixed: new Set(),

  // Adopt the server's widget registry. Called on every /api/home-layout
  // load; last write wins, and an absent/garbage payload leaves the previous
  // registry alone rather than blanking every footprint mid-session.
  setRegistry(widgets) {
    if (!Array.isArray(widgets) || !widgets.length) return;
    const sizes = Object.create(null);
    const order = [];
    const fixed = new Set();
    for (const w of widgets) {
      if (!w || !w.key) continue;
      const s = w.sizes || {};
      const at = (n) => (Array.isArray(s[n]) && s[n].length === 2
        ? [Number(s[n][0]) || 1, Number(s[n][1]) || 1] : [1, 1]);
      sizes[w.key] = { 4: at(4), 5: at(5) };
      order.push(w.key);
      if (w.removable === false) fixed.add(w.key);
    }
    HomeLayout._sizes = sizes;
    HomeLayout._order = order;
    HomeLayout._fixed = fixed;
  },

  isRemovable(key) {
    return !HomeLayout._fixed.has(key);
  },

  // An item's footprint at this column count. Apps are always 1x1; an
  // unknown widget key falls back to 1x1 rather than throwing, so a server
  // that ships a new widget before the client knows it degrades to a small
  // tile instead of a broken grid.
  sizeOf(item, cols) {
    if (!item || item.type !== 'widget') return [1, 1];
    const entry = HomeLayout._sizes[item.key];
    if (!entry) return [1, 1];
    const size = entry[cols] || entry[5] || [1, 1];
    // Clamp to the canvas: a 4-wide widget must still fit if it is ever read
    // at a narrower column count than it was authored for.
    return [Math.min(size[0], cols), Math.min(size[1], HomeLayout.MAX_ROWS)];
  },

  // Stable identity for an item, used for dedupe and for "is this the same
  // thing I picked up".
  idOf(item) {
    if (!item) return '';
    return item.type === 'widget' ? `widget:${item.key}` : `app:${item.slug}`;
  },

  // ── Occupancy ──────────────────────────────────────────────────────
  //
  // A Set of "col,row" strings. Built fresh per query rather than cached:
  // the layouts are at most ~40 items, and a stale cache during a drag is a
  // far worse bug than the arithmetic is expensive.
  occupancy(layout, cols, exceptId) {
    const taken = new Set();
    for (const item of layout || []) {
      if (exceptId && HomeLayout.idOf(item) === exceptId) continue;
      if (item.row >= HomeLayout.MAX_ROWS) continue; // overflow, off-canvas
      const [w, h] = HomeLayout.sizeOf(item, cols);
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) taken.add(`${item.col + dx},${item.row + dy}`);
      }
    }
    return taken;
  },

  // Does a w x h rectangle at (col,row) fit on the canvas and touch nothing?
  fits(taken, col, row, w, h, cols) {
    if (col < 0 || row < 0) return false;
    if (col + w > cols || row + h > HomeLayout.MAX_ROWS) return false;
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        if (taken.has(`${col + dx},${row + dy}`)) return false;
      }
    }
    return true;
  },

  // First free rectangle in READING ORDER (left-to-right, top-to-bottom).
  // Returns { col, row } or null when the canvas has no room — the caller
  // then puts the item in the overflow region rather than dropping it.
  firstFreeCell(layout, size, cols, exceptId) {
    const taken = HomeLayout.occupancy(layout, cols, exceptId);
    const [w, h] = size;
    for (let row = 0; row <= HomeLayout.MAX_ROWS - h; row++) {
      for (let col = 0; col <= cols - w; col++) {
        if (HomeLayout.fits(taken, col, row, w, h, cols)) return { col, row };
      }
    }
    return null;
  },

  // Reading-order sort: row first, then column. The canonical traversal for
  // everything that has to be deterministic across clients (reflow, repair,
  // overflow packing).
  readingOrder(layout) {
    return (layout || []).slice().sort((a, b) => (
      a.row !== b.row ? a.row - b.row : a.col - b.col
    ));
  },

  // ── Deriving a layout ──────────────────────────────────────────────

  // ── Where the widgets start out ────────────────────────────────────
  //
  // The DEFAULT home screen is designed, not packed: each widget has a cell
  // it belongs in, and the app tiles fill in around them. Zero-indexed, so
  // Challenges is the 1st row / 1st column, Discover the 5th row / 2nd
  // column, Create app the 6th row / 4th column.
  //
  // Only the default. The moment someone drags anything at a width, that
  // width has a stored layout and none of this is consulted again — these
  // cells are the starting arrangement, never a constraint on where things
  // may live.
  WIDGET_HOME_CELLS: {
    challenges: { col: 0, row: 0 },
    discover: { col: 1, row: 4 },
    create: { col: 3, row: 5 },
  },

  // Placement order for the anchored widgets. It matters: Create app's
  // fallback is "the first free row below", which can only be computed once
  // Discover is actually on the board. Any widget WITHOUT an anchor (a
  // future registry entry) is placed after these, at the first free
  // rectangle, in registry order.
  WIDGET_HOME_ORDER: ['challenges', 'discover', 'create'],

  // The arrangement for an account that has never dragged anything: the
  // VISIBLE widgets at their home cells above, then app tiles in flow order
  // packed into whatever is left, in reading order.
  //
  // Widgets go down FIRST, which is the whole point — packing apps first and
  // then slotting widgets into the gaps put them wherever the app count
  // happened to leave room, so two accounts with different numbers of apps
  // got different-looking home screens.
  //
  // "Visible" means "not in the viewer's hidden list" and NOTHING else. In
  // particular the `create` widget is placed for every account including one
  // with no app quota — whether it is tappable is a render-time decision,
  // never a placement one, so a quota change can't re-pack someone's grid.
  deriveDefault({ apps, widgets, cols }) {
    const layout = [];
    const push = (item, spot) => {
      // No room on the canvas → overflow (rows at/after MAX_ROWS), packed
      // densely by overflowItems() at render time.
      layout.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
    };

    // An EMPTY list means "this viewer has hidden every widget" and must be
    // honoured; only an ABSENT one falls back to the registry. Treating the
    // two the same would hand every hidden widget straight back.
    const keys = Array.isArray(widgets) ? widgets : (HomeLayout._order || []);
    const anchored = HomeLayout.WIDGET_HOME_ORDER.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !HomeLayout.WIDGET_HOME_ORDER.includes(k));

    for (const key of anchored) {
      const item = { type: 'widget', key };
      push(item, HomeLayout._homeCellFor(layout, key, HomeLayout.sizeOf(item, cols), cols));
    }
    for (const key of rest) {
      const item = { type: 'widget', key };
      push(item, HomeLayout.firstFreeCell(layout, HomeLayout.sizeOf(item, cols), cols));
    }
    for (const slug of apps || []) {
      push({ type: 'app', slug }, HomeLayout.firstFreeCell(layout, [1, 1], cols));
    }
    return layout;
  },

  // Resolve one widget's home cell against the board so far. Three steps,
  // in order:
  //
  //   1. CLAMP the anchor inside the canvas. At 4 columns Challenges,
  //      Discover and Create app are all full-width, so `cols - w` is 0 and
  //      each is pulled to column 0 — their ROW is the part of the design
  //      that survives the narrow breakpoint, their column can't.
  //   2. If that rectangle is free, take it.
  //   3. Otherwise KEEP THE COLUMN and walk down for the first row that
  //      fits. This is what happens to Create app on a phone: it is
  //      full-width there too, so the clamp pulls it to column 0, where
  //      Discover's (0,4)-(3,5) footprint blocks its row — it slides to the
  //      row below and takes that row on its own.
  //
  // Only if the whole column is blocked does it fall back to the first free
  // rectangle anywhere — overlapping is never an option.
  _homeCellFor(layout, key, size, cols) {
    const anchor = HomeLayout.WIDGET_HOME_CELLS[key];
    if (!anchor) return HomeLayout.firstFreeCell(layout, size, cols);
    const [w, h] = size;
    const col = Math.max(0, Math.min(anchor.col, cols - w));
    const taken = HomeLayout.occupancy(layout, cols);
    for (let row = Math.max(0, anchor.row); row <= HomeLayout.MAX_ROWS - h; row++) {
      if (HomeLayout.fits(taken, col, row, w, h, cols)) return { col, row };
    }
    return HomeLayout.firstFreeCell(layout, size, cols);
  },

  // Order-preserving repack from one column count to another. Reads the
  // source in reading order and places each item at the first free
  // rectangle of the target width, using the TARGET breakpoint's footprints
  // (a widget that is 2 wide on desktop is 4 wide on a phone).
  //
  // Gaps are deliberately NOT preserved: there is no meaningful mapping of a
  // 5-wide arrangement's holes onto a 4-wide grid, and pretending otherwise
  // is what would make one device silently rewrite the other's layout. This
  // lossiness is precisely why each width stores its own arrangement.
  reflow(layout, fromCols, toCols) {
    const out = [];
    for (const item of HomeLayout.readingOrder(layout)) {
      const size = HomeLayout.sizeOf(item, toCols);
      const spot = HomeLayout.firstFreeCell(out, size, toCols);
      out.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
    }
    return out;
  },

  // ── Repair ─────────────────────────────────────────────────────────

  // Reconcile a stored layout against what actually exists right now:
  //   * drop items whose app is gone or whose widget was hidden/retired,
  //   * ADD anything present but unplaced (a newly added app, an un-hidden
  //     widget) at the first free cell,
  //   * resolve overlaps — created by a registry size change or a stale
  //     client — keeping the earlier item in reading order and re-placing
  //     the later one,
  //   * push anything that no longer fits into the overflow region.
  //
  // Returns { layout, changed }. `changed` is what the caller uses to decide
  // whether to persist; a clean load must write nothing.
  //
  // NOTE canCreateApps is deliberately NOT an input. The create widget's
  // enabled state is a render-time concern; treating a quota change as
  // "item no longer present" would delete the widget from the layout and
  // re-add it somewhere else the moment quota came back.
  repair(layout, cols, present) {
    const wanted = new Set(present || []);
    const seen = new Set();
    const out = [];
    let changed = false;

    for (const item of HomeLayout.readingOrder(layout)) {
      const id = HomeLayout.idOf(item);
      if (!wanted.has(id) || seen.has(id)) { changed = true; continue; }
      seen.add(id);
      const size = HomeLayout.sizeOf(item, cols);
      const taken = HomeLayout.occupancy(out, cols);
      const inBounds = item.col >= 0 && item.row >= 0
        && item.col + size[0] <= cols && item.row + size[1] <= HomeLayout.MAX_ROWS;
      if (inBounds && HomeLayout.fits(taken, item.col, item.row, size[0], size[1], cols)) {
        out.push({ ...item });
        continue;
      }
      // Overlapping or out of bounds: re-place it. Reading order means the
      // item that was already there wins, which is the least surprising
      // resolution — the thing nearer the top-left holds still.
      const spot = HomeLayout.firstFreeCell(out, size, cols);
      out.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
      changed = true;
    }

    // Anything present but never placed — a new app, an un-hidden widget.
    for (const id of wanted) {
      if (seen.has(id)) continue;
      const item = id.startsWith('widget:')
        ? { type: 'widget', key: id.slice(7) }
        : { type: 'app', slug: id.slice(4) };
      const size = HomeLayout.sizeOf(item, cols);
      const spot = HomeLayout.firstFreeCell(out, size, cols);
      out.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
      changed = true;
    }

    return { layout: out, changed };
  },

  // ── The drop rule ──────────────────────────────────────────────────

  // Do two rectangles overlap at all?
  _overlaps(a, b) {
    return a.col < b.col + b.w && b.col < a.col + a.w
      && a.row < b.row + b.h && b.row < a.row + a.h;
  },

  // The item's rectangle at this column count.
  _rectOf(item, cols) {
    const [w, h] = HomeLayout.sizeOf(item, cols);
    return { col: item.col, row: item.row, w, h };
  },

  // First free spot for `size` INSIDE `region`, in reading order, or null.
  // Used to prefer the cells the dragged item just vacated when pushing an
  // occupant out of the way — which is what makes a same-size collision read
  // as a straight swap rather than a trip to the top-left corner.
  _fitWithin(region, size, taken, cols) {
    const [w, h] = size;
    for (let row = region.row; row <= region.row + region.h - h; row++) {
      for (let col = region.col; col <= region.col + region.w - w; col++) {
        if (HomeLayout.fits(taken, col, row, w, h, cols)) return { col, row };
      }
    }
    return null;
  },

  // Can `item` land with its top-left at (col,row)? Clamped first, so a drag
  // toward an edge reports the nudged-inward position rather than "no".
  //
  // Essentially everything on the canvas is a legal target now: an occupied
  // one DISPLACES its occupants rather than refusing the drop (see place).
  // That is what lets the drag overlay tint every cell the finger crosses,
  // and it is why this is a thin wrapper rather than its own predicate — the
  // highlight the user sees and the drop that commits must be the same
  // decision, or the grid lies about where a release will land.
  canPlace(layout, item, col, row, cols) {
    return HomeLayout.place(layout, item, col, row, cols) !== null;
  },

  // Apply a drop. Returns a NEW layout array, or null only when the item
  // isn't in the layout at all (nothing to move).
  //
  // DISPLACEMENT, not swap-or-refuse. Whatever sits in the target rectangle
  // is pushed out of the way; the dragged item takes the spot. Each displaced
  // occupant goes, in reading order:
  //
  //   1. into the cells the dragged item just VACATED, if its own footprint
  //      fits there — so two 1x1s exchange places, and two same-size widgets
  //      exchange places, which is the least surprising outcome and matches
  //      what a home screen does;
  //   2. otherwise the first free rectangle in reading order;
  //   3. otherwise the overflow region below the canvas, which is never a
  //      dropped tile.
  //
  // What it deliberately does NOT do is re-pack the grid. Only items whose
  // footprint actually intersects the target move at all — every other item,
  // and every intentional hole, is left exactly as it was. That is the whole
  // difference between this and the flow reorder it replaced.
  //
  // The dragged item's own footprint is excluded from the occupancy test, so
  // a widget may be dropped at ANY position overlapping where it already is
  // (nudged one cell over, say) — the common case for a 2x2 block, and one
  // that a naive "target must be empty" rule rejects outright.
  place(layout, item, col, row, cols) {
    const id = HomeLayout.idOf(item);
    const [w, h] = HomeLayout.sizeOf(item, cols);
    const c = Math.max(0, Math.min(Number(col), cols - w));
    const r = Math.max(0, Math.min(Number(row), HomeLayout.MAX_ROWS - h));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null;

    const current = (layout || []).find((it) => HomeLayout.idOf(it) === id);
    if (!current) return null;

    const vacated = HomeLayout._rectOf(current, cols);
    const target = { col: c, row: r, w, h };
    const others = (layout || []).filter((it) => HomeLayout.idOf(it) !== id);

    // Only what the target rectangle actually touches is disturbed. Overflow
    // items are off-canvas and can never be in the way.
    const displaced = HomeLayout.readingOrder(others.filter((it) => (
      it.row < HomeLayout.MAX_ROWS && HomeLayout._overlaps(HomeLayout._rectOf(it, cols), target)
    )));
    const displacedIds = new Set(displaced.map(HomeLayout.idOf));

    // Resolve each displaced occupant against a working set that already
    // holds the dragged item at its new spot, so nothing lands under it.
    // Untouched items keep their exact cells — holes included.
    const settled = others.filter((it) => !displacedIds.has(HomeLayout.idOf(it)));
    settled.push({ ...current, col: c, row: r });
    const moves = new Map([[id, { col: c, row: r }]]);

    for (const d of displaced) {
      const size = HomeLayout.sizeOf(d, cols);
      const taken = HomeLayout.occupancy(settled, cols);
      const spot = HomeLayout._fitWithin(vacated, size, taken, cols)
        || HomeLayout.firstFreeCell(settled, size, cols)
        || { col: 0, row: HomeLayout.MAX_ROWS };
      settled.push({ ...d, col: spot.col, row: spot.row });
      moves.set(HomeLayout.idOf(d), spot);
    }

    // Rebuilt in the INPUT's array order. Nothing downstream depends on it
    // (reflow / repair / toWire all sort by reading order), but a drop that
    // silently reshuffled the array would be a trap for anything that ever
    // does.
    return (layout || []).map((it) => {
      const spot = moves.get(HomeLayout.idOf(it));
      return spot ? { ...it, col: spot.col, row: spot.row } : it;
    });
  },

  // ── Overflow ───────────────────────────────────────────────────────

  // Items parked at/after MAX_ROWS. They render below the canvas in plain
  // flow (dense, no holes) and can be dragged back up whenever space frees.
  // The 8-row cap bounds free PLACEMENT, never how many apps you may have —
  // stranding a tile would be far worse than an extra row.
  overflowItems(layout) {
    return HomeLayout.readingOrder(
      (layout || []).filter((it) => it.row >= HomeLayout.MAX_ROWS)
    );
  },

  // Items on the canvas proper.
  canvasItems(layout) {
    return HomeLayout.readingOrder(
      (layout || []).filter((it) => it.row < HomeLayout.MAX_ROWS)
    );
  },

  // The wire shape for PUT /api/home-layout: canvas items only (the server's
  // CHECK constraint rejects row >= MAX_ROWS, and an overflow item has no
  // placement worth remembering — it comes back from the same derivation
  // next load).
  toWire(layout) {
    return HomeLayout.canvasItems(layout).map((it) => (
      it.type === 'widget'
        ? { type: 'widget', key: it.key, col: it.col, row: it.row }
        : { type: 'app', slug: it.slug, col: it.col, row: it.row }
    ));
  },
};

// Browser global (classic script, like its neighbours) + CommonJS for tests.
if (typeof window !== 'undefined') window.HomeLayout = HomeLayout;
if (typeof module !== 'undefined' && module.exports) module.exports = { HomeLayout };
