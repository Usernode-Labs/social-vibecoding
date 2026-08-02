// Public (unauthenticated) read-only API: the platform's publicly-viewable
// apps and, for each, the people who have contributed to it.
//
// Made public via the `/api/public/` prefix in PUBLIC_PATHS
// (src/middleware/auth.js) — same mechanism the kudos leaderboard uses.
// NOTHING here reads req.user; treat every request as fully anonymous.
//
// Privacy model (mirrors the rest of the platform):
//   - Only view-public, non-self-hosted apps are ever listed. A view-
//     private app (or the self-app) is omitted entirely from the list and
//     404s on the per-app route, so its existence is never disclosed —
//     the same non-enumeration stance as services/app-access.js.
//   - usernode_pubkey (the on-chain `ut1…` wallet) is exposed by default,
//     consistent with GET /api/leaderboard/users which already publishes
//     it. `?include_wallets=0` opts the address field out.
//
// Contributors for an app = the DISTINCT union of:
//   1. the creator (apps.created_by),
//   2. accepted members (app_collaborators status='member'),
//   3. authors of merged proposals (chat_sessions status='merged').

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { clientIp } = require('../services/client-ip');
const { waitlistJoinLimiter } = require('../middleware/rate-limits');
const waitlist = require('../services/waitlist');
const questions = require('../services/waitlist-questions');
const { sendWaitlistJoinMail } = require('../services/topochain/mailer');
const { productionHostname } = require('../services/caddy');

// Apps surfaced publicly: not the self-app, view-public, and in a status
// that means the app actually exists/runs (creating / awaiting_secrets /
// error rows aren't usable, so they're hidden — `status` is still returned
// for the rows that do appear).
const HIDDEN_APP_STATUSES = ['error', 'creating', 'awaiting_secrets'];

// One round-trip that resolves the contributor set for any number of app
// ids at once (avoids an N+1 across the apps list). The UNION dedups the
// (app_id, user_id) pairs across the three sources; the join to users drops
// any id that no longer resolves (created_by / user_id are ON DELETE SET
// NULL). Ordered by username for stable output.
async function loadContributors(pool, appIds) {
  if (!appIds.length) return new Map();
  const { rows } = await pool.query(
    `WITH contributor_ids AS (
        SELECT id AS app_id, created_by AS user_id
          FROM apps
         WHERE id = ANY($1::int[]) AND created_by IS NOT NULL
        UNION
        SELECT app_id, user_id
          FROM app_collaborators
         WHERE app_id = ANY($1::int[]) AND status = 'member'
        UNION
        SELECT app_id, user_id
          FROM chat_sessions
         WHERE app_id = ANY($1::int[]) AND status = 'merged' AND user_id IS NOT NULL
     )
     SELECT c.app_id, u.id AS user_id, u.username,
            u.usernode_pubkey AS wallet_address
       FROM contributor_ids c
       JOIN users u ON u.id = c.user_id
      ORDER BY LOWER(u.username)`,
    [appIds]
  );
  const byApp = new Map();
  for (const r of rows) {
    if (!byApp.has(r.app_id)) byApp.set(r.app_id, []);
    byApp.get(r.app_id).push(r);
  }
  return byApp;
}

// Project a contributor row to its wire shape. wallet_address is included
// by default; `includeWallets === false` drops the key entirely.
function shapeContributor(row, includeWallets) {
  const out = { user_id: row.user_id, username: row.username };
  if (includeWallets) out.wallet_address = row.wallet_address ?? null;
  return out;
}

// `?include_wallets=0` (exactly the string '0') opts addresses out;
// anything else (unset, '1', …) keeps them — addresses-on is the default.
function wantsWallets(req) {
  return req.query.include_wallets !== '0';
}

function publicApiRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // GET /api/public/apps — every view-public, non-self-hosted app with its
  // contributors embedded.
  router.get('/api/public/apps', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      // The active-users join mirrors the authed home list's sticky
      // 10-day rule (routes/apps.js): a user counts iff they ever spent
      // >= 60s on the app on a single day AND visited within 10 days.
      // Batched to one row per app — same shape, no per-app round trips.
      const { rows: apps } = await pool.query(
        `SELECT a.id, a.name, a.slug, a.status, a.collab_visibility,
                a.view_visibility, a.created_at, a.last_deploy_at,
                a.icon_emoji, a.icon_image_id, a.anon_shell,
                COALESCE(au.cnt, 0) AS active_users
           FROM apps a
           LEFT JOIN (
             SELECT a1.app_id, COUNT(DISTINCT a1.user_id) AS cnt
             FROM app_activity a1
             WHERE a1.date >= CURRENT_DATE - 10
               AND EXISTS (
                 SELECT 1 FROM app_activity a2
                 WHERE a2.app_id = a1.app_id
                   AND a2.user_id = a1.user_id
                   AND a2.seconds_spent >= 60
               )
             GROUP BY a1.app_id
           ) au ON au.app_id = a.id
          WHERE NOT a.self_hosted
            AND a.view_visibility = 'public'
            AND a.status <> ALL($1::text[])
          ORDER BY COALESCE(au.cnt, 0) DESC,
                   a.last_deploy_at DESC NULLS LAST, a.created_at DESC`,
        [HIDDEN_APP_STATUSES]
      );

      const byApp = await loadContributors(pool, apps.map((a) => a.id));

      res.json({
        apps: apps.map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          status: a.status,
          collab_visibility: a.collab_visibility,
          view_visibility: a.view_visibility,
          created_at: a.created_at,
          last_deploy_at: a.last_deploy_at,
          // Home-card presentation fields (landing-page app directory).
          // icon_url is server-built like the authed list so clients never
          // assemble ids into paths; /app-icons/:id is a public route.
          icon_emoji: a.icon_emoji || null,
          icon_url: a.icon_image_id ? `/app-icons/${a.icon_image_id}` : null,
          active_users: parseInt(a.active_users, 10) || 0,
          // From the anonymous-shell probe (services/shell-probe.js):
          // anything not positively classified 'public' is presented as
          // account-required — 'unknown' fails safe to gated, matching
          // the scaffold's default behavior.
          requires_login: a.anon_shell !== 'public',
          // Direct subdomain URL — what the public landing page links to.
          // View-public apps pass the Caddy edge gate without a session;
          // apps that JWT-gate their own HTML shell will show their
          // "Open in Usernode" page to anonymous visitors.
          url: `https://${productionHostname(a.slug)}`,
          contributors: (byApp.get(a.id) || []).map((r) =>
            shapeContributor(r, includeWallets)
          ),
        })),
      });
    } catch (err) {
      log.error('public-api', 'apps list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/apps/:slug/contributors — one app's contributor list.
  // 404 (never 403) for a missing, self-hosted, or view-private slug so a
  // hidden app's existence isn't disclosed.
  router.get('/api/public/apps/:slug/contributors', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, self_hosted, view_visibility
           FROM apps WHERE slug = $1`,
        [String(req.params.slug)]
      );
      const app = rows[0];
      if (!app || app.self_hosted || app.view_visibility !== 'public') {
        return res.status(404).json({ error: 'App not found' });
      }

      const byApp = await loadContributors(pool, [app.id]);
      res.json({
        slug: app.slug,
        contributors: (byApp.get(app.id) || []).map((r) =>
          shapeContributor(r, includeWallets)
        ),
      });
    } catch (err) {
      log.error('public-api', 'contributors failed', {
        slug: req.params.slug, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/waitlist/options — the survey question definitions
  // (option keys + labels, countries, limits). The SPA renders both
  // waitlist forms from this so client and server validation can't
  // drift; the payload is static per process.
  router.get('/api/public/waitlist/options', (_req, res) => {
    res.json(questions.publicOptions());
  });

  // POST /api/public/waitlist — platform waitlist join (onboarding flow
  // alignment), now carrying the stage-1 survey (mirrors the original
  // topochain waitlist: made_url + discovery required, location
  // optional). No account required. Idempotent and non-enumerating: an
  // email that's already on the list gets the same 200 as a fresh one —
  // but only the FIRST join gets a stage-2 `more` link back (re-joins
  // must not hand a stranger the capability to edit someone's answers).
  // Confirmation mail is best-effort (the mailer degrades silently when
  // no transport is configured).
  router.post('/api/public/waitlist', waitlistJoinLimiter, async (req, res) => {
    const email = waitlist.normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(422).json({ error: 'A valid email address is required.' });
    }
    const stage1 = questions.validateStage1(req.body || {});
    if (!stage1.ok) {
      return res.status(422).json({ error: stage1.error });
    }
    try {
      const { created, moreToken } = await waitlist.joinWaitlist(pool, {
        email,
        ip: clientIp(req),
        answers: stage1.value,
      });
      if (created) {
        log.info('public-api', 'Waitlist join', {});
        sendWaitlistJoinMail(config, email, { moreToken }); // fire-and-forget, never throws
      }
      res.json({
        ok: true,
        message: "You're on the waitlist. We'll email you when access opens up.",
        // Stage-2 capability — present only on the first join.
        more_token: moreToken || null,
      });
    } catch (err) {
      log.error('public-api', 'waitlist join failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/waitlist/more/:token — stage-2 state for the "Want
  // in sooner?" form: previously saved answers (so the form is
  // re-openable and prefills) plus which OAuth connects are available /
  // already verified. The token is an unguessable capability from the
  // join response / email; an invalid token 404s.
  router.get('/api/public/waitlist/more/:token', waitlistJoinLimiter, async (req, res) => {
    try {
      const row = await waitlist.getSignupByMoreToken(pool, req.params.token);
      if (!row) return res.status(404).json({ error: 'Unknown or expired link.' });
      const answers = row.answers && typeof row.answers === 'object' ? row.answers : {};
      res.json({
        ok: true,
        answers,
        oauth: {
          github: !!(config.waitlistGithubClientId && config.waitlistGithubClientSecret),
          x: !!(config.waitlistXClientId && config.waitlistXClientSecret),
        },
      });
    } catch (err) {
      log.error('public-api', 'waitlist more fetch failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/public/waitlist/more/:token — merge stage-2 answers.
  // Everything optional; sections merge (a later visit can fill in what
  // an earlier one skipped). Mirrors topochain's storeMore.
  router.post('/api/public/waitlist/more/:token', waitlistJoinLimiter, async (req, res) => {
    const stage2 = questions.validateStage2(req.body || {});
    if (!stage2.ok) {
      return res.status(422).json({ error: stage2.error });
    }
    try {
      const merged = await waitlist.mergeMoreAnswers(pool, req.params.token, stage2.value);
      if (!merged) return res.status(404).json({ error: 'Unknown or expired link.' });
      res.json({ ok: true, message: 'Saved — thanks. You can come back and add to this any time.' });
    } catch (err) {
      log.error('public-api', 'waitlist more save failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  publicApiRoutes,
  // Exported for tests.
  loadContributors,
  shapeContributor,
  HIDDEN_APP_STATUSES,
};
