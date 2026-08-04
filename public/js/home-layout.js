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

  // The arrangement for an account that has never dragged anything: app
  // tiles in flow order packed from (0,0), then each VISIBLE widget in
  // registry order at the first free rectangle. That reproduces exactly
  // today's home screen (apps, then the widgets after them), which is what
  // makes this feature need no backfill migration.
  //
  // "Visible" means "not in the viewer's hidden list" and NOTHING else. In
  // particular the `create` widget is placed for every account including one
  // with no app quota — whether it is tappable is a render-time decision,
  // never a placement one, so a quota change can't re-pack someone's grid.
  deriveDefault({ apps, widgets, cols }) {
    const layout = [];
    const push = (item) => {
      const size = HomeLayout.sizeOf(item, cols);
      const spot = HomeLayout.firstFreeCell(layout, size, cols);
      // No room on the canvas → overflow (rows at/after MAX_ROWS), packed
      // densely by overflowItems() at render time.
      layout.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
    };
    for (const slug of apps || []) push({ type: 'app', slug });
    // An EMPTY list means "this viewer has hidden every widget" and must be
    // honoured; only an ABSENT one falls back to the registry. Treating the
    // two the same would hand every hidden widget straight back.
    const keys = Array.isArray(widgets) ? widgets : HomeLayout._order;
    for (const key of keys || []) push({ type: 'widget', key });
    return layout;
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

  // Can `item` land with its top-left at (col,row)? Clamped first, so a drag
  // toward the right or bottom edge reports the nudged-inward position
  // rather than "no". A 1x1 onto an occupied 1x1 is a SWAP and therefore
  // legal; anything else needs its whole footprint free.
  canPlace(layout, item, col, row, cols) {
    return HomeLayout.place(layout, item, col, row, cols) !== null;
  },

  // Apply a drop. Returns a NEW layout array, or null when the drop is
  // illegal (the caller springs the ghost back).
  //
  // Two cases:
  //   * 1x1 onto an occupied 1x1 → swap the two items' cells. This is what
  //     makes a crowded grid rearrangeable without first making room.
  //   * anything else → the whole footprint must be free.
  // Either way the footprint is clamped inside the canvas first, so a widget
  // dragged past the right or bottom edge lands flush against it.
  place(layout, item, col, row, cols) {
    const id = HomeLayout.idOf(item);
    const [w, h] = HomeLayout.sizeOf(item, cols);
    const c = Math.max(0, Math.min(Number(col), cols - w));
    const r = Math.max(0, Math.min(Number(row), HomeLayout.MAX_ROWS - h));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null;

    const current = (layout || []).find((it) => HomeLayout.idOf(it) === id);
    if (!current) return null;

    const taken = HomeLayout.occupancy(layout, cols, id);
    if (HomeLayout.fits(taken, c, r, w, h, cols)) {
      return (layout || []).map((it) => (
        HomeLayout.idOf(it) === id ? { ...it, col: c, row: r } : it
      ));
    }

    // Occupied. A swap is only well-defined between two single cells — two
    // rectangles of different shapes have no meaning-preserving exchange.
    if (w !== 1 || h !== 1) return null;
    const target = (layout || []).find((it) => {
      if (HomeLayout.idOf(it) === id) return false;
      const [tw, th] = HomeLayout.sizeOf(it, cols);
      return tw === 1 && th === 1 && it.col === c && it.row === r;
    });
    if (!target) return null;
    const targetId = HomeLayout.idOf(target);
    return (layout || []).map((it) => {
      const itId = HomeLayout.idOf(it);
      if (itId === id) return { ...it, col: c, row: r };
      if (itId === targetId) return { ...it, col: current.col, row: current.row };
      return it;
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
