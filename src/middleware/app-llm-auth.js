'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { isPrivateIp } = require('./anthropic-proxy-auth');
const log = require('../services/logger');

// Authenticates dapp → platform LLM-proxy requests (issue #34):
// POST /api/app-llm/v1/messages etc.
//
// Sibling of anthropic-proxy-auth.js — same private-IP gate (app
// containers are on the shared docker network; this endpoint is never
// needed from the public internet) — but a different credential pair:
//
//   x-usernode-app-token   — the app's opaque per-app credential
//       (apps.llm_proxy_token, random 64-hex injected as
//       USERNODE_LLM_PROXY_TOKEN at production deploy). NOT a JWT:
//       every dapp container holds the shared JWT_SECRET, so a
//       JWT-based app identity would be forgeable by any other app.
//       Staging containers never receive the token (the column is
//       staging:private and the staging deploy path doesn't inject
//       the env var), so unreviewed PR code is rejected here.
//
//   x-usernode-user-token  — the platform-minted iframe JWT the app's
//       frontend already forwards on every request (app-conventions.md
//       "Auth — iframe token injection"); the app's server passes it
//       through. Verified with the shared JWT_SECRET; claims give the
//       user. The 1h expiry is the same bound app auth lives with.
//
// On success the middleware loads the (app, user) grant row and
// requires status='active' — 403 { code: 'grant_required' } otherwise,
// which is the documented signal for an app to call
// usernode.requestLlmAccess() and retry.

// Grants are read with a short TTL cache (same 10s pattern as
// limits.js) so the steady-state per-call cost is a hash-map lookup.
// Grant mutations (routes/llm-grants.js) call invalidateGrant so
// revocation is effectively immediate.
const GRANT_CACHE_TTL_MS = 10_000;
const grantCache = new Map(); // `${appId}:${userId}` -> { grant, at }

function invalidateGrant(appId, userId) {
  if (appId != null && userId != null) {
    grantCache.delete(`${appId}:${userId}`);
  } else {
    grantCache.clear();
  }
}

async function loadGrant(pool, appId, userId) {
  const key = `${appId}:${userId}`;
  const cached = grantCache.get(key);
  if (cached && Date.now() - cached.at < GRANT_CACHE_TTL_MS) return cached.grant;
  const { rows } = await pool.query(
    `SELECT app_id, user_id, status, daily_cap_cents, allow_byok
       FROM app_llm_grants WHERE app_id = $1 AND user_id = $2`,
    [appId, userId]
  );
  const grant = rows[0] || null;
  grantCache.set(key, { grant, at: Date.now() });
  return grant;
}

// Look up the calling app by its opaque token. The SQL equality match
// finds the candidate row; the timingSafeEqual re-check makes the
// in-process comparison constant-time (belt and braces — the token is
// 256 bits of randomness, so the index lookup itself isn't a usable
// oracle, but the re-check costs nothing).
async function resolveApp(pool, token) {
  const { rows } = await pool.query(
    'SELECT id, slug, llm_proxy_token FROM apps WHERE llm_proxy_token = $1',
    [token]
  );
  const app = rows[0];
  if (!app || !app.llm_proxy_token) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(app.llm_proxy_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: app.id, slug: app.slug };
}

// App-token-only variant for the read-only app-platform API (issue
// #744): same private-IP gate and opaque-token resolution as
// appLlmAuth, but no user token and no grant check — the governance
// feed returns data every viewer of the app can already see in the
// vote panel, and the token → app-id resolution is itself the scoping
// (an app can only ever read its own feed; there is no slug parameter
// to tamper with). Staging containers never hold the token
// (staging:private column), so unreviewed PR code is rejected here
// exactly like at the LLM proxy.
function appPlatformAuth(pool) {
  return async function appPlatformAuthMiddleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (!isPrivateIp(ip)) {
      log.warn('app-platform-auth', 'Rejected non-private source IP', { ip, path: req.path });
      return res.status(403).json({ ok: false, code: 'forbidden_ip' });
    }

    const appToken = req.headers['x-usernode-app-token'];
    if (!appToken || typeof appToken !== 'string' || !/^[0-9a-f]{64}$/.test(appToken)) {
      return res.status(401).json({ ok: false, code: 'missing_app_token' });
    }

    let app;
    try {
      app = await resolveApp(pool, appToken);
    } catch (err) {
      log.error('app-platform-auth', 'App token lookup failed', { err: err.message });
      return res.status(500).json({ ok: false, code: 'lookup_failed' });
    }
    if (!app) {
      return res.status(401).json({ ok: false, code: 'bad_app_token' });
    }

    req.appPlatform = { appId: app.id, appSlug: app.slug };
    next();
  };
}

function appLlmAuth(pool, config) {
  return async function appLlmAuthMiddleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (!isPrivateIp(ip)) {
      log.warn('app-llm-auth', 'Rejected non-private source IP', { ip, path: req.path });
      return res.status(403).json({ ok: false, code: 'forbidden_ip' });
    }

    const appToken = req.headers['x-usernode-app-token'];
    if (!appToken || typeof appToken !== 'string' || !/^[0-9a-f]{64}$/.test(appToken)) {
      return res.status(401).json({ ok: false, code: 'missing_app_token' });
    }

    const userToken = req.headers['x-usernode-user-token'];
    if (!userToken || typeof userToken !== 'string') {
      return res.status(401).json({ ok: false, code: 'missing_user_token' });
    }

    if (!config.jwtSecret) {
      log.error('app-llm-auth', 'JWT_SECRET not configured');
      return res.status(500).json({ ok: false, code: 'server_misconfigured' });
    }

    let app;
    try {
      app = await resolveApp(pool, appToken);
    } catch (err) {
      log.error('app-llm-auth', 'App token lookup failed', { err: err.message });
      return res.status(500).json({ ok: false, code: 'lookup_failed' });
    }
    if (!app) {
      return res.status(401).json({ ok: false, code: 'bad_app_token' });
    }

    let claims;
    try {
      claims = jwt.verify(userToken, config.jwtSecret);
    } catch (err) {
      return res.status(401).json({ ok: false, code: 'bad_user_token', message: err.message });
    }
    // Require the iframe-token shape (a plain user identity). Reject
    // any scoped platform JWT (e.g. worker:session) — those identify
    // infrastructure, not a consenting user.
    if (!claims || typeof claims.id !== 'number' || claims.scope) {
      return res.status(403).json({ ok: false, code: 'bad_user_token' });
    }
    const userId = claims.id;

    let grant;
    try {
      grant = await loadGrant(pool, app.id, userId);
    } catch (err) {
      log.error('app-llm-auth', 'Grant lookup failed', {
        appId: app.id, userId, err: err.message,
      });
      return res.status(500).json({ ok: false, code: 'lookup_failed' });
    }
    if (!grant || grant.status !== 'active') {
      return res.status(403).json({
        ok: false,
        code: 'grant_required',
        message: 'The user has not granted this app access to their AI budget. ' +
          'Have the frontend call usernode.requestLlmAccess() and retry.',
      });
    }

    req.appLlm = {
      appId: app.id,
      appSlug: app.slug,
      userId,
      grant: {
        dailyCapCents: Number(grant.daily_cap_cents),
        allowByok: !!grant.allow_byok,
      },
    };
    next();
  };
}

module.exports = { appLlmAuth, appPlatformAuth, invalidateGrant };
