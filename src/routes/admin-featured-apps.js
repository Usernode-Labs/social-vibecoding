'use strict';

// Featured apps: the admin-curated list the signed-out landing's Featured and
// every user's "Find more apps" row read (`featured_apps`), and the directory
// review an app needs before it can be on it. These are the routes Admin >
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
                a.featured_illustration, a.main_sha, a.last_deploy_at, a.directory_review_status,
                a.directory_reviewed_at, a.directory_reviewed_sha
           FROM featured_apps fa
           JOIN apps a ON a.id = fa.app_id
          WHERE NOT a.self_hosted
          ORDER BY fa.sort_order ASC, a.name ASC`
      );
      const { rows: available } = await pool.query(
        `SELECT a.slug, a.name, a.status, a.icon_emoji, a.icon_image_id,
                a.featured_illustration, a.main_sha, a.last_deploy_at, a.directory_review_status,
                a.directory_reviewed_at, a.directory_reviewed_sha
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
        main_sha: r.main_sha || null,
        last_deploy_at: r.last_deploy_at || null,
        directory_review_status: r.directory_review_status || 'unreviewed',
        directory: discoveryCuration.describe(r),
      });
      res.json({ featured: featured.map(shape), available: available.map(shape) });
    } catch (err) {
      log.error('admin', 'Read featured apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Review the exact version the admin opened. The row lock and deployment
  // snapshot check prevent a deploy during review from certifying untested
  // code. This never launches a probe or changes app access/visibility.
  router.put('/api/admin/apps/:slug/directory-review', requireAdminWrite, async (req, res) => {
    const { status, confirmWorking, mainSha, lastDeployAt } = req.body || {};
    if (!discoveryCuration.REVIEW_STATES.has(status)) {
      return res.status(400).json({ error: 'Choose unreviewed, working, demo, or broken.' });
    }
    if (status === 'working' && confirmWorking !== true) {
      return res.status(400).json({ error: 'Confirm that you tested the app’s main flow before marking it working.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, self_hosted, status, main_sha, last_deploy_at, icon_emoji, icon_image_id
           FROM apps WHERE slug = $1 FOR UPDATE`, [req.params.slug]
      );
      const app = rows[0];
      if (!app || app.self_hosted) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'App not found' });
      }
      if (status === 'working') {
        if (app.status !== 'running' || !app.main_sha || !discoveryCuration.hasIcon(app)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'A reviewed working app must be running, have a deployed version, and have an image or emoji icon.' });
        }
        if (mainSha !== app.main_sha || lastDeployAt === undefined
          || (lastDeployAt !== null && discoveryCuration.timestamp(lastDeployAt) === null)
          || discoveryCuration.timestamp(lastDeployAt) !== discoveryCuration.timestamp(app.last_deploy_at)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'The app changed while you were reviewing it. Refresh and test the current version.' });
        }
      }
      await client.query(
        `UPDATE apps SET directory_review_status = $2::text,
           directory_reviewed_at = CASE WHEN $2::text = 'unreviewed' THEN NULL ELSE NOW() END,
           directory_reviewed_sha = CASE WHEN $2::text = 'unreviewed' THEN NULL ELSE main_sha END
         WHERE id = $1`, [app.id, status]
      );
      await client.query('COMMIT');
      log.info('admin', 'Directory review updated', { by: req.user.username, slug: req.params.slug, status, sha: app.main_sha });
      return res.json({ ok: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      log.error('admin', 'Directory review failed', { message: err.message });
      return res.status(500).json({ error: 'Could not save the directory review.' });
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
          `SELECT id, self_hosted, status, main_sha, last_deploy_at, icon_emoji, icon_image_id,
                  directory_review_status, directory_reviewed_at, directory_reviewed_sha
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
        if (discoveryCuration.describe(rows[0]).tier !== 'ready') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Review ${slug} as working and add an icon before featuring it.` });
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
