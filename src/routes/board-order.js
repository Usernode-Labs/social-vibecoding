// #613: read / write the manual drag-and-drop ordering of cards WITHIN a
// Dev-board kanban column. The board's default order is derived on the
// client (recency / merge-priority); this table is an OVERLAY applied on
// top of that order (see schema.sql `dev_board_card_order` and the
// `_applyManualOrder` helper in public/js/app-view.js).
//
//   GET  /api/apps/:slug/board-order
//        → { issues: [{ type, ref }, …], review: [{ type, ref }, …] }
//        the stored order per supported column, `position` asc.
//   POST /api/apps/:slug/board-order
//        body { column: 'issues'|'review', order: [{ type, ref }, …] }
//        → REPLACES that column's rows with a dense 0..N-1 sequence and
//          returns the refreshed board order (same shape as GET), then
//          broadcasts board_order_update so every open board repaints.
//
// Access is collab-level on the app (same gate the feed routes use) — every
// registered user is a member of every app, so reordering is communal.
// Last-write-wins per column: a POST clobbers the whole column, and the WS
// fan-out reconciles other clients within a second.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const { pushBoardOrderUpdate } = require('../services/ws');
const { boardOrderLimiter } = require('../middleware/rate-limits');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The two columns this feature covers. In progress is a per-viewer composite
// and Done is keyset-paginated, so neither carries a single shared order.
const COLUMNS = ['issues', 'review'];
const CARD_TYPES = ['issue', 'proposal', 'gov'];
// A column can realistically hold at most a few dozen cards; cap the write
// well above that so a malformed/hostile payload can't blow up the table.
const MAX_ORDER_LEN = 500;

// Parse + validate an { order: [{ type, ref }] } body into a clean array of
// { card_type, card_ref } rows. Returns null on any malformed entry (so the
// route answers 400) — dedupes by (type, ref), keeping first occurrence.
function parseOrder(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_ORDER_LEN) return null;
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const type = String(entry.type || '');
    const ref = parseInt(entry.ref, 10);
    if (!CARD_TYPES.includes(type)) return null;
    if (!Number.isInteger(ref) || ref <= 0) return null;
    const key = `${type}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ card_type: type, card_ref: ref });
  }
  return out;
}

// Read the stored order for one app, grouped into { issues: [...], review: [...] }.
async function readOrder(pool, appId) {
  const { rows } = await pool.query(
    `SELECT column_key, card_type, card_ref
       FROM dev_board_card_order
      WHERE app_id = $1
      ORDER BY column_key, position ASC`,
    [appId]
  );
  const out = { issues: [], review: [] };
  for (const r of rows) {
    if (!out[r.column_key]) continue;
    out[r.column_key].push({ type: r.card_type, ref: r.card_ref });
  }
  return out;
}

// Staging demo order (?demo=1): reference the same mock issue numbers /
// proposal ids the feed mocks emit (stagingMockIssues in issues.js,
// stagingMockProposals in votes.js) so a tester sees a visibly NON-default
// order and can drag to change it. Issues column: 900002 ranked above
// 900001; In review: proposal 9000002 ranked first. Unranked cards render
// ABOVE the ranked block (#617) — mock issue 900009 ("Newly filed issue —
// should render on top") is deliberately left out of this order so the
// new-issues-surface-at-the-top behaviour is reviewable. A no-op outside
// staging.
function stagingMockOrder() {
  return {
    issues: [
      { type: 'issue', ref: 900002 },
      { type: 'issue', ref: 900001 },
    ],
    review: [
      { type: 'proposal', ref: 9000002 },
    ],
  };
}

function boardOrderRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/board-order', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const stored = await readOrder(pool, app.id);
      // Seed a demo order only when the app has no real order yet, so a
      // tester's own drags (persisted to the real table) win on reload.
      if (IS_STAGING && req.query.demo === '1'
          && stored.issues.length === 0 && stored.review.length === 0) {
        return res.json(stagingMockOrder());
      }
      res.json(stored);
    } catch (err) {
      log.error('board-order', 'Failed to read board order', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/board-order', boardOrderLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });

      const column = String(req.body?.column || '');
      if (!COLUMNS.includes(column)) {
        return res.status(400).json({ error: 'Invalid column' });
      }
      const order = parseOrder(req.body?.order);
      if (order == null) {
        return res.status(400).json({ error: 'Invalid order' });
      }

      // Full-array replace of this column's rows, in one transaction so a
      // reader never sees a half-written column.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM dev_board_card_order WHERE app_id = $1 AND column_key = $2',
          [app.id, column]
        );
        for (let i = 0; i < order.length; i++) {
          const { card_type, card_ref } = order[i];
          await client.query(
            `INSERT INTO dev_board_card_order
               (app_id, column_key, card_type, card_ref, position, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [app.id, column, card_type, card_ref, i, req.user.id]
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      pushBoardOrderUpdate({ appId: app.id, appSlug: app.slug, column });

      const stored = await readOrder(pool, app.id);
      res.json(stored);
    } catch (err) {
      log.error('board-order', 'Failed to write board order', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { boardOrderRoutes, parseOrder, MAX_ORDER_LEN };
