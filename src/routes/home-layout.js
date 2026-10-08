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
    `SELECT l.cols, l.item_type, l.widget_key, l.folder_id, l.grid_col, l.grid_row, a.slug
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
    if (r.item_type === 'folder') {
      // The FK cascade removes a layout row when its folder is deleted, so
      // folder_id is always live here.
      bucket.push({
        type: 'folder', id: Number(r.folder_id),
        col: Number(r.grid_col), row: Number(r.grid_row),
      });
      continue;
    }
    if (r.slug) {
      bucket.push({
        type: 'app', slug: r.slug,
        col: Number(r.grid_col), row: Number(r.grid_row),
      });
    }
  }
  return layouts;
}

// The caller's folders, as the wire shape: one entry per folder, its member
// slugs ordered by position and filtered by the same visibility predicate
// the layout's slugs obey. A folder whose members all lost visibility comes
// back EMPTY rather than absent — the client hides an empty folder itself,
// and its layout row (which stays) needs the id to exist here.
async function readFolders(pool, userId, visible) {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, m.app_id, m.position, a.slug
       FROM user_home_folders f
       LEFT JOIN user_home_folder_apps m ON m.folder_id = f.id
       LEFT JOIN apps a ON a.id = m.app_id
      WHERE f.user_id = $1
      ORDER BY f.id, m.position`,
    [userId]
  );
  const byId = new Map();
  for (const r of rows) {
    let folder = byId.get(Number(r.id));
    if (!folder) {
      folder = { id: Number(r.id), name: String(r.name || ''), apps: [] };
      byId.set(Number(r.id), folder);
    }
    if (r.app_id != null && (!visible || visible.has(Number(r.app_id)))) {
      folder.apps.push(String(r.slug));
    }
  }
  return [...byId.values()];
}

// The caller's folders as two lookup sets for parseItems: which folder ids
// are theirs (an unknown one is dropped like a stale slug) and which app ids
// are inside one (those apps are represented by the folder's tile, so their
// own layout rows are dropped).
async function folderSets(pool, userId) {
  const { rows } = await pool.query(
    `SELECT f.id, m.app_id
       FROM user_home_folders f
       LEFT JOIN user_home_folder_apps m ON m.folder_id = f.id
      WHERE f.user_id = $1`,
    [userId]
  );
  const ids = new Set();
  const inFolder = new Set();
  for (const r of rows) {
    ids.add(Number(r.id));
    if (r.app_id != null) inFolder.add(Number(r.app_id));
  }
  return { ids, inFolder };
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
function parseItems(raw, cols, appIds, folders) {
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.length > MAX_ITEMS) return { error: 'too many items' };

  const folderIds = (folders && folders.ids) || new Set();
  const inFolder = (folders && folders.inFolder) || new Set();
  const out = [];
  const seenApps = new Set();
  const seenFolders = new Set();
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
    } else if (entry.type === 'folder') {
      // The caller's folder at its remembered cell. A folder id that is not
      // the caller's — deleted under another tab, or another user's — is
      // dropped silently, exactly like a stale slug; a duplicate of one
      // already placed is a client bug and a 400.
      const id = Number(entry.id);
      if (!Number.isInteger(id) || !folderIds.has(id)) continue;
      if (seenFolders.has(id)) return { error: 'duplicate folder' };
      seenFolders.add(id);
      size = [1, 1];
      record = { item_type: 'folder', folder_id: id, app_id: null, widget_key: null, col, row };
    } else if (entry.type === 'app') {
      const slug = String(entry.slug || '');
      const appId = appIds.get(slug);
      // Not visible to this viewer (or gone): drop it silently rather than
      // rejecting the whole layout.
      if (appId == null) continue;
      // An app inside one of the caller's folders is represented by the
      // folder's own tile, so its cell row is stale — drop it the same way.
      if (inFolder.has(appId)) continue;
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
    // Row 0: the Games FOLDER at the left end, a tile at the far end, a
    // two-cell hole between them.
    { type: 'folder', id: 1, col: 0, row: 0 },
    { type: 'app', slug: 'staging-demo-pixel-racer', col: 3, row: 0 },
    // Row 1: three tiles with the hole moved, so the gaps read as placement
    // rather than as "the list ran out".
    { type: 'app', slug: 'staging-demo-emoji-icon', col: 2, row: 1 },
    { type: 'app', slug: 'staging-demo-image-icon', col: 3, row: 1 },
    { type: 'app', slug: 'staging-demo-word-garden', col: 1, row: 1 },
  ];
  // One sample folder so a reviewer can see the feature without dragging.
  // Its members are two of the demo tiles, which are therefore NOT also on
  // the grid above — a folder's apps live inside it only.
  const folders = [
    {
      id: 1, name: 'Games',
      apps: ['staging-demo-chess-arena', 'staging-demo-puzzle-chain'],
    },
  ];
  return {
    layouts: {
      '4': arrangement.map((i) => ({ ...i })),
      '5': arrangement.map((i) => ({ ...i })),
    },
    folders: folders.map((f) => ({ ...f, apps: [...f.apps] })),
  };
}

