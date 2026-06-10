const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { createApp } = require('../services/app-creator');
const caddy = require('../services/caddy');
const docker = require('../services/docker');
const github = require('../services/github');
const driftPoller = require('../services/main-drift-poller');
const appSecrets = require('../services/app-secrets');
const appManifest = require('../services/app-manifest');
const renamePr = require('../services/rename-pr');
const staging = require('../services/staging');
const { drainGuard } = require('../services/lifecycle');
const { appCreateLimiter, issueCreateLimiter } = require('../middleware/rate-limits');
const events = require('../services/events');
const appAccess = require('../services/app-access');

const VISIBILITY_VALUES = new Set(['public', 'private']);

// Validate a (collabVisibility, viewVisibility) pair against the
// invariants (see schema.sql): both must be public|private, and
// collab-public implies view-public. Returns an error string or null.
function validateVisibilityCombo(collabVisibility, viewVisibility) {
  if (!VISIBILITY_VALUES.has(collabVisibility) || !VISIBILITY_VALUES.has(viewVisibility)) {
    return 'Visibility must be "public" or "private"';
  }
  if (collabVisibility === 'public' && viewVisibility === 'private') {
    return 'An app that everyone can build cannot be private to view';
  }
  return null;
}

// Per-viewer access flags appended to app payloads so the client can
// gate tabs / render badges without extra round-trips.
function accessFlags(app, user, isCollaborator) {
  const isAdmin = !!user?.isAdmin;
  return {
    is_collaborator: !!isCollaborator,
    can_collaborate: isAdmin || app.collab_visibility !== 'private' || !!isCollaborator,
    can_manage: isAdmin || (user?.id != null && app.created_by === user.id),
  };
}

// Local-dev URL fallback ("http://localhost:<hostport>" instead of the
// real "https://<slug>.<USERNODE_DOMAIN>") is opt-in via env. Previously
// any value of DOCKER_NETWORK flipped this on, but standalone production
// also has to set DOCKER_NETWORK (to point child apps at the platform's
// network) — so DOCKER_NETWORK is no longer a clean signal. Set
// USERNODE_LOCAL_DEV=1 in your local .env to get the localhost fallback.
const IS_LOCAL_DEV = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';

// SELF-HOSTING.md sub-step 2k: helper for the import-flow guards.
// Compares a parsed {owner, repo} against config.platformRepoUrl,
// case-insensitively. Returns false on any malformed input — the caller
// has already validated the parse, so this only fires the guard for
// genuine platform-repo URLs.
function isPlatformRepo(parsed, config) {
  if (!parsed || !parsed.owner || !parsed.repo) return false;
  if (!config.platformRepoUrl) return false;
  const platform = github.parseGithubUrl(config.platformRepoUrl);
  if (!platform) return false;
  return parsed.owner.toLowerCase() === platform.owner.toLowerCase()
      && parsed.repo.toLowerCase() === platform.repo.toLowerCase();
}

// SELF-HOSTING.md sub-step 2h: the platform reads its own env from
// .env (written by deploy.yml from GitHub Actions secrets), not from
// app_secrets. A POST/PUT/DELETE here would persist into the table but
// have zero runtime effect, which is silent-broken UX. Refuse them with
// an explanatory 403 so the only visible path matches reality. Same
// rationale applies to /redeploy and /check-updates: the platform's
// deploy is GHA-driven, not staging.rebuildProduction-driven.
function refuseIfSelfHosted(app, res, action) {
  if (!app || !app.self_hosted) return false;
  res.status(403).json({
    error: action === 'secret'
      ? 'The Usernode platform reads its env from .env written by GitHub Actions; storing values here would have no effect. Edit secrets via the repository\'s Actions secrets settings.'
      : 'The Usernode platform deploys via GitHub Actions; this action does not apply to the self-app row.',
  });
  return true;
}

// If app creation hasn't reached `running` within this window, a watchdog
// flips the row to `error` so the home screen stops showing "Spinning up..."
// and the creator can retry.
const CREATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_COUNT = 3;

function scheduleCreationWatchdog(pool, appId) {
  setTimeout(async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE apps SET status = 'error'
         WHERE id = $1 AND status = 'creating'`,
        [appId]
      );
      if (rowCount > 0) {
        log.warn('apps', 'App creation timed out, marked as error', { appId });
      }
    } catch (err) {
      log.warn('apps', 'Creation watchdog query failed', { appId, err: err.message });
    }
  }, CREATION_TIMEOUT_MS).unref?.();
}

// Called on server startup: any app that was mid-creation when the previous
// process died is stranded in `creating`. Flip anything older than 10min.
async function sweepStuckCreatingApps(pool) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE apps SET status = 'error'
       WHERE status = 'creating' AND created_at < NOW() - INTERVAL '10 minutes'`
    );
    if (rowCount > 0) {
      log.info('apps', 'Swept stuck creating apps on boot', { count: rowCount });
    }
  } catch (err) {
    log.warn('apps', 'Boot sweep failed', { err: err.message });
  }
}

function appRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps', async (req, res) => {
    try {
      const appDeployStatus = require('../services/app-deploy-status');
      // SELF-HOSTING.md sub-step 2j: hide self_hosted rows from
      // non-admin listings. Admins see them so they can reach the
      // self-app's settings, dev-chat, etc. The same filter is applied
      // to GET /api/apps/:slug below — a non-admin requesting the slug
      // directly gets a 404, not a 403, so the row's existence isn't
      // disclosed.
      //
      // Phase 4 (SELF_APP_PUBLIC_VOTING): when the flag is on, non-
      // admins also see the self-app row so they can vote on its PRs
      // through the existing voting UI. Off by default; flip via env.
      const showSelfHosted = !!req.user?.isAdmin || !!config.selfAppPublicVoting;
      // The active_users join mirrors src/services/active-users.js's
      // sticky 10-day rule: a user counts iff they ever spent >= 60s
      // on this app on a single day AND have visited within the last
      // 10 days. Computed in one batched query (one row per app) to
      // avoid the obvious O(N apps) per-app round trip from the
      // group-chat dashboard tile path.
      const userId = req.user?.id || null;
      const isAdmin = !!req.user?.isAdmin;
      // Visibility filter: admins see everything; everyone else sees
      // view-public apps plus apps they're a member of (the `me` join).
      // View-private apps are simply absent from the list for outsiders
      // — same non-disclosure stance as the self_hosted filter.
      const { rows } = await pool.query(`
        SELECT a.*,
          COALESCE(msg_counts.cnt, 0) AS message_count,
          COALESCE(activity.total_seconds, 0) AS total_seconds,
          COALESCE(au.cnt, 0) AS active_users,
          (favs.app_id IS NOT NULL) AS is_favorited,
          (me.user_id IS NOT NULL) AS is_collaborator
        FROM apps a
        LEFT JOIN (
          SELECT app_id, COUNT(*) AS cnt
          FROM chat_messages
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY app_id
        ) msg_counts ON msg_counts.app_id = a.id
        LEFT JOIN (
          SELECT app_id, SUM(seconds_spent) AS total_seconds
          FROM app_activity
          WHERE date > CURRENT_DATE - 7
          GROUP BY app_id
        ) activity ON activity.app_id = a.id
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
        LEFT JOIN (
          SELECT app_id FROM app_favorites WHERE user_id = $2
        ) favs ON favs.app_id = a.id
        LEFT JOIN app_collaborators me
          ON me.app_id = a.id AND me.user_id = $2 AND me.status = 'member'
        WHERE (NOT a.self_hosted OR $1::boolean)
          AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)
        ORDER BY (COALESCE(msg_counts.cnt, 0) + COALESCE(activity.total_seconds, 0)) DESC, a.created_at DESC
      `, [showSelfHosted, userId, isAdmin]);

      const apps = await Promise.all(rows.map(async (a) => {
        // Per-app missing-required-secrets list. Cheap (one extra query
        // each) and lets the home tile show a "fix secrets" warning
        // without each card making its own /secrets fetch on render.
        //
        // Skipped for self-hosted apps: the platform reads its env from
        // `.env` written by GitHub Actions (Phase 2h), and the secrets
        // UI is intentionally read-only via refuseIfSelfHosted, so
        // app_secrets is always empty. Computing missingSecrets here
        // would surface every required manifest key as "missing" and
        // prompt users to click Refresh, which then 403s with the
        // "deploys via GitHub Actions" message — pure false-positive UX.
        let missingSecrets = null;
        if (!a.self_hosted && a.manifest_snapshot && typeof a.manifest_snapshot === 'object') {
          const declared = Array.isArray(a.manifest_snapshot.secrets)
            ? a.manifest_snapshot.secrets : [];
          if (declared.some((s) => s && s.required)) {
            const { rows: storedRows } = await pool.query(
              'SELECT key FROM app_secrets WHERE app_id = $1',
              [a.id]
            );
            const storedKeys = new Set(storedRows.map((r) => r.key));
            missingSecrets = declared
              .filter((s) => s && s.required && !storedKeys.has(s.key))
              .map((s) => s.key);
            if (!missingSecrets.length) missingSecrets = null;
          }
        }

        let url = null;
        if (a.status === 'running') {
          if (IS_LOCAL_DEV) {
            const containerName = `usernode-app-${a.slug}`;
            const hostPort = await docker.getHostPort(containerName, 3000);
            if (hostPort) url = `http://localhost:${hostPort}`;
          }
          if (!url) url = `https://${caddy.productionHostname(a.slug)}`;
        }
        // Minimal version info for the home-screen pill — derived
        // entirely from columns we already pulled, no extra round
        // trips. The richer per-app endpoint at
        // /api/apps/:slug/version still does the chat_sessions join
        // for PR title/author, which the home pill doesn't need.
        // Self-hosted (platform self-app) overrides for `active_users`:
        // the LEFT JOIN above scopes to `app_id = a.id`, but no rows
        // ever land under the self-app's id (no App tab → no activity
        // tracking — see services/active-users.js for the full
        // rationale). Re-compute as the union across every app so the
        // home tile shows a meaningful count and the value matches what
        // getActiveUserStats returns for vote-majority math.
        if (a.self_hosted) {
          const { rows: unionRows } = await pool.query(
            `SELECT COUNT(DISTINCT a.user_id) AS cnt
               FROM app_activity a
               WHERE a.date >= CURRENT_DATE - 10
                 AND EXISTS (
                   SELECT 1 FROM app_activity b
                   WHERE b.user_id = a.user_id
                     AND b.seconds_spent >= 60
                 )`
          );
          a.active_users = parseInt(unionRows[0]?.cnt, 10) || 0;
        }

        const [, owner, repo] = (a.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        const version = a.main_sha
          ? {
              sha: a.main_sha,
              shortSha: a.main_sha.slice(0, 7),
              prNumber: a.main_pr_number || null,
              commitUrl: owner && repo
                ? `https://github.com/${owner}/${repo}/commit/${a.main_sha}`
                : null,
              prUrl: a.main_pr_number && owner && repo
                ? `https://github.com/${owner}/${repo}/pull/${a.main_pr_number}`
                : null,
            }
          : null;
        return {
          ...a,
          url,
          version,
          deployProgress: appDeployStatus.read(a.slug),
          missingSecrets,
          is_favorited: !!a.is_favorited,
          ...accessFlags(a, req.user, a.is_collaborator),
        };
      }));
      res.json({ apps });
    } catch (err) {
      log.error('apps', 'Failed to list apps', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Public-only repo info. Kept as a low-privilege fallback; not used by
  // the import modal anymore (verify-access below is strictly better
  // because it works for private repos the bot can read).
  router.get('/api/github/repo-info', async (req, res) => {
    const parsed = github.parseGithubUrl(req.query.url || '');
    if (!parsed) return res.status(400).json({ error: 'Invalid GitHub URL' });
    const info = await github.fetchPublicRepoInfo(parsed.owner, parsed.repo);
    if (!info) return res.status(404).json({ error: 'Repo not found or private' });
    res.json({ name: info.name, description: info.description });
  });

  // The "Check access" button in the import-existing modal hits this.
  // It's the same pre-flight POST /api/apps runs on submit (so the
  // server stays the source of truth even if a client skips the check),
  // surfaced as its own endpoint so the UI can:
  //   1. accept any pending bot invitation for this exact repo
  //   2. confirm Write access
  //   3. return name/description so the form can prefill the app-name
  //      field with a sensible default
  router.get('/api/github/verify-access', async (req, res) => {
    const parsed = github.parseGithubUrl(req.query.url || '');
    if (!parsed) return res.status(400).json({ error: 'Repo URL must look like https://github.com/<owner>/<repo>' });
    // SELF-HOSTING.md sub-step 2k: refuse to import the platform's
    // own repo as a child app. The self-app row already exists; importing
    // a sibling would just produce a confused / broken app row sharing
    // the same code.
    if (isPlatformRepo(parsed, config)) {
      return res.status(409).json({
        error: 'This is the platform repo. The self-app already exists; importing it as a child would create a sibling instance.',
      });
    }
    const verify = await github.verifyBotAccess(parsed.owner, parsed.repo);
    if (!verify.ok) return res.status(verify.status).json({ error: verify.message, code: verify.code });
    res.json({
      ok: true,
      owner: parsed.owner,
      repo: parsed.repo,
      name: verify.name,
      description: verify.description,
      fullName: verify.fullName,
    });
  });

  router.post('/api/apps', drainGuard, appCreateLimiter, async (req, res) => {
    // Per-user app-creation gate (admin-controlled, default off — see
    // users.can_create_apps in schema.sql). The home-screen UI hides the
    // create affordance for users who fail this check; the server-side
    // enforcement here is the actual gate.
    if (!req.user?.canCreateApps) {
      return res.status(403).json({
        error: 'You don\u2019t have permission to create apps. Ask an admin to enable app creation for your account.',
      });
    }

    const { name, repoUrl } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // Creation-time visibility (defaults preserve today's behavior).
    const collabVisibility = req.body.collabVisibility || 'public';
    const viewVisibility = req.body.viewVisibility || 'public';
    const visibilityError = validateVisibilityCombo(collabVisibility, viewVisibility);
    if (visibilityError) {
      return res.status(400).json({ error: visibilityError });
    }

    // Import-existing pre-flight: parse URL, accept any pending invite
    // for this exact repo, then verify Write access. Anything other
    // than `ok` is forwarded to the client with the actionable hint
    // assembled in github.verifyBotAccess.
    let repoUrlNormalized = null;
    if (repoUrl) {
      const parsed = github.parseGithubUrl(repoUrl);
      if (!parsed) {
        return res.status(400).json({ error: 'Repo URL must look like https://github.com/<owner>/<repo>' });
      }
      // SELF-HOSTING.md sub-step 2k: same guard as
      // /api/github/verify-access, but on the submit path so a client
      // that skipped Check (or a script POSTing directly) can't bypass.
      if (isPlatformRepo(parsed, config)) {
        return res.status(409).json({
          error: 'This is the platform repo. The self-app already exists; importing it as a child would create a sibling instance.',
        });
      }
      const verify = await github.verifyBotAccess(parsed.owner, parsed.repo);
      if (!verify.ok) {
        return res.status(verify.status).json({ error: verify.message });
      }
      repoUrlNormalized = `https://github.com/${parsed.owner}/${parsed.repo}`;
    }

    const crypto = require('crypto');
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!base) {
      return res.status(400).json({ error: 'Invalid app name' });
    }
    const code = crypto.randomBytes(3).toString('hex');
    const slug = `${base}-${code}`;

    try {
      // Enforce global app cap (admins bypass). Errored apps don't count
      // toward the limit — they hold ~no resources and can be deleted to
      // free a slot.
      if (!req.user?.isAdmin && config.maxApps > 0) {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
        );
        if (countRows[0].n >= config.maxApps) {
          log.warn('apps', 'App creation blocked by max-apps cap', {
            userId: req.user.id,
            active: countRows[0].n,
            cap: config.maxApps,
          });
          return res.status(429).json({
            error: `This server is at its app limit (${config.maxApps}). Ask an admin to remove an app or raise the limit.`,
          });
        }
      }

      // The CTE makes app row + creator membership atomic — the creator
      // must always have a member row (it's what makes a collab-private
      // app reachable by anyone at all).
      const { rows } = await pool.query(
        `WITH new_app AS (
           INSERT INTO apps (name, slug, repo_url, created_by, status,
                             collab_visibility, view_visibility)
           VALUES ($1, $2, $3, $4, 'creating', $5, $6)
           RETURNING *
         ), membership AS (
           INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
           SELECT id, $4, 'member', NOW() FROM new_app
           ON CONFLICT (app_id, user_id) DO NOTHING
         )
         SELECT * FROM new_app`,
        [name.trim(), slug, repoUrlNormalized, req.user.id, collabVisibility, viewVisibility]
      );

      const appRow = rows[0];
      log.info('apps', repoUrlNormalized ? 'App imported (pending)' : 'App created (pending)', {
        appId: appRow.id,
        slug,
        ...(repoUrlNormalized ? { repoUrl: repoUrlNormalized } : {}),
      });
      events.record(pool, {
        type: events.EVENT_TYPES.APP_CREATED,
        userId: req.user.id,
        appId: appRow.id,
        metadata: { imported: !!repoUrlNormalized, collabVisibility, viewVisibility },
      });

      // Kick off async creation — don't await. If it throws, flip to error.
      createApp(config, appRow).catch(async (err) => {
        log.error('apps', 'Async app creation failed', { appId: appRow.id, err: err.message });
        await pool.query(
          `UPDATE apps SET status = 'error' WHERE id = $1 AND status = 'creating'`,
          [appRow.id]
        ).catch(() => {});
      });

      // Backstop: if createApp hangs (never resolves or rejects), the
      // watchdog will unstick the row after CREATION_TIMEOUT_MS.
      scheduleCreationWatchdog(pool, appRow.id);

      res.status(201).json({ app: appRow });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An app with that name already exists' });
      }
      log.error('apps', 'Failed to create app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM apps WHERE slug = $1',
        [req.params.slug]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'App not found' });
      }

      const appRow = rows[0];
      // SELF-HOSTING.md sub-step 2j: 404 self-hosted rows for
      // non-admins (don't disclose existence via the slug path either).
      // Phase 4: SELF_APP_PUBLIC_VOTING relaxes this for non-admin
      // viewing/voting; falls back to admin-only when the flag is off
      // (today's default).
      if (appRow.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }
      // Visibility gate (view level). 404, not 403, so view-private apps
      // aren't enumerable — same stance as the self_hosted check above.
      const isCollaborator = await appAccess.isCollaborator(pool, appRow.id, req.user?.id);
      if (!req.user?.isAdmin && appRow.view_visibility === 'private' && !isCollaborator) {
        return res.status(404).json({ error: 'App not found' });
      }
      let url = null;
      if (appRow.status === 'running') {
        if (IS_LOCAL_DEV) {
          const containerName = `usernode-app-${appRow.slug}`;
          const hostPort = await docker.getHostPort(containerName, 3000);
          if (hostPort) url = `http://localhost:${hostPort}`;
        }
        if (!url) url = `https://${caddy.productionHostname(appRow.slug)}`;
      }

      // Same missingSecrets computation as the /api/apps list — needed
      // here so AppView.open() can paint the header badge and the
      // 'awaiting_secrets' splash without a second round-trip. Same
      // self_hosted skip rationale as above: refuseIfSelfHosted keeps
      // app_secrets empty for the self-app, so the badge would always
      // false-positive.
      let missingSecrets = null;
      if (!appRow.self_hosted && appRow.manifest_snapshot && typeof appRow.manifest_snapshot === 'object') {
        const declared = Array.isArray(appRow.manifest_snapshot.secrets)
          ? appRow.manifest_snapshot.secrets : [];
        if (declared.some((s) => s && s.required)) {
          const { rows: storedRows } = await pool.query(
            'SELECT key FROM app_secrets WHERE app_id = $1',
            [appRow.id]
          );
          const storedKeys = new Set(storedRows.map((r) => r.key));
          missingSecrets = declared
            .filter((s) => s && s.required && !storedKeys.has(s.key))
            .map((s) => s.key);
          if (!missingSecrets.length) missingSecrets = null;
        }
      }

      res.json({
        app: {
          ...appRow,
          url,
          missingSecrets,
          ...accessFlags(appRow, req.user, isCollaborator),
        },
      });
    } catch (err) {
      log.error('apps', 'Failed to get app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Deployed version pill (#21). Returns the SHA + PR context for the
  // commit currently running in prod. Null sha = pre-migration app
  // still in backfill queue, or a local-template build with no repo.
  //
  // Also folds in `deployProgress` so a freshly-loaded client whose
  // app is currently being redeployed sees the pill in its yellow
  // spinning state on first paint, rather than only after the next
  // `app_redeploy_status` WS broadcast.
  router.get('/api/apps/:slug/version', async (req, res) => {
    try {
      const appVersion = require('../services/app-version');
      const appDeployStatus = require('../services/app-deploy-status');
      const gated = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gated) return res.status(404).json({ error: 'App not found' });
      const info = await appVersion.getAppVersion(pool, req.params.slug);
      if (!info) return res.status(404).json({ error: 'App not found' });
      res.json({ ...info, deployProgress: appDeployStatus.read(req.params.slug) });
    } catch (err) {
      log.error('apps', 'Failed to get app version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Per-app secrets (see services/app-secrets.js + app-manifest.js).
  //
  // GET   /api/apps/:slug/secrets         — combined manifest+stored view
  //                                         (everyone with app access)
  // PUT   /api/apps/:slug/secrets/:key    — admin-only direct set
  // DELETE /api/apps/:slug/secrets/:key   — admin-only direct delete
  // POST  /api/apps/:slug/redeploy        — admin-only manual redeploy
  //                                         (used after fixing missing
  //                                         secrets; also reachable from
  //                                         the secret_change vote-apply
  //                                         path in routes/issues.js)
  //
  // Non-admins propose a secret change via POST /api/apps/:slug/issues
  // with kind='secret_change' (handled in routes/issues.js).
  // ────────────────────────────────────────────────────────────────────

  router.get('/api/apps/:slug/secrets', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, slug, manifest_snapshot, self_hosted, collab_visibility, view_visibility FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      // Secrets metadata is a build surface — collab-level access.
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'collab'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      // SELF-HOSTING.md sub-step 2j: 404 self-hosted secrets to
      // non-admins as well; otherwise the listing reveals declared
      // secret keys for the platform itself.
      //
      // Phase 4 (SELF_APP_PUBLIC_VOTING): when the flag is on, expose
      // the read-only secrets view to all users. Only the metadata
      // (key, description, required, hasValue) is returned — actual
      // values are never read from app_secrets for the self-app
      // (process.env is the source of truth, see below) and
      // valueLast4 stays null in this branch, so this is metadata-
      // only disclosure consistent with "open-source-by-live-dev-
      // chat" transparency. The write protection (refuseIfSelfHosted
      // on POST/PUT/DELETE) is unchanged.
      if (app.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }
      const manifest = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
        ? app.manifest_snapshot
        : { secrets: [] };
      // SELF-HOSTING.md sub-step 2h: for the self-app, hasValue
      // mirrors the GitHub-Actions-configured reality (process.env)
      // rather than app_secrets, since the platform never reads
      // app_secrets for its own keys. Orphans don't apply (nothing is
      // ever stored). valueLast4 is null because the platform process
      // can't safely surface its own env values via an API.
      let view;
      if (app.self_hosted) {
        view = manifest.secrets.map((entry) => ({
          key: entry.key,
          description: entry.description,
          required: entry.required,
          // Canonical `private` plus `sensitive` BC alias (populated
          // identically) so old UI clients keep working.
          private: entry.private,
          sensitive: entry.private,
          default: entry.default,
          hasValue: !!process.env[entry.key],
          valueLast4: null,
          updatedAt: null,
          orphan: false,
        }));
      } else {
        view = await appSecrets.getRedactedView(pool, app.id, manifest);
      }
      res.json({
        secrets: view,
        manifestKnown: !!app.manifest_snapshot,
        readOnly: !!app.self_hosted,
      });
    } catch (err) {
      log.error('apps', 'Failed to list secrets', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/apps/:slug/secrets/:key', drainGuard, async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const value = req.body && typeof req.body.value === 'string' ? req.body.value : '';
    if (!value.length) return res.status(400).json({ error: 'value is required' });

    try {
      const { rows } = await pool.query(
        'SELECT id, manifest_snapshot, self_hosted FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (refuseIfSelfHosted(app, res, 'secret')) return;
      const manifest = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
        ? app.manifest_snapshot
        : { secrets: [] };

      const declared = (manifest.secrets || []).find((s) => s.key === req.params.key);
      // Allow setting non-declared keys too (orphan cleanup / pre-declaration
      // bootstrapping) but enforce the same key shape. The deploy paths
      // only ever inject declared keys, so an orphan stays unused unless
      // the manifest grows to include it later.
      if (!declared && !appManifest.KEY_RE.test(req.params.key)) {
        return res.status(400).json({ error: 'Invalid key format' });
      }
      if (!declared && appManifest.RESERVED_KEYS.has(req.params.key)) {
        return res.status(400).json({ error: 'This key is reserved by the platform' });
      }

      await appSecrets.setValue(pool, app.id, req.params.key, value, {
        sensitive: !!declared?.private,
        userId: req.user.id,
        jwtSecret: config.jwtSecret,
      });
      log.info('apps', 'Secret set (admin direct)', {
        slug: req.params.slug, key: req.params.key, userId: req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to set secret', {
        slug: req.params.slug, key: req.params.key, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/apps/:slug/secrets/:key', drainGuard, async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    try {
      const { rows } = await pool.query('SELECT id, self_hosted FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      if (refuseIfSelfHosted(rows[0], res, 'secret')) return;
      await appSecrets.deleteValue(pool, rows[0].id, req.params.key);
      log.info('apps', 'Secret deleted (admin direct)', {
        slug: req.params.slug, key: req.params.key, userId: req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to delete secret', {
        slug: req.params.slug, key: req.params.key, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Trigger a fresh `rebuildProduction`. Used after admins fix missing
  // secrets to retry a deploy from `awaiting_secrets`/`error` (also used
  // by the secret_change vote-apply path). Returns immediately; the
  // rebuild streams progress via the existing `app_redeploy_status` WS
  // event so the UI's version pill flips to its yellow spinning state.
  router.post('/api/apps/:slug/redeploy', drainGuard, async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (refuseIfSelfHosted(app, res, 'rebuild')) return;
      if (!app.repo_url) {
        return res.status(400).json({ error: 'This app is not backed by a GitHub repo' });
      }
      // Fire-and-forget: same fan-out as the drift-poller and dev-chat
      // merge paths use. Errors land on the deploy-status broadcast.
      staging.rebuildProduction(config, app)
        .then(async ({ containerId, sha }) => {
          await pool.query(
            `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                             last_deploy_at = NOW()
             WHERE id = $3`,
            [containerId, sha || null, app.id]
          );
        })
        .catch((err) => {
          log.warn('apps', 'Manual redeploy failed', { slug: app.slug, err: err.message });
        });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Redeploy kickoff failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin-only "Check for updates" button. Runs the same per-app drift
  // check the periodic poller does, but on demand. Returns a structured
  // result so the UI can show a useful toast (no_drift / redeployed /
  // rebuild_failed / fetch_failed). Only meaningful for repo-backed
  // apps; rejects with 400 otherwise.
  router.post('/api/apps/:slug/check-updates', drainGuard, async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    try {
      const { rows } = await pool.query(
        'SELECT id, slug, repo_url, main_sha, self_hosted FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (refuseIfSelfHosted(app, res, 'rebuild')) return;
      if (!app.repo_url) {
        return res.status(400).json({ error: 'This app is not backed by a GitHub repo' });
      }
      const result = await driftPoller.checkAndRedeployOne(config, pool, app);
      res.json(result);
    } catch (err) {
      log.error('apps', 'Manual drift check failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Rename an app by opening a PR that edits (or creates) the top-level
  // `name` field in the repo's dapp.json. The rename does NOT take effect
  // immediately — the PR drops into the existing vote panel as a promoted
  // chat_sessions row and, when it reaches majority and merges, the prod
  // rebuild re-reads dapp.json and reconciles apps.name (see
  // services/app-manifest.js reconcileAppName + staging.rebuildProduction).
  // This replaces the old issue-based rename proposal in routes/issues.js.
  router.post('/api/apps/:slug/rename', drainGuard, issueCreateLimiter, async (req, res) => {
    const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim() : '';
    if (!newName) {
      return res.status(400).json({ error: 'newName is required' });
    }
    if (newName.length < 3) {
      return res.status(400).json({ error: 'Name must be at least 3 characters' });
    }
    if (newName.length > appManifest.MAX_APP_NAME_LENGTH) {
      return res.status(400).json({
        error: `Name must be ${appManifest.MAX_APP_NAME_LENGTH} characters or fewer`,
      });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      if (newName.toLowerCase() === (app.name || '').toLowerCase()) {
        return res.status(400).json({ error: 'App is already named that' });
      }

      if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
        return res.status(503).json({
          error: 'Renames need GitHub configured on the platform (GITHUB_BOT_TOKEN).',
        });
      }
      if (!app.repo_url) {
        return res.status(400).json({ error: 'App has no GitHub repository to open a PR against' });
      }
      const repoMatch = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!repoMatch) {
        return res.status(400).json({ error: 'Could not parse the app repository URL' });
      }

      // Open the rename PR + promoted vote session via the shared helper
      // (services/rename-pr.js) — the exact same code path the boot
      // migration uses to drain legacy rename issues.
      const result = await renamePr.createRenamePR(
        config, pool, app, newName, { id: req.user.id, username: req.user.username }
      );

      res.status(201).json({
        ok: true,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      });
    } catch (err) {
      log.error('apps', 'Rename PR failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Toggle the admin-gated change lock (admin only). When locked=true,
  // applying any group-voted change (PR merge, rename proposal, secret
  // change) additionally requires at least one admin yes/up vote on top
  // of the existing active-user majority — enforced in routes/votes.js
  // (checkAndMerge) and routes/issues.js (maybeApplyRenameProposal /
  // maybeApplySecretChangeProposal) via services/admin-approval.js.
  //
  // The home-card lock icon is the canonical UI affordance. We post a
  // system chat message + broadcast `app_update` so every viewer's card
  // and group-chat history reflects the change without a reload.
  router.post('/api/apps/:slug/lock', drainGuard, async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const { locked } = req.body || {};
    if (typeof locked !== 'boolean') {
      return res.status(400).json({ error: 'locked (boolean) required in body' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE apps SET locked = $1 WHERE slug = $2
         RETURNING id, slug, locked`,
        [locked, req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];

      const { sendSystemMessage, pushAppUpdate } = require('../services/ws');
      await sendSystemMessage(pool, app.id,
        locked
          ? `${req.user.username} locked this app — merges now also require an admin yes vote`
          : `${req.user.username} unlocked this app — merges no longer require an admin yes vote`,
        'system'
      ).catch((err) => log.warn('apps', 'Lock chat msg failed', { err: err.message }));

      pushAppUpdate({
        action: 'lock_changed',
        appSlug: app.slug,
        appId: app.id,
        locked: app.locked,
      });

      log.info('apps', 'Lock toggled', { slug: app.slug, locked, by: req.user.username });
      res.json({ ok: true, locked: app.locked });
    } catch (err) {
      log.error('apps', 'Lock toggle failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Post-creation visibility change (creator or admin only). Same enum +
  // invalid-combination validation as create. Transition semantics:
  //   - more public: safe and immediate; member rows are kept (inert on
  //     collab-public apps, revived if re-privatized). Pending invites on
  //     a now-collab-public app are auto-resolved (deleted + their
  //     collab_invite notifications marked read) since membership is
  //     meaningless there.
  //   - more private: outsiders lose access immediately; favorites and
  //     old notifications stay (inert) per the spec's trade-offs.
  router.patch('/api/apps/:slug/visibility', drainGuard, async (req, res) => {
    const collabVisibility = req.body?.collabVisibility;
    const viewVisibility = req.body?.viewVisibility;
    const visibilityError = validateVisibilityCombo(collabVisibility, viewVisibility);
    if (visibilityError) {
      return res.status(400).json({ error: visibilityError });
    }
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      // Non-viewers get the existence-hiding 404; viewers without manage
      // rights get an honest 403.
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (!req.user?.isAdmin && app.created_by !== req.user?.id) {
        return res.status(403).json({ error: 'Only the app creator or an admin can change visibility' });
      }
      if (refuseIfSelfHosted(app, res, 'visibility')) return;

      const unchanged = app.collab_visibility === collabVisibility
        && app.view_visibility === viewVisibility;
      if (unchanged) {
        return res.json({ ok: true, collabVisibility, viewVisibility });
      }

      await pool.query(
        `UPDATE apps SET collab_visibility = $1, view_visibility = $2 WHERE id = $3`,
        [collabVisibility, viewVisibility, app.id]
      );

      // collab private → public: pending invites become meaningless.
      // Delete them and resolve their drawer notifications.
      if (app.collab_visibility === 'private' && collabVisibility === 'public') {
        const { rows: pending } = await pool.query(
          `DELETE FROM app_collaborators WHERE app_id = $1 AND status = 'invited'
           RETURNING user_id`,
          [app.id]
        );
        const notifications = require('../services/notifications');
        const { pushNotificationToUser } = require('../services/ws');
        for (const p of pending) {
          await notifications.markInviteNotificationsRead(pool, p.user_id, app.id)
            .catch(() => {});
          try { pushNotificationToUser(p.user_id, { type: 'notifications_changed' }); } catch {}
        }
      }

      appAccess.invalidateVisibility(app.id, app.slug);

      const { sendSystemMessage, pushAppUpdate } = require('../services/ws');
      const describe = (cv, vv) => cv === 'public'
        ? 'public'
        : (vv === 'private' ? 'private (collaborators only)' : 'invite-only build, public to view');
      await sendSystemMessage(pool, app.id,
        `${req.user.username} changed this app's visibility to ${describe(collabVisibility, viewVisibility)}`,
        'system'
      ).catch((err) => log.warn('apps', 'Visibility chat msg failed', { err: err.message }));

      pushAppUpdate({
        action: 'visibility_changed',
        appSlug: app.slug,
        appId: app.id,
        collabVisibility,
        viewVisibility,
      });

      events.record(pool, {
        type: events.EVENT_TYPES.VISIBILITY_CHANGED,
        userId: req.user.id,
        appId: app.id,
        metadata: {
          from: { collab: app.collab_visibility, view: app.view_visibility },
          to: { collab: collabVisibility, view: viewVisibility },
        },
      });

      log.info('apps', 'Visibility changed', {
        slug: app.slug, collabVisibility, viewVisibility, by: req.user.username,
      });
      res.json({ ok: true, collabVisibility, viewVisibility });
    } catch (err) {
      log.error('apps', 'Visibility change failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Edge-gate authorize hop (view-private apps) ─────────────────────
  //
  // Platform session cookies are host-only (deliberately — child apps
  // run user-authored code and must never see the platform credential),
  // so a direct visit to a view-private app's subdomain carries no
  // session for the edge gate (/__caddy/access in routes/internal.js)
  // to read. The gate bounces bare browser GETs here, to the apex,
  // where the session cookie IS present and authMiddleware has already
  // resolved req.user (or redirected to /login.html). We re-run the
  // standard view-level access check and, when allowed, send the
  // browser back to the app host with a 120s single-purpose grant the
  // gate exchanges for a per-host scoped access cookie. Non-members get
  // the same existence-hiding 404 every other surface returns.
  router.get('/__access/authorize', async (req, res) => {
    try {
      const parsed = appAccess.parseAppHost(req.query.host);
      if (!parsed) return res.status(404).send('Not found');
      const rawNext = typeof req.query.next === 'string' ? req.query.next : '/';
      const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

      const app = await appAccess.getAppForUser(
        pool, parsed.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).send('Not found');

      const grant = appAccess.mintAccessGrant(config.jwtSecret, {
        uid: req.user.id,
        appId: app.id,
        host: parsed.host,
      });
      return res.redirect(
        302,
        `https://${parsed.host}/__usernode_access`
          + `?grant=${encodeURIComponent(grant)}&next=${encodeURIComponent(next)}`
      );
    } catch (err) {
      log.error('apps', 'Edge authorize failed', { host: req.query.host, message: err.message });
      return res.status(500).send('Internal server error');
    }
  });

  // Delete an app (admin only)
  router.delete('/api/apps/:slug', async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];

      // Teardown container if running
      if (app.container_id) {
        const docker = require('../services/docker');
        await docker.stopAndRemove(app.container_id).catch(() => {});
        await docker.stopAndRemove(`usernode-app-${app.slug}`).catch(() => {});
      }

      // No Caddy route to remove — the wildcard site maps hostnames to
      // container names dynamically, so removing the container above
      // takes the app offline. The on-demand cert lingers harmlessly and
      // the ask endpoint stops vouching once the app row is deleted below.

      // Drop app database
      const dbManager = require('../services/db-manager');
      await dbManager.dropDatabase(dbManager.appDbName(app.slug)).catch(() => {});

      // Delete from DB (cascades to chat_messages, sessions, etc.)
      await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
      appAccess.invalidateVisibility(app.id, app.slug);

      log.info('apps', 'App deleted', { appId: app.id, slug: app.slug });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to delete app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Retry a failed app. Allowed for the app's creator or any admin, capped
  // at MAX_RETRY_COUNT per app to avoid a stuck app burning budget forever.
  router.post('/api/apps/:slug/retry', drainGuard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM apps WHERE slug = $1 AND status = 'error'",
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'No failed app found' });

      const appRow = rows[0];

      const allowed = req.user?.isAdmin || appRow.created_by === req.user?.id;
      if (!allowed) {
        return res.status(403).json({ error: 'Only the app creator or an admin can retry' });
      }

      if (appRow.retry_count >= MAX_RETRY_COUNT && !req.user.isAdmin) {
        return res.status(429).json({
          error: `Retry limit reached (${MAX_RETRY_COUNT}). Ask an admin to investigate.`,
        });
      }

      await pool.query(
        "UPDATE apps SET status = 'creating', retry_count = retry_count + 1 WHERE id = $1",
        [appRow.id]
      );

      createApp(config, appRow).catch(async (err) => {
        log.error('apps', 'Retry app creation failed', { appId: appRow.id, err: err.message });
        await pool.query(
          `UPDATE apps SET status = 'error' WHERE id = $1 AND status = 'creating'`,
          [appRow.id]
        ).catch(() => {});
      });
      scheduleCreationWatchdog(pool, appRow.id);

      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Retry failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/favorite', async (req, res) => {
    const { favorited } = req.body;
    if (typeof favorited !== 'boolean') {
      return res.status(400).json({ error: 'favorited must be a boolean' });
    }
    try {
      const showSelfHosted = !!req.user?.isAdmin || !!config.selfAppPublicVoting;
      const { rows: appRows } = await pool.query(
        `SELECT ${appAccess.ACCESS_COLUMNS} FROM apps WHERE slug = $1 AND (NOT self_hosted OR $2::boolean)`,
        [req.params.slug, showSelfHosted]
      );
      if (appRows.length === 0) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (!(await appAccess.checkAppAccess(pool, appRows[0], req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appId = appRows[0].id;
      if (favorited) {
        await pool.query(
          'INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [appId, req.user.id]
        );
      } else {
        await pool.query(
          'DELETE FROM app_favorites WHERE app_id = $1 AND user_id = $2',
          [appId, req.user.id]
        );
      }
      res.json({ ok: true, is_favorited: favorited });
    } catch (err) {
      log.error('apps', 'Failed to toggle favorite', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/activity', async (req, res) => {
    const { seconds } = req.body;

    if (!seconds || seconds < 0) {
      return res.status(400).json({ error: 'Invalid seconds value' });
    }

    try {
      const appRow = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!appRow) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appRows = [appRow];

      // `xmax = 0` is true only for a freshly INSERTed row; on the
      // ON CONFLICT update path xmax is the locking txid (non-zero). We
      // use it to emit the dapp_active_day analytics event exactly once
      // per (user, app, day) — the first heartbeat of the day — rather
      // than on every periodic activity ping, which would bloat the
      // append-only events log. This matches the one-row-per-active-day
      // shape the migrate.js backfill produces from app_activity.
      const { rows: activityRows } = await pool.query(
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
         VALUES ($1, $2, $3, CURRENT_DATE)
         ON CONFLICT (app_id, user_id, date)
         DO UPDATE SET seconds_spent = app_activity.seconds_spent + EXCLUDED.seconds_spent
         RETURNING (xmax = 0) AS inserted`,
        [appRows[0].id, req.user.id, Math.round(seconds)]
      );

      if (activityRows[0]?.inserted) {
        events.record(pool, {
          type: events.EVENT_TYPES.DAPP_ACTIVE_DAY,
          userId: req.user.id,
          appId: appRows[0].id,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to track activity', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { appRoutes, sweepStuckCreatingApps };
