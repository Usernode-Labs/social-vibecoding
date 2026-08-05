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
const { PANEL_KEYS, panelRegistryPublic, widgetSize } = require('./home-panels');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The canvas. Kept in step with HomeLayout.MAX_COLS / MAX_ROWS in
// public/js/home-layout.js and with the CHECK constraints on
// user_home_layout — tests/home-layout-api.test.js pins all three.
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
    if (r.item_type === 'widget') {
      if (!PANEL_KEYS.has(r.widget_key)) continue; // key retired in code
      bucket.push({
        type: 'widget', key: r.widget_key,
        col: Number(r.grid_col), row: Number(r.grid_row),
      });
    } else if (r.slug) {
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
// from it is dropped (see the header note). Widget keys are NOT dropped —
// an unknown one means the client and server disagree about the registry,
// which is a bug worth surfacing.
//
// Overlap is checked against the SERVER's own footprints (widgetSize), never
// against sizes the client claims, so the stored layout can't be made
// self-overlapping by a patched client.
function parseItems(raw, cols, appIds) {
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.length > MAX_ITEMS) return { error: 'too many items' };

  const out = [];
  const seenApps = new Set();
  const seenWidgets = new Set();
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
      const key = String(entry.key || '');
      if (!PANEL_KEYS.has(key)) return { error: 'unknown widget' };
      if (seenWidgets.has(key)) return { error: 'duplicate widget' };
      seenWidgets.add(key);
      size = widgetSize(key, cols);
      record = { item_type: 'widget', app_id: null, widget_key: key, col, row };
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
function demoLayouts() {
  return {
    // Phone: 4 columns, the two full-width widgets stacked with an app row
    // between them, and the create widget alone in a row of its own.
    '4': [
      { type: 'app', slug: 'staging-demo-emoji-icon', col: 0, row: 0 },
      { type: 'app', slug: 'staging-demo-image-icon', col: 3, row: 0 },
      { type: 'widget', key: 'discover', col: 0, row: 1 },
      { type: 'app', slug: 'staging-demo-chess-arena', col: 0, row: 3 },
      { type: 'app', slug: 'staging-demo-pixel-racer', col: 3, row: 3 },
      { type: 'widget', key: 'challenges', col: 0, row: 4 },
      { type: 'widget', key: 'create', col: 3, row: 6 },
    ],
    // Desktop: 5 columns. Chess Arena alone top-left, Pixel Racer alone at
    // the far end of the same row, both widgets side by side under them.
    '5': [
      { type: 'app', slug: 'staging-demo-chess-arena', col: 0, row: 0 },
      { type: 'app', slug: 'staging-demo-pixel-racer', col: 4, row: 0 },
      { type: 'widget', key: 'discover', col: 0, row: 1 },
      { type: 'widget', key: 'challenges', col: 3, row: 1 },
      { type: 'app', slug: 'staging-demo-puzzle-chain', col: 0, row: 3 },
      { type: 'app', slug: 'staging-demo-word-garden', col: 3, row: 3 },
      { type: 'app', slug: 'staging-demo-emoji-icon', col: 0, row: 4 },
      { type: 'app', slug: 'staging-demo-image-icon', col: 1, row: 4 },
      { type: 'widget', key: 'create', col: 4, row: 4 },
    ],
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
      return res.json({
        maxCols: MAX_COLS,
        maxRows: MAX_ROWS,
        breakpoints: BREAKPOINTS,
        widgets: panelRegistryPublic(),
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
        widgets: panelRegistryPublic(),
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
