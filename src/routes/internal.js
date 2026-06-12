'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');
const { internalAuth } = require('../middleware/internal-auth');
const log = require('../services/logger');
const worker = require('../services/worker');
const github = require('../services/github');
const { USERNODE_DOMAIN } = require('../services/caddy');
const appAccess = require('../services/app-access');

// On-demand-TLS gate for Caddy. Caddy GETs this before issuing a Let's
// Encrypt cert for a hostname it has never seen (see Caddyfile's
// `on_demand_tls { ask ... }`). We approve a host iff it maps to a real
// app row (`<slug>.<domain>`) or a live staging session whose stored
// staging_url is exactly that host (`<slug>--s<id>--<hash>.<domain>`).
// Everything else is refused so random `*.<domain>` probes can't burn
// Let's Encrypt issuance quota for the registered domain.
async function isKnownHost(pool, rawDomain) {
  const domain = String(rawDomain || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!domain) return false;
  // The apex is served by its own (non-on-demand) site, but allow it
  // defensively so a stray on-demand handshake for it never gets stuck.
  if (domain === USERNODE_DOMAIN) return true;

  const suffix = '.' + USERNODE_DOMAIN;
  if (!domain.endsWith(suffix)) return false;
  const label = domain.slice(0, -suffix.length);
  // Only single-level subdomains are routable (the wildcard matches one
  // label); reject anything with a further dot.
  if (!label || label.includes('.')) return false;

  // Production app: leftmost label is the app slug. (Staging labels carry
  // a `--s<id>--<hash>` suffix and so never collide with a real slug.)
  const appHit = await pool.query('SELECT 1 FROM apps WHERE slug = $1 LIMIT 1', [label]);
  if (appHit.rowCount) return true;

  // Staging preview: must match a session's current staging_url exactly,
  // so we don't vouch for stale (superseded) preview hostnames.
  const stagingHit = await pool.query(
    'SELECT 1 FROM chat_sessions WHERE staging_url = $1 LIMIT 1',
    ['https://' + domain]
  );
  return stagingHit.rowCount > 0;
}

// Worker → platform internal API surface.
//
// Mounted in server.js BEFORE the global authMiddleware so cookie auth
// doesn't apply. Auth is handled by the internalAuth middleware, which
// verifies a session-scoped JWT minted at warm-container bootstrap (see
// src/services/worker.js's mintWorkerJwt).
//
// These endpoints are the only path by which a worker container can
// affect anything outside its own filesystem. The worker carries no
// GitHub credentials at all — its sole write capability is whatever
// this router chooses to expose. Today:
//   - POST /api/internal/sessions/:id/push  →  git push the session's
//     canonical branch (looked up from the DB; the worker doesn't get
//     to pick).
//   - POST /api/internal/sessions/:id/pr    →  create a PR for the
//     session's canonical branch.
//
// Both endpoints are rate-limited per session to bound the blast
// radius of a runaway CC turn. A push storm at 60/min still gives us
// plenty of headroom for normal use (typical session pushes 1–5 times)
// while preventing 1000+/sec API hammering.

// ── Edge visibility gate (Caddy forward_auth) ─────────────────────────
//
// The Caddyfile's wildcard site forward_auths EVERY request to a child-
// app / staging subdomain here before proxying it to the app container.
// This closes the "direct <slug>.<domain> access isn't gated" hole for
// view-private apps: the platform UI checks were already in place, but
// anyone holding the URL could hit the container straight through Caddy.
//
// Decision tree (per request, in order):
//   1. host → slug (parseAppHost; staging previews inherit the prod
//      app's visibility). Unknown/unroutable host → 404.
//   2. view-public app → 200. This is the hot path: one 10s-TTL cached
//      lookup, no session work at all, so public apps stay ~zero-cost.
//   3. /__usernode_access callback → exchange a short-lived grant
//      (minted by the apex /__access/authorize route from the user's
//      real platform session) for a per-host scoped access cookie.
//   4. Scoped access cookie → verify + re-check membership → 200.
//   5. Platform iframe JWT (?token= query or x-usernode-token header,
//      the exact credential the shell already injects) → membership
//      check; header → 200 directly (API fetches always carry it);
//      query → 302-to-self that sets the scoped cookie so the page's
//      assets (which carry neither token nor header) pass too.
//   6. Nothing valid: browser GETs bounce to the apex authorize route
//      (which reads the existing session cookie — host-only, so it
//      never reaches subdomains directly); everything else gets the
//      same existence-hiding 404 the API routes use.
//
// The scoped cookie is a JWT bound to {host, appId, uid} — NOT the
// platform session token. Child apps run user-authored code, so the
// platform credential must never be readable on their hosts; the scoped
// cookie grants nothing beyond "may load this one host" and membership
// is still re-verified server-side on every request.

