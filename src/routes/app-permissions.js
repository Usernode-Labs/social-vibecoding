'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appPermissions = require('../services/app-permissions');
const log = require('../services/logger');
const appAccess = require('../services/app-access');

// Grant management for the gated browser capabilities an app frame can be
// delegated (#2219) — geolocation, microphone, camera, display-capture,
// usb, serial, hid, bluetooth, midi. Mounted AFTER authMiddleware: every
// route here is the signed-in user managing their own grants, from the
// shell's permission prompt or the Settings section.
//
// This is the sibling of routes/llm-grants.js and deliberately shaped like
// it, down to keeping revoked rows. The one structural difference is that a
// grant here is per CAPABILITY, so the unit of every call is (app, user,
// capability) rather than (app, user).
//
// ENFORCEMENT DOES NOT LIVE HERE. A capability reaches an app only through
// the `allow` attribute the shell writes on the frame immediately before it
// navigates, and the shell reads the granted set from /api/iframe-token (the
// launch path) or from the bootstrap below. So revoking takes effect on that
// frame's next navigation rather than instantly, which is a property of
// Permissions Policy and not of this cache-free code: the container policy of
// a document already loaded cannot be narrowed. The Settings copy says so.

/**
 * The app's declared capabilities, from the deploy-time manifest snapshot.
 *
 * Re-normalized through the catalogue rather than trusted: the snapshot was
 * written by whatever version of the reader was live at deploy time, and a
 * capability may have left the catalogue since. Returns `[{ capability,
 * reason }]` in catalogue order.
 */
function declaredFor(appRow) {
  const manifest = appRow.manifest_snapshot && typeof appRow.manifest_snapshot === 'object'
    ? appRow.manifest_snapshot
    : {};
  const raw = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const reasons = new Map();
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && typeof entry.capability === 'string'
      && typeof entry.reason === 'string' && entry.reason.trim()) {
      reasons.set(entry.capability, entry.reason.trim().slice(0, 140));
    }
  }
  return appPermissions.normalizeCapabilities(raw).map((capability) => ({
    capability,
    reason: reasons.get(capability) || null,
  }));
}

/**
 * The capabilities this user has actually granted this app, as a plain
 * array of names in catalogue order.
 *
 * Exported because the iframe-token mint calls it: the shell needs the
 * granted set at exactly the moment it is about to navigate the frame, and
 * folding it into the token response keeps app launch at one round trip.
 */
async function grantedCapabilities(pool, appId, userId) {
  const { rows } = await pool.query(
    `SELECT capability FROM app_permission_grants
      WHERE app_id = $1 AND user_id = $2 AND status = 'active'`,
    [appId, userId]
  );
  return appPermissions.normalizeCapabilities(rows.map((r) => r.capability));
}

/**
 * The granted set intersected with what the app still declares.
 *
 * An app that drops a capability from its `dapp.json` must stop receiving
 * it on the next deploy even though the old grant row is still there —
 * otherwise a removed declaration is cosmetic and the manifest stops being
 * the audit surface the whole design rests on. The row survives, so putting
 * the declaration back restores the grant without asking again.
 */
function effectiveCapabilities(declared, granted) {
  const declaredNames = new Set(declared.map((d) => d.capability));
  return granted.filter((name) => declaredNames.has(name));
}

function grantJson(row) {
  const info = appPermissions.capabilityInfo(row.capability);
  return {
    appId: row.app_id,
    appName: row.app_name || null,
    appSlug: row.app_slug || null,
    capability: row.capability,
    // The catalogue's own short name, so Settings renders the same word the
    // prompt used rather than a second copy that drifts from it.
    label: info ? info.label : row.capability,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
  };
}

// Request-time demo injection for staging previews, the same device
// routes/llm-grants.js uses and for the same reason: app_permission_grants
// is staging:private, so it is always empty in a clone and a Settings
// screenshot would otherwise show nothing at all. Behind ?demo=1 +
// USERNODE_ENV=staging only; a strict no-op in production.
function demoGrants() {
  return [
    {
      appId: -911, appName: 'Staging demo app A', appSlug: 'staging-demo-app-a',
      capability: 'geolocation', label: 'Location', status: 'active', createdAt: null, revokedAt: null,
    },
    {
      appId: -911, appName: 'Staging demo app A', appSlug: 'staging-demo-app-a',
      capability: 'camera', label: 'Camera', status: 'active', createdAt: null, revokedAt: null,
    },
    {
      appId: -912, appName: 'Staging demo app B', appSlug: 'staging-demo-app-b',
      capability: 'microphone', label: 'Microphone', status: 'revoked', createdAt: null, revokedAt: null,
    },
  ];
}

function appPermissionsRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // The catalogue itself. Static, and the Settings section reads it so the
  // labels a person sees come from one place rather than being retyped in
  // the client.
  router.get('/api/app-permissions/catalogue', (_req, res) => {
    res.json({
      gated: appPermissions.GATED_CAPABILITIES,
      ungated: appPermissions.UNGATED_CAPABILITIES,
    });
  });

  // Every grant the signed-in user holds, for the Settings section.
  router.get('/api/me/permission-grants', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    if (req.query.demo === '1' && process.env.USERNODE_ENV === 'staging') {
      return res.json({ grants: demoGrants(), demo: true });
    }

    try {
      const { rows } = await pool.query(
        `SELECT g.app_id, g.capability, g.status, g.created_at, g.revoked_at,
                a.name AS app_name, a.slug AS app_slug
           FROM app_permission_grants g
           JOIN apps a ON a.id = g.app_id
          WHERE g.user_id = $1
          ORDER BY g.status = 'active' DESC, a.name ASC, g.capability ASC`,
        [req.user.id]
      );
      // Rows whose capability has left the catalogue are dropped rather
      // than rendered: they grant nothing (allowAttribute filters them
      // too), so listing them would offer a revoke button for a permission
      // the app cannot hold.
      res.json({
        grants: rows
          .filter((r) => appPermissions.isGatedCapability(r.capability))
          .map(grantJson),
      });
    } catch (err) {
      log.error('app-permissions', 'List failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Failed to load app permissions' });
    }
  });

  // Prompt bootstrap: what this app declares, what the user has already
  // granted it, and the catalogue entry for the capability being asked
  // about. The shell calls this when the frame requests a capability.
  router.get('/api/apps/:slug/permissions', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    try {
      // #2510: resolve AND gate in one call. This used to be a bare
      // `SELECT ... WHERE slug = $1`, so any signed-in stranger could read a
      // private app's id, name and declared capabilities — and tell from the
      // 404 whether a slug existed at all. `getAppForUser` returns null on
      // denial, which makes a private app answer exactly like a missing one.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view',
        `${appAccess.ACCESS_COLUMNS}, name, manifest_snapshot`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const declared = declaredFor(app);
      const granted = await grantedCapabilities(pool, app.id, req.user.id);
      res.json({
        app: { id: app.id, name: app.name, slug: app.slug },
        declared,
        granted,
        effective: effectiveCapabilities(declared, granted),
        // The prompt's wording rides along so the label and the sentence a
        // person reads come from the catalogue rather than being retyped in
        // the shell, where they would drift the first time one changed.
        catalogue: appPermissions.GATED_CAPABILITIES,
      });
    } catch (err) {
      log.error('app-permissions', 'Bootstrap failed', {
        userId: req.user.id, slug: req.params.slug, err: err.message,
      });
      res.status(500).json({ error: 'Failed to load permission state' });
    }
  });

  // Grant one capability (the prompt's Allow button).
  //
  // The two refusals here are the whole gate, and both are server-side on
  // purpose — the shell checks them too, for a better message, but a frame
  // that talks to this endpoint directly must hit the same wall:
  //   * a capability outside the catalogue is not a permission at all;
  //   * a capability the app did not DECLARE cannot be granted, however
  //     the request got here. That is what stops an app asking for the
  //     camera without the request ever appearing in its own diff.
  router.post('/api/me/permission-grants', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { appSlug, capability } = req.body || {};
    if (!appSlug || typeof appSlug !== 'string') {
      return res.status(400).json({ error: 'appSlug is required' });
    }
    if (!appPermissions.isGatedCapability(capability)) {
      return res.status(400).json({ error: 'Unknown capability', code: 'unknown_capability' });
    }

    try {
      // #2510: gated for the same reason as the bootstrap above, and for
      // one more — this route WRITES. Ungated, a stranger could create a
      // grant against a private app they cannot see. The `not_declared`
      // refusal below is its own oracle too: it distinguishes "this private
      // app declares camera" from "it does not". Both are behind the 404 now.
      const app = await appAccess.getAppForUser(
        pool, appSlug, req.user, 'view',
        `${appAccess.ACCESS_COLUMNS}, name, manifest_snapshot`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const declared = declaredFor(app);
      if (!declared.some((d) => d.capability === capability)) {
        return res.status(400).json({
          error: 'This app has not declared that permission.',
          code: 'not_declared',
        });
      }

      const { rows } = await pool.query(
        `INSERT INTO app_permission_grants (app_id, user_id, capability, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (app_id, user_id, capability) DO UPDATE SET
           status = 'active',
           revoked_at = NULL,
           updated_at = NOW()
         RETURNING app_id, user_id, capability, status, created_at, revoked_at`,
        [app.id, req.user.id, capability]
      );
      log.info('app-permissions', 'Grant created/reactivated', {
        appId: app.id, slug: app.slug, userId: req.user.id, capability,
      });
      res.json({ grant: grantJson({ ...rows[0], app_name: app.name, app_slug: app.slug }) });
    } catch (err) {
      log.error('app-permissions', 'Create failed', {
        userId: req.user.id, appSlug, capability, err: err.message,
      });
      res.status(500).json({ error: 'Failed to save permission' });
    }
  });

  // Revoke one capability. Keeps the row so re-granting is an upsert and
  // the history survives, exactly as llm-grants does.
  router.delete('/api/me/permission-grants/:appId/:capability', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isInteger(appId)) return res.status(400).json({ error: 'Bad app id' });
    const { capability } = req.params;
    if (!appPermissions.isGatedCapability(capability)) {
      return res.status(400).json({ error: 'Unknown capability', code: 'unknown_capability' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE app_permission_grants
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
          WHERE app_id = $1 AND user_id = $2 AND capability = $3
          RETURNING app_id`,
        [appId, req.user.id, capability]
      );
      if (!rows[0]) return res.status(404).json({ error: 'No grant for this app' });
      log.info('app-permissions', 'Grant revoked', { appId, userId: req.user.id, capability });
      res.json({ ok: true });
    } catch (err) {
      log.error('app-permissions', 'Revoke failed', {
        userId: req.user.id, appId, capability, err: err.message,
      });
      res.status(500).json({ error: 'Failed to revoke permission' });
    }
  });

  return router;
}

module.exports = {
  appPermissionsRoutes,
  declaredFor,
  grantedCapabilities,
  effectiveCapabilities,
};
