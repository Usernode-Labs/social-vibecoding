// Free-form home-screen layout — where every app tile and widget sits on
// the launcher grid, as a real (column, row) CELL rather than a position in
// a flow. This is the write side of `user_home_layout` (see schema.sql for
// the shape and for why it's a table rather than a JSONB column).
//
// Surface:
//   GET  /api/home-layout
//        → { maxCols, maxRows, breakpoints: [4, 5],
//            layouts: { "4": [item…], "5": [item…] },
//            widgets: [{ key, title, removable, sizes }] }
//        item = { type: 'app', slug, col, row } | { type: 'widget', key, col, row }
//   PUT  /api/home-layout   body { cols: 4|5, items: [item…] }
//        → the same shape, with the written width refreshed from the DB.
//
// ONE LAYOUT PER COLUMN COUNT. `cols` (4 on a phone, 5 above 640px) is the
// breakpoint discriminator: an arrangement with intentional holes has no
// round-trip between the two widths, so each width remembers its own. A
// width with NO rows is not an error and not empty-on-purpose — it means
// "never dragged here", and the CLIENT derives that view (by reflowing the
// other width, or from app_favorites.sort_order flow order) and persists
// only once the user actually drags at that width. That is what makes this
// feature need no backfill: every existing account keeps today's
// arrangement as a derivation until they touch it.
//
// The PUT is a full replace of one (user, cols) set in one transaction — a
// drag rewrites the whole width rather than diffing cells, which is the
// same last-write-wins shape as the board-order route and means a
// half-applied layout is unreachable.
//
// Validation is deliberately strict about geometry and deliberately lax
// about membership: bad coordinates, unknown widget keys and overlapping
// footprints are 400s (a client that can produce them is broken), while an
// app slug the viewer can no longer see is silently DROPPED rather than
// failing the write — losing access to one app must not wedge the whole
// home screen.

'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { homeLayoutLimiter } = require('../middleware/rate-limits');
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The canvas. Kept in step with HomeLayout.MAX_COLS / MAX_ROWS in
// frontend/src/features/home/home-layout.js and with the CHECK constraints on
// user_home_layout — tests/home-layout-api.test.js pins all three.
//
// FIVE IS A LEGACY WIDTH NOW. The grid was `grid-cols-4 sm:grid-cols-5` and
// each viewer had TWO stored arrangements, one per breakpoint; THE UI
// OVERHAUL made it four columns at every width, because a launcher reads as a
// launcher at phone density and the desktop grid is width-capped by
// .home-column rather than stretched — four columns there are four BIGGER
// tiles, not four tiny ones with a gulf beside them.
//
// The '5' bucket stays readable and writable rather than being migrated or
// refused: the client seeds a first four-column visit from a stored
// five-column arrangement (Home.currentLayout), which is what stops the
// change reading as "my home screen was reset", and a browser tab open
// across the deploy can still finish a drag it started.
const MAX_COLS = 5;
const MAX_ROWS = 8;
const BREAKPOINTS = [4, 5];

// Generous over the 40-cell canvas (5 x 8) so a legitimate write never trips
// it; small enough that a hostile client can't post a million rows.
const MAX_ITEMS = 80;

