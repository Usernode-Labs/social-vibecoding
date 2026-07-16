// Read / write the manual drag-and-drop ordering of cards WITHIN one person's
// section of the Dev board's PM view ("tasks by assignee"). Sibling of
// board-order.js, but keyed by the case-folded ASSIGNEE (a person) instead of
// a kanban column. The PM view's default order is derived on the client
// (recency); this table is an OVERLAY applied on top of that order (see
// schema.sql `dev_pm_card_order` and `_applyManualOrder` in
// public/js/app-view.js).
//
//   GET  /api/apps/:slug/pm-order
//        → { "<assignee_key>": [{ type, ref }, …], … }
//          the stored order per person, `position` asc.
//   POST /api/apps/:slug/pm-order
//        body { assignee, order: [{ type, ref }, …] }
//        → REPLACES that person's rows with a dense 0..N-1 sequence and
//          returns the refreshed full map, then broadcasts board_order_update
//          (the same event board-order.js uses) so every open board repaints.
//
// Access is collab-level on the app for writes (same gate the feed routes
// use); reads are view-level. Last-write-wins per person: a POST clobbers the
// whole person's order, and the WS fan-out reconciles other clients within a
// second. assignee_key is the lower-cased display name, matching
// topic-attributes.groupKey so it lines up with the rendered PM section.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const attrs = require('../services/topic-attributes');
const { pushBoardOrderUpdate } = require('../services/ws');
const { boardOrderLimiter } = require('../middleware/rate-limits');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// PM sections only ever hold issues + promoted proposals — never governance
// cards, which carry no assignee.
const CARD_TYPES = ['issue', 'proposal'];
// A person can realistically be assigned at most a few dozen cards; cap the
// write well above that so a malformed/hostile payload can't blow up the table.
const MAX_ORDER_LEN = 500;

// Parse + validate an { order: [{ type, ref }] } body into a clean array of
// { card_type, card_ref } rows. Returns null on any malformed entry (so the
// route answers 400) — dedupes by (type, ref), keeping first occurrence.
// Mirrors board-order.js parseOrder, minus the 'gov' type.
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

// Case-fold + validate an assignee display name into its storage key, using
// the SAME rules the assignee attribute uses (trim, ≤64 chars, lower-case
// group key). Returns null when the name is empty or too long — so a reorder
// can never target a key that no rendered section could match.
function normalizeAssigneeKey(raw) {
  const value = attrs.normalizeValue('assignee', raw);
  if (value == null) return null;
  return attrs.groupKey('assignee', value);
}

// Read the stored order for one app, grouped into { <assignee_key>: [...] }.
async function readOrder(pool, appId) {
  const { rows } = await pool.query(
    `SELECT assignee_key, card_type, card_ref
       FROM dev_pm_card_order
      WHERE app_id = $1
      ORDER BY assignee_key, position ASC`,
    [appId]
  );
  const out = {};
  for (const r of rows) {
    if (!out[r.assignee_key]) out[r.assignee_key] = [];
    out[r.assignee_key].push({ type: r.card_type, ref: r.card_ref });
  }
  return out;
}

// Staging demo order (?demo=1): reference the same mock assignees the feed
// mocks emit — issues.js seeds issue 900003's assignee to 'staging-demo-user'
// and votes.js seeds proposal 9000013's the same — so a tester sees a
// visibly NON-default per-person order and can drag to change it. We rank
// ONLY proposal 9000013 under 'staging-demo-user', deliberately leaving that
// person's issue 900003 OUT of the order so it surfaces ABOVE the ranked
// proposal (the "new arrivals / untouched cards sit on top" behaviour, #617)
// and stays reviewable. A no-op outside staging.
function stagingMockPmOrder() {
  return {
    'staging-demo-user': [
      { type: 'proposal', ref: 9000013 },
    ],
  };
}

function pmOrderRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/pm-order', async (req, res) => {
    try {
      // View-level: read-only viewers render the PM view in the saved order;
      // persisting a reorder (POST below) stays collab.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const stored = await readOrder(pool, app.id);
      // Seed a demo order only when the app has no real order yet, so a
      // tester's own drags (persisted to the real table) win on reload.
      if (IS_STAGING && req.query.demo === '1' && Object.keys(stored).length === 0) {
        return res.json(stagingMockPmOrder());
      }
      res.json(stored);
    } catch (err) {
      log.error('pm-order', 'Failed to read PM order', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/pm-order', boardOrderLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });

      const assigneeKey = normalizeAssigneeKey(req.body?.assignee);
      if (assigneeKey == null) {
        return res.status(400).json({ error: 'Invalid assignee' });
      }
      const order = parseOrder(req.body?.order);
      if (order == null) {
        return res.status(400).json({ error: 'Invalid order' });
      }

      // Full-array replace of this person's rows, in one transaction so a
      // reader never sees a half-written section.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM dev_pm_card_order WHERE app_id = $1 AND assignee_key = $2',
          [app.id, assigneeKey]
        );
        for (let i = 0; i < order.length; i++) {
          const { card_type, card_ref } = order[i];
          await client.query(
            `INSERT INTO dev_pm_card_order
               (app_id, assignee_key, card_type, card_ref, position, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [app.id, assigneeKey, card_type, card_ref, i, req.user.id]
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      pushBoardOrderUpdate({ appId: app.id, appSlug: app.slug, pm: true });

      const stored = await readOrder(pool, app.id);
      res.json(stored);
    } catch (err) {
      log.error('pm-order', 'Failed to write PM order', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  pmOrderRoutes,
  parseOrder,
  normalizeAssigneeKey,
  stagingMockPmOrder,
  MAX_ORDER_LEN,
};
