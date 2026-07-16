'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const limits = require('../services/limits');
const { invalidateGrant } = require('../middleware/app-llm-auth');
const log = require('../services/logger');

// Grant management for app LLM access (issue #34). Mounted AFTER
// authMiddleware — every route here is the signed-in user managing
// their own grants (the consent dialog and the Settings "App AI
// permissions" section). The proxy-side enforcement lives in
// middleware/app-llm-auth.js; mutations here invalidate its 10s grant
// cache so revocation is effectively immediate.

const DEFAULT_CAP_CENTS = 100;

// Cap validation shared by create + update: a positive integer no
// larger than the user's own effective daily limit (there is
// deliberately no separate "app cap ceiling" — the user's daily
// budget is the sane upper bound).
async function validateCap(pool, userId, raw) {
  if (raw == null) return { capCents: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: 'dailyCapCents must be a positive integer (cents).' };
  }
  const userLimit = await limits.getEffectiveUserLimitCents(pool, userId);
  if (n > userLimit) {
    return { error: `dailyCapCents cannot exceed your daily limit ($${(userLimit / 100).toFixed(2)}).` };
  }
  return { capCents: n };
}

function grantJson(row) {
  return {
    appId: row.app_id,
    appName: row.app_name || null,
    appSlug: row.app_slug || null,
    status: row.status,
    dailyCapCents: Number(row.daily_cap_cents),
    allowByok: !!row.allow_byok,
    spentTodayCents: row.spent_today_cents != null ? Number(row.spent_today_cents) : 0,
    byokSpentTodayCents: row.byok_spent_today_cents != null ? Number(row.byok_spent_today_cents) : 0,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
  };
}

// Request-time demo injection for staging previews (see the "Staging
// mock data" convention). app_llm_grants / app_llm_usage are
// staging:private — always empty in clones — and grants are keyed to
// the VIEWING user, so boot-time seed rows could never render in the
// Settings modal. Behind ?demo=1 + USERNODE_ENV=staging we fabricate
// two grants without touching the DB; strictly a no-op in production.
function demoGrants() {
  return [
    {
      appId: -901, appName: 'Staging demo app A', appSlug: 'staging-demo-app-a',
      status: 'active', dailyCapCents: 100, allowByok: false,
      spentTodayCents: 37, byokSpentTodayCents: 0,
      createdAt: null, revokedAt: null,
    },
    {
      appId: -902, appName: 'Staging demo app B', appSlug: 'staging-demo-app-b',
      status: 'revoked', dailyCapCents: 250, allowByok: true,
      spentTodayCents: 0, byokSpentTodayCents: 0,
      createdAt: null, revokedAt: null,
    },
  ];
}

function llmGrantsRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // All grants for the signed-in user, joined with app identity and
  // today's per-app spend — the Settings section's data source.
  router.get('/api/me/llm-grants', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    if (req.query.demo === '1' && process.env.USERNODE_ENV === 'staging') {
      return res.json({ grants: demoGrants(), demo: true });
    }

    try {
      const { rows } = await pool.query(
        `SELECT g.app_id, g.user_id, g.status, g.daily_cap_cents, g.allow_byok,
                g.created_at, g.revoked_at,
                a.name AS app_name, a.slug AS app_slug,
                u.total_cost_cents AS spent_today_cents,
                u.byok_cost_cents  AS byok_spent_today_cents
           FROM app_llm_grants g
           JOIN apps a ON a.id = g.app_id
           LEFT JOIN app_llm_usage u
             ON u.app_id = g.app_id AND u.user_id = g.user_id AND u.date = CURRENT_DATE
          WHERE g.user_id = $1
          ORDER BY g.status = 'active' DESC, a.name ASC`,
        [req.user.id]
      );
      res.json({ grants: rows.map(grantJson) });
    } catch (err) {
      log.error('llm-grants', 'List failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Failed to load AI permissions' });
    }
  });

  // Create / re-activate a grant (the consent dialog's Allow button).
  // Upsert keyed on (app, user): re-granting after a revoke reuses the
  // row, keeping usage history.
  router.post('/api/me/llm-grants', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { appSlug, dailyCapCents, allowByok } = req.body || {};
    if (!appSlug || typeof appSlug !== 'string') {
      return res.status(400).json({ error: 'appSlug is required' });
    }

    try {
      const { rows: appRows } = await pool.query(
        'SELECT id, name, slug FROM apps WHERE slug = $1',
        [appSlug]
      );
      const app = appRows[0];
      if (!app) return res.status(404).json({ error: 'App not found' });

      const v = await validateCap(pool, req.user.id, dailyCapCents);
      if (v.error) return res.status(400).json({ error: v.error });
      const capCents = v.capCents ?? DEFAULT_CAP_CENTS;

      const { rows } = await pool.query(
        `INSERT INTO app_llm_grants (app_id, user_id, status, daily_cap_cents, allow_byok)
         VALUES ($1, $2, 'active', $3, $4)
         ON CONFLICT (app_id, user_id) DO UPDATE SET
           status = 'active',
           daily_cap_cents = EXCLUDED.daily_cap_cents,
           allow_byok = EXCLUDED.allow_byok,
           revoked_at = NULL,
           updated_at = NOW()
         RETURNING app_id, user_id, status, daily_cap_cents, allow_byok, created_at, revoked_at`,
        [app.id, req.user.id, capCents, !!allowByok]
      );
      invalidateGrant(app.id, req.user.id);
      log.info('llm-grants', 'Grant created/reactivated', {
        appId: app.id, slug: app.slug, userId: req.user.id, capCents, allowByok: !!allowByok,
      });
      res.json({ grant: grantJson({ ...rows[0], app_name: app.name, app_slug: app.slug }) });
    } catch (err) {
      log.error('llm-grants', 'Create failed', { userId: req.user.id, appSlug, err: err.message });
      res.status(500).json({ error: 'Failed to save permission' });
    }
  });

  // Edit cap / BYOK opt-in from Settings.
  router.patch('/api/me/llm-grants/:appId', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isInteger(appId)) return res.status(400).json({ error: 'Bad app id' });
    const { dailyCapCents, allowByok } = req.body || {};

    try {
      const v = await validateCap(pool, req.user.id, dailyCapCents);
      if (v.error) return res.status(400).json({ error: v.error });

      const sets = ['updated_at = NOW()'];
      const params = [appId, req.user.id];
      if (v.capCents != null) {
        params.push(v.capCents);
        sets.push(`daily_cap_cents = $${params.length}`);
      }
      if (typeof allowByok === 'boolean') {
        params.push(allowByok);
        sets.push(`allow_byok = $${params.length}`);
      }
      const { rows } = await pool.query(
        `UPDATE app_llm_grants SET ${sets.join(', ')}
          WHERE app_id = $1 AND user_id = $2
          RETURNING app_id, user_id, status, daily_cap_cents, allow_byok, created_at, revoked_at`,
        params
      );
      if (!rows[0]) return res.status(404).json({ error: 'No grant for this app' });
      invalidateGrant(appId, req.user.id);
      res.json({ grant: grantJson(rows[0]) });
    } catch (err) {
      log.error('llm-grants', 'Update failed', { userId: req.user.id, appId, err: err.message });
      res.status(500).json({ error: 'Failed to update permission' });
    }
  });

  // Revoke. Keeps the row (usage history, easy re-grant) — the proxy
  // requires status='active' and its cache is invalidated here, so
  // the app's next AI call fails with grant_required immediately.
  router.delete('/api/me/llm-grants/:appId', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isInteger(appId)) return res.status(400).json({ error: 'Bad app id' });

    try {
      const { rows } = await pool.query(
        `UPDATE app_llm_grants SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
          WHERE app_id = $1 AND user_id = $2
          RETURNING app_id`,
        [appId, req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'No grant for this app' });
      invalidateGrant(appId, req.user.id);
      log.info('llm-grants', 'Grant revoked', { appId, userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('llm-grants', 'Revoke failed', { userId: req.user.id, appId, err: err.message });
      res.status(500).json({ error: 'Failed to revoke permission' });
    }
  });

  // Consent-dialog bootstrap: the current user's grant state for one
  // app plus everything the dialog needs to render — the manifest's
  // llm block (purpose + sanitized suggested cap), the default, the
  // upper bound, and whether the user has a BYOK key on file (gates
  // the spillover checkbox).
  router.get('/api/apps/:slug/llm-grant', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const { rows: appRows } = await pool.query(
        'SELECT id, name, slug, manifest_snapshot FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      const app = appRows[0];
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Today's spend rides along (issue #655) so the shell can answer
      // the bridge's read-only usage query from this same bootstrap.
      const { rows: grantRows } = await pool.query(
        `SELECT g.app_id, g.user_id, g.status, g.daily_cap_cents, g.allow_byok,
                g.created_at, g.revoked_at,
                u.total_cost_cents AS spent_today_cents,
                u.byok_cost_cents  AS byok_spent_today_cents
           FROM app_llm_grants g
           LEFT JOIN app_llm_usage u
             ON u.app_id = g.app_id AND u.user_id = g.user_id AND u.date = CURRENT_DATE
          WHERE g.app_id = $1 AND g.user_id = $2`,
        [app.id, req.user.id]
      );

      const userLimit = await limits.getEffectiveUserLimitCents(pool, req.user.id);

      // Manifest llm block — deploy-time-snapshotted consent metadata.
      // Sanitize defensively even though app-manifest.js already
      // validated at snapshot time: presentation-only, the POST
      // validator above is the authority.
      const manifest = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
        ? app.manifest_snapshot : {};
      const llmBlock = manifest.llm && typeof manifest.llm === 'object' ? manifest.llm : {};
      const purpose = typeof llmBlock.purpose === 'string' && llmBlock.purpose.trim()
        ? llmBlock.purpose.trim() : null;
      const rawSuggested = llmBlock.suggested_daily_cap_cents;
      const suggestedCapCents = Number.isInteger(rawSuggested) && rawSuggested > 0
        ? Math.min(rawSuggested, userLimit) : null;

      const { rows: keyRows } = await pool.query(
        'SELECT anthropic_key_enc FROM users WHERE id = $1',
        [req.user.id]
      );

      res.json({
        app: { id: app.id, name: app.name, slug: app.slug },
        grant: grantRows[0] ? grantJson(grantRows[0]) : null,
        llm: { purpose, suggestedCapCents },
        defaultCapCents: DEFAULT_CAP_CENTS,
        maxCapCents: userLimit,
        hasApiKey: !!keyRows[0]?.anthropic_key_enc,
      });
    } catch (err) {
      log.error('llm-grants', 'Bootstrap failed', {
        userId: req.user.id, slug: req.params.slug, err: err.message,
      });
      res.status(500).json({ error: 'Failed to load permission state' });
    }
  });

  return router;
}

module.exports = { llmGrantsRoutes, DEFAULT_CAP_CENTS };