// Every app the viewer may place, as slug → id. The visibility predicate is
// the same one GET /api/apps applies: an app is placeable if it is not
// view-private, or the viewer is a collaborator on it, or they are an admin.
// Written as one query rather than a per-slug lookup so a 40-item layout is
// still a single round trip.
async function visibleAppIds(pool, user) {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug
       FROM apps a
      WHERE a.view_visibility <> 'private'
         OR $2::boolean
         OR EXISTS (SELECT 1 FROM app_collaborators c
                     WHERE c.app_id = a.id AND c.user_id = $1
                       AND c.status = 'member')`,
    [user.id, !!user.isAdmin]
  );
  const bySlug = new Map();
  for (const r of rows) bySlug.set(r.slug, Number(r.id));
  return bySlug;
}

// Read one user's stored layouts, both widths, as the wire shape. Rows whose
// app was deleted simply aren't there — the FK cascade already removed them.
//
// WIDGET ROWS ARE SKIPPED. THE UI OVERHAUL made Discover, Challenges and
// Create app fixed sections rather than items of the launcher canvas, so a
// pre-overhaul arrangement carries cells for blocks that no longer live on
// it. They are dropped on the way OUT rather than migrated away: the rows
// cost nothing where they are, and the client's HomeLayout.repair() has to
// reclaim their cells anyway (an app dragged onto one after this ships would
// otherwise look like it had nowhere to go).
async function readLayouts(pool, userId) {
  const { rows } = await pool.query(
    `SELECT l.cols, l.item_type, l.widget_key, l.grid_col, l.grid_row, a.slug
       FROM user_home_layout l
       LEFT JOIN apps a ON a.id = l.app_id
      WHERE l.user_id = $1
      ORDER BY l.cols, l.grid_row, l.grid_col`,
    [userId]
  );
  const layouts = {};
  for (const cols of BREAKPOINTS) layouts[String(cols)] = [];
  for (const r of rows) {
    const bucket = layouts[String(r.cols)];
    if (!bucket) continue;
    if (r.item_type === 'widget') continue; // retired — see the note above
    if (r.slug) {
      bucket.push({
        type: 'app', slug: r.slug,
        col: Number(r.grid_col), row: Number(r.grid_row),
      });
    }
  }
  return layouts;
}

// Parse + validate a PUT body's items into rows ready to insert.
// Returns { items } on success or { error } with a message for a 400.
//
// `appIds` maps slug → id for everything this viewer can see; a slug missing
// from it is dropped (see the header note).
//
// SO IS A WIDGET ITEM, now that nothing places one. It used to be the
// opposite — an unknown widget key was a 400, because it meant the client and
// the server disagreed about the registry — but a `type: 'widget'` entry
// today means a browser tab that was open across the deploy, and failing that
// viewer's whole layout write is a worse answer than ignoring three cells
// they can no longer see.
//
// Overlap is still checked against the server's own footprint for an app
// tile (1x1, the only footprint left), never against sizes the client claims,
// so the stored layout can't be made self-overlapping by a patched client.
function parseItems(raw, cols, appIds) {
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.length > MAX_ITEMS) return { error: 'too many items' };

  const out = [];
  const seenApps = new Set();
  // Occupancy grid for the overlap check — cols x MAX_ROWS booleans.
  const occupied = new Set();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'invalid item' };
    const col = Number(entry.col);
    const row = Number(entry.row);
    if (!Number.isInteger(col) || col < 0 || col >= cols) {
      return { error: 'col out of range' };
    }
    if (!Number.isInteger(row) || row < 0 || row >= MAX_ROWS) {
      return { error: 'row out of range' };
    }

    let size;
    let record;
    if (entry.type === 'widget') {
      continue; // a stale client — see the header note
    } else if (entry.type === 'app') {
      const slug = String(entry.slug || '');
      const appId = appIds.get(slug);
      // Not visible to this viewer (or gone): drop it silently rather than
      // rejecting the whole layout.
      if (appId == null) continue;
      if (seenApps.has(appId)) return { error: 'duplicate app' };
      seenApps.add(appId);
      size = [1, 1];
      record = { item_type: 'app', app_id: appId, widget_key: null, col, row };
    } else {
      return { error: 'invalid item type' };
    }

    // The footprint must fit on the canvas and touch nothing already placed.
    if (col + size[0] > cols || row + size[1] > MAX_ROWS) {
      return { error: 'item does not fit on the grid' };
    }
    for (let dx = 0; dx < size[0]; dx++) {
      for (let dy = 0; dy < size[1]; dy++) {
        const cell = `${col + dx},${row + dy}`;
        if (occupied.has(cell)) return { error: 'items overlap' };
        occupied.add(cell);
      }
    }
    out.push(record);
  }
  return { items: out };
}

// Staging-only demo layout (?demo=1). user_home_layout is created by this
// change, so it does not exist in the production database a staging clone
// starts from — without this, every PR preview would render the DERIVED
// default (i.e. exactly today's flow arrangement) and the whole feature
// would be invisible to a reviewer signed in as their cloned prod identity.
//
// Deliberately HOLE-BEARING: the gaps in row 0 and row 3 are the feature.
// It also places the two request-time demo tiles from routes/apps.js
// (demoIconApps), which exist only under ?demo=1 and have no DB row — the
// layout is read-only and written nowhere, so referencing them is safe.
// The `create` widget is present unconditionally, matching the rule that it
// is on every home screen regardless of app quota.
// The staging preview arrangement. Its ONE job is to be an arrangement no
// ordering could produce: user_home_layout starts empty on a staging clone,
// so without this every capture would show the DERIVED default — reading
// order, no holes — and free-form placement would be invisible in the
// before/after shots.
//
// APPS ONLY, in TWO ROWS. It used to place the three widgets too, and to
// spend five and six rows doing it; THE UI OVERHAUL moved Discover,
// Challenges and Create app into fixed sections below the grid and capped
// the grid itself at two rows by default (HomeLayout.DEFAULT_ROWS), so a demo
// that filled row 5 would be hidden behind "Show all" — the opposite of a
// preview. Both widths are the same four-column shape now; '5' is kept
// because a stored five-column arrangement is still readable (see
// BREAKPOINTS above), and a capture identity that lands on it should see
// holes rather than a derived default.
function demoLayouts() {
  const arrangement = [
    // Row 0: two tiles at the ends, a two-cell hole between them.
    { type: 'app', slug: 'staging-demo-chess-arena', col: 0, row: 0 },
    { type: 'app', slug: 'staging-demo-pixel-racer', col: 3, row: 0 },
    // Row 1: three tiles with the hole moved, so the gaps read as placement
    // rather than as "the list ran out".
    { type: 'app', slug: 'staging-demo-puzzle-chain', col: 0, row: 1 },
    { type: 'app', slug: 'staging-demo-emoji-icon', col: 2, row: 1 },
    { type: 'app', slug: 'staging-demo-image-icon', col: 3, row: 1 },
    { type: 'app', slug: 'staging-demo-word-garden', col: 1, row: 1 },
  ];
  return {
    '4': arrangement.map((i) => ({ ...i })),
    '5': arrangement.map((i) => ({ ...i })),
  };
}

function homeLayoutRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/home-layout', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const demo = IS_STAGING && req.query.demo === '1';
      const layouts = demo ? demoLayouts() : await readLayouts(pool, req.user.id);
      // `widgets: panelRegistryPublic()` rode along here, so the client laid
      // out against the SAME footprints this route's overlap check validated
      // with. Nothing is placed but app tiles now, and their footprint is 1x1
      // by definition, so there is nothing to agree on — and the registry
      // itself is already on GET /api/home-panels, where the blocks' own
      // renderer reads it.
      return res.json({
        maxCols: MAX_COLS,
        maxRows: MAX_ROWS,
        breakpoints: BREAKPOINTS,
        layouts,
        ...(demo ? { demo: true } : {}),
      });
    } catch (err) {
      log.error('home-layout', 'GET /api/home-layout failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/home-layout', homeLayoutLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const cols = Number(req.body?.cols);
    if (!BREAKPOINTS.includes(cols)) {
      return res.status(400).json({ error: 'Invalid column count' });
    }
    try {
      const appIds = await visibleAppIds(pool, req.user);
      const parsed = parseItems(req.body?.items, cols, appIds);
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      // Full replace of this width, in one transaction so a concurrent read
      // never sees a half-written layout.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize concurrent replaces of the same (user, cols) set. Two
        // racing PUTs — e.g. several freshly-opened tabs each persisting
        // the same layout repair on load — otherwise interleave under READ
        // COMMITTED: the second DELETE cannot see the first's uncommitted
        // inserts, so its own inserts die on idx_user_home_layout_* and a
        // last-write-wins write 500s instead of simply taking turns
        // (session 3193's checks run). Same keyed-lock convention as
        // mobile-push-registration.js.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('home-layout:' || $1 || ':' || $2, 0))",
          [req.user.id, cols]
        );
        await client.query(
          'DELETE FROM user_home_layout WHERE user_id = $1 AND cols = $2',
          [req.user.id, cols]
        );
        for (const it of parsed.items) {
          await client.query(
            `INSERT INTO user_home_layout
               (user_id, cols, item_type, app_id, widget_key, grid_col, grid_row, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [req.user.id, cols, it.item_type, it.app_id, it.widget_key, it.col, it.row]
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      const layouts = await readLayouts(pool, req.user.id);
      return res.json({
        maxCols: MAX_COLS,
        maxRows: MAX_ROWS,
        breakpoints: BREAKPOINTS,
        layouts,
      });
    } catch (err) {
      log.error('home-layout', 'PUT /api/home-layout failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  homeLayoutRoutes,
  // Exported for tests.
  parseItems,
  demoLayouts,
  MAX_COLS,
  MAX_ROWS,
  MAX_ITEMS,
  BREAKPOINTS,
};