// Generous over real use (nobody has forty folders) and equal to the canvas
// size it guards: a folder is one tile among MAX_ITEMS, so POST refuses a
// hostile client that would flood the table (400 'too many folders').
const MAX_FOLDERS = 40;

// Both widths' locks, ALWAYS taken 4-then-5. A folder write moves rows
// between widths (an app's cell rows are deleted in every width while the
// folder's cell is written to one), so a write that held only one width's
// lock could interleave with that width's PUT.
const FOLDER_LOCKS_SQL = "SELECT pg_advisory_xact_lock("
  + "hashtextextended('home-layout:' || $1 || ':4', 0)), "
  + "pg_advisory_xact_lock(hashtextextended('home-layout:' || $1 || ':5', 0))";

function homeLayoutRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/home-layout', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const demo = IS_STAGING && req.query.demo === '1';
      let layouts;
      let folders;
      if (demo) {
        const d = demoLayouts();
        layouts = d.layouts;
        folders = d.folders;
      } else {
        const visible = await visibleAppIds(pool, req.user);
        const visibleIds = new Set(visible.values());
        layouts = await readLayouts(pool, req.user.id);
        folders = await readFolders(pool, req.user.id, visibleIds);
      }
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
        folders,
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
      const folders = await folderSets(pool, req.user.id);
      const parsed = parseItems(req.body?.items, cols, appIds, folders);
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
               (user_id, cols, item_type, app_id, widget_key, folder_id, grid_col, grid_row, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [req.user.id, cols, it.item_type, it.app_id, it.widget_key, it.folder_id || null, it.col, it.row]
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // The GET shape, so the client adopts layouts and folders in one step.
      const visibleIds = new Set(appIds.values());
      const [layouts, folderList] = await Promise.all([
        readLayouts(pool, req.user.id),
        readFolders(pool, req.user.id, visibleIds),
      ]);
      return res.json({
        maxCols: MAX_COLS,
        maxRows: MAX_ROWS,
        breakpoints: BREAKPOINTS,
        layouts,
        folders: folderList,
      });
    } catch (err) {
      log.error('home-layout', 'PUT /api/home-layout failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Folders ──────────────────────────────────────────────────────────
  //
  // Every route answers with the GET shape, so the client adopts layouts and
  // folders in one step, and every one runs in a transaction under the same
  // per-user advisory locks the PUT uses — both widths, 4 then 5 — because a
  // folder write moves app cells across widths.

  // The GET shape for the caller, shared by every folder route's answer.
  async function readState(user) {
    const visible = await visibleAppIds(pool, user);
    const visibleIds = new Set(visible.values());
    const [layouts, folders] = await Promise.all([
      readLayouts(pool, user.id),
      readFolders(pool, user.id, visibleIds),
    ]);
    return {
      maxCols: MAX_COLS,
      maxRows: MAX_ROWS,
      breakpoints: BREAKPOINTS,
      layouts,
      folders,
    };
  }

  // The caller's folder, or null when the id is not theirs (404, not 403 —
  // another person's folder id is not a thing to know exists).
  async function ownFolder(client, userId, id) {
    const { rows } = await client.query(
      'SELECT id FROM user_home_folders WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return rows.length ? rows[0] : null;
  }

  router.post('/api/home-folders', homeLayoutLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const cols = Number(req.body?.cols);
    const col = Number(req.body?.col);
    const row = Number(req.body?.row);
    if (!BREAKPOINTS.includes(cols)) {
      return res.status(400).json({ error: 'Invalid column count' });
    }
    if (!Number.isInteger(col) || col < 0 || col >= cols
        || !Number.isInteger(row) || row < 0 || row >= MAX_ROWS) {
      return res.status(400).json({ error: 'Invalid cell' });
    }
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.map(String) : [];
    if (slugs.length !== 2 || slugs[0] === slugs[1]) {
      return res.status(400).json({ error: 'Two different apps are needed' });
    }
    try {
      const visible = await visibleAppIds(pool, req.user);
      const targetId = visible.get(slugs[0]);
      const draggedId = visible.get(slugs[1]);
      if (targetId == null || draggedId == null) {
        return res.status(400).json({ error: 'Unknown app' });
      }
      const sets = await folderSets(pool, req.user.id);
      if (sets.ids.size >= MAX_FOLDERS) {
        return res.status(400).json({ error: 'too many folders' });
      }
      if (sets.inFolder.has(targetId) || sets.inFolder.has(draggedId)) {
        return res.status(400).json({ error: 'App is already in a folder' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(FOLDER_LOCKS_SQL, [req.user.id]);
        const { rows } = await client.query(
          `INSERT INTO user_home_folders (user_id, name) VALUES ($1, 'New folder')
           RETURNING id`,
          [req.user.id]
        );
        const folderId = Number(rows[0].id);
        for (const [position, appId] of [[0, targetId], [1, draggedId]]) {
          await client.query(
            `INSERT INTO user_home_folder_apps (folder_id, user_id, app_id, position)
             VALUES ($1, $2, $3, $4)`,
            [folderId, req.user.id, appId, position]
          );
        }
        // The two tiles leave the canvas in EVERY width — their cells are
        // inside the folder now — and the folder takes the cell the client
        // dropped onto, in the width it was dropped at.
        await client.query(
          'DELETE FROM user_home_layout WHERE user_id = $1 AND app_id = ANY($2)',
          [req.user.id, [targetId, draggedId]]
        );
        await client.query(
          `INSERT INTO user_home_layout
             (user_id, cols, item_type, app_id, widget_key, folder_id, grid_col, grid_row, updated_at)
           VALUES ($1, $2, 'folder', NULL, NULL, $3, $4, $5, NOW())`,
          [req.user.id, cols, folderId, col, row]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      return res.status(201).json(await readState(req.user));
    } catch (err) {
      log.error('home-layout', 'POST /api/home-folders failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/home-folders/:id/apps', homeLayoutLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const folderId = Number(req.params.id);
    if (!Number.isInteger(folderId)) return res.status(404).json({ error: 'Not found' });
    const slug = String(req.body?.slug || '');
    try {
      const visible = await visibleAppIds(pool, req.user);
      const appId = visible.get(slug);
      if (appId == null) return res.status(400).json({ error: 'Unknown app' });
      const sets = await folderSets(pool, req.user.id);
      if (sets.inFolder.has(appId)) {
        return res.status(400).json({ error: 'App is already in a folder' });
      }

      const client = await pool.connect();
      let exists = false;
      try {
        await client.query('BEGIN');
        await client.query(FOLDER_LOCKS_SQL, [req.user.id]);
        if (!await ownFolder(client, req.user.id, folderId)) {
          await client.query('ROLLBACK').catch(() => {});
          return res.status(404).json({ error: 'Not found' });
        }
        exists = true;
        const { rows } = await client.query(
          'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM user_home_folder_apps WHERE folder_id = $1',
          [folderId]
        );
        await client.query(
          `INSERT INTO user_home_folder_apps (folder_id, user_id, app_id, position)
           VALUES ($1, $2, $3, $4)`,
          [folderId, req.user.id, appId, Number(rows[0].next)]
        );
        await client.query(
          'DELETE FROM user_home_layout WHERE user_id = $1 AND app_id = $2',
          [req.user.id, appId]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      if (!exists) return res.status(404).json({ error: 'Not found' });
      return res.json(await readState(req.user));
    } catch (err) {
      log.error('home-layout', 'POST /api/home-folders/:id/apps failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/home-folders/:id/apps/:slug', homeLayoutLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const folderId = Number(req.params.id);
    const slug = String(req.params.slug || '');
    if (!Number.isInteger(folderId)) return res.status(404).json({ error: 'Not found' });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(FOLDER_LOCKS_SQL, [req.user.id]);
        if (!await ownFolder(client, req.user.id, folderId)) {
          await client.query('ROLLBACK').catch(() => {});
          return res.status(404).json({ error: 'Not found' });
        }
        const { rowCount } = await client.query(
          'DELETE FROM user_home_folder_apps WHERE folder_id = $1 AND app_id = (SELECT id FROM apps WHERE slug = $2)',
          [folderId, slug]
        );
        // The last app leaving takes the (now empty) folder with it; the
        // FK cascade removes its layout rows in both widths with the folder.
        if (rowCount) {
          await client.query(
            `DELETE FROM user_home_folders f
              WHERE f.id = $1
                AND NOT EXISTS (SELECT 1 FROM user_home_folder_apps m WHERE m.folder_id = f.id)`,
            [folderId]
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      return res.json(await readState(req.user));
    } catch (err) {
      log.error('home-layout', 'DELETE /api/home-folders/:id/apps/:slug failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/home-folders/:id', homeLayoutLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const folderId = Number(req.params.id);
    if (!Number.isInteger(folderId)) return res.status(404).json({ error: 'Not found' });
    // Trimmed; a blank answer is the default name, not a 400 — the client
    // sends whatever the prompt held. Over the cap IS a 400 (a client that
    // can produce it is broken; the schema CHECK agrees).
    let name = String(req.body?.name ?? '').trim();
    if (!name) name = 'New folder';
    if (name.length > 40) return res.status(400).json({ error: 'Name is too long' });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(FOLDER_LOCKS_SQL, [req.user.id]);
        const { rowCount } = await client.query(
          'UPDATE user_home_folders SET name = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2',
          [folderId, req.user.id, name]
        );
        if (!rowCount) {
          await client.query('ROLLBACK').catch(() => {});
          return res.status(404).json({ error: 'Not found' });
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      return res.json(await readState(req.user));
    } catch (err) {
      log.error('home-layout', 'PATCH /api/home-folders/:id failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/home-folders/:id', homeLayoutLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const folderId = Number(req.params.id);
    if (!Number.isInteger(folderId)) return res.status(404).json({ error: 'Not found' });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(FOLDER_LOCKS_SQL, [req.user.id]);
        // Nothing is uninstalled and nothing is lost: the memberships go with
        // the folder, and the client's repair() puts the apps back on the grid
        // at the first free cells, which persists because the stored layout
        // is non-empty.
        const { rowCount } = await client.query(
          'DELETE FROM user_home_folders WHERE id = $1 AND user_id = $2',
          [folderId, req.user.id]
        );
        await client.query('COMMIT');
        if (!rowCount) {
          return res.status(404).json({ error: 'Not found' });
        }
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      return res.json(await readState(req.user));
    } catch (err) {
      log.error('home-layout', 'DELETE /api/home-folders/:id failed', {
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
  MAX_FOLDERS,
  BREAKPOINTS,
};
