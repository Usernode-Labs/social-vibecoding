const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { createApp } = require('../services/app-creator');
const caddy = require('../services/caddy');
const docker = require('../services/docker');
const github = require('../services/github');
const driftPoller = require('../services/main-drift-poller');
const { drainGuard } = require('../services/lifecycle');
const { appCreateLimiter } = require('../middleware/rate-limits');

// Local-dev URL fallback ("http://localhost:<hostport>" instead of the
// real "https://<slug>.<USERNODE_DOMAIN>") is opt-in via env. Previously
// any value of DOCKER_NETWORK flipped this on, but standalone production
// also has to set DOCKER_NETWORK (to point child apps at the platform's
// network) — so DOCKER_NETWORK is no longer a clean signal. Set
// USERNODE_LOCAL_DEV=1 in your local .env to get the localhost fallback.
const IS_LOCAL_DEV = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';

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
      const { rows } = await pool.query(`
        SELECT a.*,
          COALESCE(msg_counts.cnt, 0) AS message_count,
          COALESCE(activity.total_seconds, 0) AS total_seconds
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
        ORDER BY (COALESCE(msg_counts.cnt, 0) + COALESCE(activity.total_seconds, 0)) DESC, a.created_at DESC
      `);

      const apps = await Promise.all(rows.map(async (a) => {
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
    const { name, repoUrl } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'App name is required' });
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

      const { rows } = await pool.query(
        `INSERT INTO apps (name, slug, repo_url, created_by, status)
         VALUES ($1, $2, $3, $4, 'creating')
         RETURNING *`,
        [name.trim(), slug, repoUrlNormalized, req.user.id]
      );

      const appRow = rows[0];
      log.info('apps', repoUrlNormalized ? 'App imported (pending)' : 'App created (pending)', {
        appId: appRow.id,
        slug,
        ...(repoUrlNormalized ? { repoUrl: repoUrlNormalized } : {}),
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
      let url = null;
      if (appRow.status === 'running') {
        if (IS_LOCAL_DEV) {
          const containerName = `usernode-app-${appRow.slug}`;
          const hostPort = await docker.getHostPort(containerName, 3000);
          if (hostPort) url = `http://localhost:${hostPort}`;
        }
        if (!url) url = `https://${caddy.productionHostname(appRow.slug)}`;
      }
      res.json({ app: { ...appRow, url } });
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
      const info = await appVersion.getAppVersion(pool, req.params.slug);
      if (!info) return res.status(404).json({ error: 'App not found' });
      res.json({ ...info, deployProgress: appDeployStatus.read(req.params.slug) });
    } catch (err) {
      log.error('apps', 'Failed to get app version', { message: err.message });
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
        'SELECT id, slug, repo_url, main_sha FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
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

      // Remove Caddy route
      const hostname = caddy.productionHostname(app.slug);
      await caddy.removeRoute(hostname).catch(() => {});

      // Drop app database
      const dbManager = require('../services/db-manager');
      await dbManager.dropDatabase(dbManager.appDbName(app.slug)).catch(() => {});

      // Delete from DB (cascades to chat_messages, sessions, etc.)
      await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);

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

  router.post('/api/apps/:slug/activity', async (req, res) => {
    const { seconds } = req.body;

    if (!seconds || seconds < 0) {
      return res.status(400).json({ error: 'Invalid seconds value' });
    }

    try {
      const { rows: appRows } = await pool.query(
        'SELECT id FROM apps WHERE slug = $1',
        [req.params.slug]
      );

      if (appRows.length === 0) {
        return res.status(404).json({ error: 'App not found' });
      }

      await pool.query(
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
         VALUES ($1, $2, $3, CURRENT_DATE)
         ON CONFLICT (app_id, user_id, date)
         DO UPDATE SET seconds_spent = app_activity.seconds_spent + EXCLUDED.seconds_spent`,
        [appRows[0].id, req.user.id, Math.round(seconds)]
      );

      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to track activity', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { appRoutes, sweepStuckCreatingApps };
