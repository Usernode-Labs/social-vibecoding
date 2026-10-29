'use strict';

// Featured apps: the admin-curated list the signed-out landing's Featured and
// every user's "Find more apps" row read (`featured_apps`), and the flag that
// takes an app out of Discover and Featured. These are the routes Admin >
// Featured apps calls, under /api/admin, and the ones a full admin's
// connector session reaches through its own doors
// (routes/featured-admin.js): one handler, two doors, so the console and the
// connector validate, write and answer alike.
//
// Mounted by routes/admin.js after its router-level adminMiddleware, which is
// the gate the read relies on, and by the doors after their own gates.

const { Router } = require('express');
const { requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');
const discoveryCuration = require('../services/discovery-curation');

function featuredAppsAdminRoutes(pool) {
  const router = Router();

  // The admin-curated row under "Find more apps" on every user's home
  // screen. One global ordered list (no per-user targeting); the
  // `featured_apps` table is read by the LEFT JOIN in GET /api/apps, so
  // per-viewer visibility filtering is inherited for free — featuring a
  // view-private app shows it only to people who could already see it.
  //
  // The self-hosted platform row is excluded on both sides: it is hidden
  // from non-admin listings anyway (see GET /api/apps), so featuring it
  // would be a no-op for everyone the row is meant for.
  const FEATURED_MAX = 12;

  // Pure read, with no requireAdminWrite of its own: the router that mounts
  // this decides who reads. Under admin.js's adminMiddleware view-only admins
  // can inspect the list (same stance as /limits and /overview); the
  // connector's door admits full admins only. Returns the current list in
  // display order plus every app still available to add, so the section
  // renders from one round trip.
  router.get('/api/admin/featured-apps', async (_req, res) => {
    try {
      const { rows: featured } = await pool.query(
        `SELECT a.slug, a.name, a.status, a.icon_emoji, a.icon_image_id, fa.sort_order,
                a.featured_illustration, a.directory_review_status, a.directory_reviewed_at
           FROM featured_apps fa
           JOIN apps a ON a.id = fa.app_id
          WHERE NOT a.self_hosted
          ORDER BY fa.sort_order ASC, a.name ASC`
      );
      const { rows: available } = await pool.query(
        `SELECT a.slug, a.name, a.status, a.icon_emoji, a.icon_image_id,
                a.featured_illustration, a.directory_review_status, a.directory_reviewed_at
           FROM apps a
          WHERE NOT a.self_hosted
            AND NOT EXISTS (SELECT 1 FROM featured_apps f WHERE f.app_id = a.id)
          ORDER BY LOWER(a.name) ASC`
      );
      // Server-built icon URL so the client never assembles ids into
      // paths (same rule as the /api/apps serializer).
      const shape = (r) => ({
        slug: r.slug,
        name: r.name,
        status: r.status,
        icon_emoji: r.icon_emoji || null,
        icon_url: r.icon_image_id ? `/app-icons/${r.icon_image_id}` : null,
        sort_order: r.sort_order ?? null,
        // Whether the Discover card has its own art (#2615). Without one it
        // draws the app icon, and the section flags that so the gap is
        // visible. A boolean, not the record: the list has no use for framing.
        has_illustration: !!(r.featured_illustration && r.featured_illustration.url),
        // Where it stands in Discover, its flag included
        // (services/discovery-curation.js).
        directory: discoveryCuration.describe(r),
      });
      res.json({ featured: featured.map(shape), available: available.map(shape) });
    } catch (err) {
      log.error('admin', 'Read featured apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Flag an app, or clear its flag. A flagged app is left out of Discover
  // and Featured everywhere (services/discovery-curation.js), so flagging
  // one also takes it off the featured list, in the same transaction: a
  // flagged app is never featured. Clearing the flag lists it again but
  // does not feature it again. Nothing else about the app changes: not its
  // access, its visibility or its members.
  router.put('/api/admin/apps/:slug/discover-flag', requireAdminWrite, async (req, res) => {
    const { flagged } = req.body || {};
    if (typeof flagged !== 'boolean') {
      return res.status(400).json({ error: 'Send flagged: true to flag the app, or false to clear its flag.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT id, self_hosted FROM apps WHERE slug = $1 FOR UPDATE', [req.params.slug]
      );
      const app = rows[0];
      if (!app || app.self_hosted) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'App not found' });
      }
      await client.query(
        `UPDATE apps SET directory_review_status = $2::text,
           directory_reviewed_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
           directory_reviewed_sha = NULL
         WHERE id = $1`,
        [app.id, flagged ? discoveryCuration.FLAGGED : discoveryCuration.UNFLAGGED, flagged]
      );
      let unfeatured = false;
      if (flagged) {
        const removed = await client.query('DELETE FROM featured_apps WHERE app_id = $1', [app.id]);
        unfeatured = removed.rowCount > 0;
      }
      await client.query('COMMIT');
      log.info('admin', 'Discover flag updated', { by: req.user.username, slug: req.params.slug, flagged, unfeatured });
      return res.json({ ok: true, flagged, unfeatured });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      log.error('admin', 'Discover flag failed', { message: err.message });
      return res.status(500).json({ error: 'Could not save the flag.' });
    } finally {
      client.release();
    }
  });

  // Full rewrite of the list from an ordered slug array — the same idiom
  // as PUT /api/favorites/order in routes/apps.js. A full rewrite (rather
  // than add/remove deltas) is what makes the client's reorder controls
  // trivially correct: the array IS the display order.
  router.put('/api/admin/featured-apps', requireAdminWrite, async (req, res) => {
    const { slugs } = req.body || {};
    if (!Array.isArray(slugs)) {
      return res.status(400).json({ error: 'slugs must be an array' });
    }
    if (slugs.length > FEATURED_MAX) {
      return res.status(400).json({ error: `At most ${FEATURED_MAX} featured apps` });
    }
    if (slugs.some((s) => typeof s !== 'string' || !s.trim())) {
      return res.status(400).json({ error: 'slugs must be non-empty strings' });
    }
    const seen = new Set();
    for (const s of slugs) {
      if (seen.has(s)) return res.status(400).json({ error: `Duplicate slug: ${s}` });
      seen.add(s);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Resolve every slug up front so an unknown / self-hosted one is a
      // 400 naming the offender rather than a silently shorter list.
      const ids = [];
      for (const slug of slugs) {
        const { rows } = await client.query(
          `SELECT id, self_hosted, icon_emoji, icon_image_id, directory_review_status
             FROM apps WHERE slug = $1 FOR UPDATE`,
          [slug]
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Unknown app: ${slug}` });
        }
        if (rows[0].self_hosted) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `The platform app cannot be featured: ${slug}` });
        }
        // An icon for its card, and no flag (services/discovery-curation.js).
        const refusal = discoveryCuration.featureRefusal(rows[0]);
        if (refusal) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `${slug} ${refusal}` });
        }
        ids.push(rows[0].id);
      }
      await client.query('DELETE FROM featured_apps');
      for (let i = 0; i < ids.length; i += 1) {
        await client.query(
          `INSERT INTO featured_apps (app_id, sort_order, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (app_id) DO UPDATE
             SET sort_order = EXCLUDED.sort_order, created_by = EXCLUDED.created_by`,
          [ids[i], i, req.user.id]
        );
      }
      await client.query('COMMIT');
      log.info('admin', 'Featured apps updated', {
        by: req.user.username,
        count: slugs.length,
      });
      res.json({ ok: true, slugs });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      log.error('admin', 'Update featured apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { featuredAppsAdminRoutes };