const ACCESS_COOKIE = '__usernode_access';
const ACCESS_COOKIE_TTL_S = 12 * 60 * 60; // 12h, re-minted via authorize after expiry
// Marker appended when we 302-to-self to set the cookie from an iframe
// token. If we see it again WITHOUT the cookie (cookies blocked), we
// serve the page anyway rather than redirect-looping — the app itself
// still auths via the token, only same-host asset caching degrades.
const RETRY_MARKER = '__ua';

function verifyJwt(token, secret) {
  try { return jwt.verify(token, secret); } catch { return null; }
}

function authorizeUrl(host, next) {
  return `https://${USERNODE_DOMAIN}/__access/authorize`
    + `?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
}

function parseUriQuery(uri) {
  try { return new URL('http://x' + uri).searchParams; } catch { return new URLSearchParams(); }
}

// `next` must be a same-host relative path — never absolute / protocol-
// relative — so the grant callback can't be used as an open redirect.
function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function internalRoutes(_config) {
  const router = Router();
  const pool = getPool(_config);

  router.get('/__caddy/access', async (req, res) => {
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
    const method = String(req.headers['x-forwarded-method'] || 'GET').toUpperCase();
    const uri = typeof req.headers['x-forwarded-uri'] === 'string' && req.headers['x-forwarded-uri']
      ? req.headers['x-forwarded-uri'] : '/';
    try {
      const parsed = appAccess.parseAppHost(rawHost);
      if (!parsed) return res.status(404).send('Not found');
      const { slug, host } = parsed;

      const vis = await appAccess.getHostVisibility(pool, slug);
      if (!vis) return res.status(404).send('Not found');
      if (!vis.viewPrivate) return res.status(200).send('ok');

      const query = parseUriQuery(uri);

      // 3. Grant callback from the apex authorize route. Handled before
      // the cookie so a fresh grant always re-mints (cookie refresh).
      // This path never reaches the app container — deny responses are
      // copied to the client by forward_auth, which is exactly how the
      // Set-Cookie + redirect get out.
      if (uri.startsWith('/__usernode_access')) {
        const grant = verifyJwt(query.get('grant') || '', _config.jwtSecret);
        if (grant && grant.t === 'app-access-grant' && grant.host === host
            && grant.appId === vis.appId
            && await appAccess.isViewMember(pool, vis.appId, grant.uid)) {
          const cookieToken = jwt.sign(
            { t: 'app-access', uid: grant.uid, appId: vis.appId, host },
            _config.jwtSecret,
            { expiresIn: ACCESS_COOKIE_TTL_S }
          );
          res.cookie(ACCESS_COOKIE, cookieToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: ACCESS_COOKIE_TTL_S * 1000,
          });
          return res.redirect(302, safeNext(query.get('next')));
        }
        // Bad/expired grant: restart the dance rather than dead-ending.
        return res.redirect(302, authorizeUrl(host, safeNext(query.get('next'))));
      }

      // 4. Scoped access cookie.
      const cookiePayload = verifyJwt(req.cookies?.[ACCESS_COOKIE] || '', _config.jwtSecret);
      if (cookiePayload && cookiePayload.t === 'app-access' && cookiePayload.host === host
          && cookiePayload.appId === vis.appId
          && await appAccess.isViewMember(pool, vis.appId, cookiePayload.uid)) {
        return res.status(200).send('ok');
      }

      // 5. Platform iframe JWT — the credential the shell injects on
      // iframe load (?token=) and that app frontends forward on fetches
      // (x-usernode-token). Same verification as the child apps' own
      // middleware (see app-conventions.md).
      const headerToken = typeof req.headers['x-usernode-token'] === 'string'
        ? req.headers['x-usernode-token'] : null;
      const queryToken = query.get('token');
      const iframeJwt = verifyJwt(queryToken || headerToken || '', _config.jwtSecret);
      if (iframeJwt && Number.isInteger(iframeJwt.id)
          && await appAccess.isViewMember(pool, vis.appId, iframeJwt.id)) {
        // WebSocket handshakes can't follow redirects — the 302 cookie-set
        // dance below would kill the upgrade. forward_auth copies the
        // original request headers (including Upgrade/Sec-WebSocket-*), so
        // detect the handshake and allow it as-is (the WS carries ?token=
        // for the app's own auth). Sec-WebSocket-Key is checked too in case
        // an intermediary strips the hop-by-hop Upgrade header.
        const isWsUpgrade = String(req.headers.upgrade || '').toLowerCase() === 'websocket'
          || !!req.headers['sec-websocket-key'];
        if (!queryToken || isWsUpgrade || query.get(RETRY_MARKER) === '1') {
          // Header-credentialed fetch, WS upgrade, or cookie-set retry that
          // came back cookieless: allow this request as-is.
          return res.status(200).send('ok');
        }
        // Initial iframe document load: set the scoped cookie and bounce
        // back to the same URL (+ loop-breaker marker) so the page's
        // asset requests pass via the cookie.
        const cookieToken = jwt.sign(
          { t: 'app-access', uid: iframeJwt.id, appId: vis.appId, host },
          _config.jwtSecret,
          { expiresIn: ACCESS_COOKIE_TTL_S }
        );
        res.cookie(ACCESS_COOKIE, cookieToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: ACCESS_COOKIE_TTL_S * 1000,
        });
        const sep = uri.includes('?') ? '&' : '?';
        return res.redirect(302, `${uri}${sep}${RETRY_MARKER}=1`);
      }

      // 6. No valid credential. Browser GETs go authorize via the apex
      // (where the platform session cookie lives); everything else gets
      // the existence-hiding 404 the API surfaces use.
      if (method === 'GET') {
        return res.redirect(302, authorizeUrl(host, uri));
      }
      return res.status(404).send('Not found');
    } catch (err) {
      // Fail closed: an error must never open a private app.
      log.error('internal-api', 'Caddy access check failed', {
        host: rawHost, err: err.message,
      });
      return res.status(503).send('unavailable');
    }
  });

  // Caddy on-demand-TLS permission check. Public (called by Caddy from
  // inside the Docker network, before any cert exists), GET, no side
  // effects. 200 authorizes issuance; 404 refuses. Keep it cheap — Caddy
  // caches the decision per host, and the lookups are single-row indexed
  // probes.
  router.get('/__caddy/ask', async (req, res) => {
    const domain = req.query.domain;
    try {
      const ok = await isKnownHost(pool, domain);
      if (ok) return res.status(200).send('ok');
      log.warn('internal-api', 'Caddy ask refused unknown host', { domain });
      return res.status(404).send('unknown host');
    } catch (err) {
      // Fail closed: a DB blip must not let arbitrary hosts mint certs.
      log.error('internal-api', 'Caddy ask check failed', { domain, err: err.message });
      return res.status(503).send('unavailable');
    }
  });

  const pushLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Push proxy rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.post(
    '/api/internal/sessions/:sessionId/push',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let session;
      try {
        const { rows } = await pool.query(
          `SELECT cs.id, cs.branch_name, cs.status, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        session = rows[0];
      } catch (err) {
        log.error('internal-api', 'Session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      if (!session.branch_name) {
        return res.status(400).json({ ok: false, code: 'no_branch' });
      }
      if (['closed', 'archived', 'merged', 'failed'].includes(session.status)) {
        return res.status(409).json({ ok: false, code: 'session_inactive', status: session.status });
      }

      // Defensive: re-confirm the repo is public before pushing. The
      // worker bootstrap guard catches most cases, but a user could
      // flip the repo to private mid-session. Keeping the worker's
      // push proxy public-only matches the import-time enforcement.
      const parsed = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.status(400).json({ ok: false, code: 'bad_repo_url' });
      }
      const [, owner, repo] = parsed;
      const privacy = await github.checkRepoPublic(owner, repo);
      if (!privacy.ok) {
        return res.status(502).json({ ok: false, code: privacy.code, message: privacy.message });
      }
      if (privacy.private) {
        return res.status(403).json({
          ok: false, code: 'private_repo',
          message: `${owner}/${repo} is private; Usernode supports public repos only.`,
        });
      }

      try {
        const { sha } = await worker.execPushFromWorker(sessionId, session.branch_name);
        return res.json({ ok: true, branch: session.branch_name, sha });
      } catch (err) {
        return res.status(502).json({
          ok: false,
          code: err.code || 'push_failed',
          message: err.message,
        });
      }
    }
  );

  // Read-only: list the session repo's OPEN GitHub issues. Backs the
  // worker's usernode-issues CLI (scout + build), giving Claude Code the
  // same list_github_issues capability the Mayor has in-process. Anonymous
  // public fetch with no credentials — caching, pagination, and PR-filtering
  // all live in github.fetchPublicIssues. GET because it mutates nothing;
  // accepts the session-scoped ISSUES_JWT via the same internalAuth gate.
  router.get(
    '/api/internal/sessions/:sessionId/issues',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issues)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        repoUrl = rows[0].repo_url || '';
      } catch (err) {
        log.error('internal-api', 'Issues session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      // Same .git-tolerant parse the push route uses. No repo → return the
      // well-formed empty-with-note shape so the agent gets a clean answer.
      const parsed = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.json({ ok: true, issues: [], truncatedList: false, note: 'no repo' });
      }
      const [, owner, repo] = parsed;
      // Clip verbose bodies for the agent's context — the cache carries
      // full bodies for the web route / Create-PR seeding (#158). The
      // marker names the CLI form that returns the full text on demand.
      const result = github.truncateIssueBodies(
        await github.fetchPublicIssues(owner, repo),
        (n) => `usernode-issues ${n}`
      );
      return res.json({ ok: true, ...result });
    }
  );

  // Read-only: fetch ONE GitHub issue with its FULL (untruncated) body.
  // Backs the worker's `usernode-issues <number>` CLI form — the escape
  // hatch for bodies the list route clips (#158). Same auth posture as
  // the list route (session-scoped ISSUES_JWT, both scout and build).
  // Always 200 with `{ ok: true, issue, note? }` once the session checks
  // pass — github.fetchPublicIssue never throws and resolves every
  // failure to `{ issue: null, note }`, so the CLI always prints
  // parseable JSON.
  router.get(
    '/api/internal/sessions/:sessionId/issues/:number',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issue)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        repoUrl = rows[0].repo_url || '';
      } catch (err) {
        log.error('internal-api', 'Issue session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      const parsed = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.json({ ok: true, issue: null, note: 'no repo' });
      }
      const [, owner, repo] = parsed;
      // fetchPublicIssue validates the number itself ('bad issue number').
      const result = await github.fetchPublicIssue(owner, repo, req.params.number);
      return res.json({ ok: true, ...result });
    }
  );

  // PR creation endpoint. Today's `git push` path doesn't strictly
  // need a worker-callable PR endpoint (the platform's sessions route
  // creates PRs as part of the per-turn finalization flow), but
  // exposing it here closes the last hole where the worker would need
  // a token to do something cross-cutting. It's a thin wrapper around
  // github.createPR; same per-session auth + rate limit as push.
  router.post(
    '/api/internal/sessions/:sessionId/pr',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      const { title, body } = req.body || {};
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ ok: false, code: 'bad_title' });
      }

      let session;
      try {
        const { rows } = await pool.query(
          `SELECT cs.id, cs.branch_name, cs.status, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, code: 'session_not_found' });
        session = rows[0];
      } catch (err) {
        return res.status(500).json({ ok: false, code: 'db_error', message: err.message });
      }

      if (!session.branch_name) {
        return res.status(400).json({ ok: false, code: 'no_branch' });
      }
      const parsed = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) return res.status(400).json({ ok: false, code: 'bad_repo_url' });
      const [, owner, repo] = parsed;

      try {
        const pr = await github.createPR(owner, repo, {
          branch: session.branch_name,
          title,
          body: body || '',
        });
        return res.json({ ok: true, number: pr.number, url: pr.html_url });
      } catch (err) {
        log.warn('internal-api', 'PR create via worker proxy failed', {
          sessionId, owner, repo, err: err.message,
        });
        return res.status(502).json({ ok: false, code: 'pr_failed', message: err.message });
      }
    }
  );

  return router;
}

module.exports = { internalRoutes, isKnownHost };
