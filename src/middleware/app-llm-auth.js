'use strict';

const crypto = require('crypto');
const { isPrivateIp } = require('./anthropic-proxy-auth');
const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');
const { clientIp } = require('../services/client-ip');

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
//
// `{ requireUser: true }` (issue #1195) additionally demands the caller's
// iframe identity JWT in x-usernode-user-token and verifies it against
// the RESOLVED app's audience — the same cross-app-replay closure
// appLlmAuth performs below, and the same shape appStorageAuth uses:
// app token + user token, no grant. Endpoints that read platform-wide
// state rather than the app's own row take this variant, so every read
// is attributable to a real signed-in user of THIS app and rate-limits
// can be keyed per (app, user) instead of per app.
//
// `{ allowUserTokenOnly: true }` (issue #1213, requires requireUser) lets
// a caller with NO app token authenticate with the user token alone —
// the staging-preview path for the user-directory endpoints: preview
// containers hold USERNODE_PLATFORM_API_URL but deliberately no app
// token, and the person reviewing a proposal already has an iframe
// token minted for that exact app. The app identity comes from the
// token's own `aud` claim (`usernode:app:<id>`), which is only TRUSTED
// after the signature verifies against that same audience — the
// unverified read merely picks which audience to pin, so a forged aud
// fails verification and a real token can only ever name the app it
// was minted for. When the app token IS present, the path is
// byte-identical to `{ requireUser: true }` alone. Used ONLY by the
// directory routes: the governance feed stays app-token-gated, because
// unreviewed preview code has no business reading it.

// The candidate app id in a token's audience claim, read WITHOUT
// verifying the signature. Never trust the result on its own — pass it
// to verifyAppIdentityToken, which re-pins the audience.
function unverifiedAudienceAppId(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')
    );
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    const m = /^usernode:app:(\d+)$/.exec(String(aud || ''));
    if (!m) return null;
    const id = parseInt(m[1], 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function appPlatformAuth(pool, opts = {}) {
  const requireUser = !!opts.requireUser;
  const allowUserTokenOnly = !!opts.allowUserTokenOnly && requireUser;
  return async function appPlatformAuthMiddleware(req, res, next) {
    const ip = clientIp(req);
    if (!isPrivateIp(ip)) {
      log.warn('app-platform-auth', 'Rejected non-private source IP', { ip, path: req.path });
      return res.status(403).json({ ok: false, code: 'forbidden_ip' });
    }

    const appToken = req.headers['x-usernode-app-token'];
    const userToken = req.headers['x-usernode-user-token'];
    const userTokenOnly = allowUserTokenOnly && !appToken
      && !!userToken && typeof userToken === 'string';

    if (!userTokenOnly
      && (!appToken || typeof appToken !== 'string' || !/^[0-9a-f]{64}$/.test(appToken))) {
      // Covers "neither credential" too — the error contract for a caller
      // that presents nothing is unchanged from before #1213.
      return res.status(401).json({ ok: false, code: 'missing_app_token' });
    }

    if (requireUser) {
      if (!userToken || typeof userToken !== 'string') {
        return res.status(401).json({ ok: false, code: 'missing_user_token' });
      }
      if (!process.env.IFRAME_JWT_PUBLIC_KEY) {
        log.error('app-platform-auth', 'IFRAME_JWT_PUBLIC_KEY not configured');
        return res.status(500).json({ ok: false, code: 'server_misconfigured' });
      }
    }

    let app;
    if (userTokenOnly) {
      // The signature is what authenticates the app identity; the
      // unverified aud only selects which audience the verifier pins.
      const candidateAppId = unverifiedAudienceAppId(userToken);
      if (!candidateAppId) {
        return res.status(401).json({ ok: false, code: 'bad_user_token' });
      }
      try {
        const { rows } = await pool.query(
          'SELECT id, slug FROM apps WHERE id = $1', [candidateAppId]
        );
        app = rows[0] ? { id: rows[0].id, slug: rows[0].slug } : null;
      } catch (err) {
        log.error('app-platform-auth', 'App row lookup failed', { err: err.message });
        return res.status(500).json({ ok: false, code: 'lookup_failed' });
      }
      if (!app) {
        return res.status(401).json({ ok: false, code: 'bad_app_token' });
      }
    } else {
      try {
        app = await resolveApp(pool, appToken);
      } catch (err) {
        log.error('app-platform-auth', 'App token lookup failed', { err: err.message });
        return res.status(500).json({ ok: false, code: 'lookup_failed' });
      }
      if (!app) {
        return res.status(401).json({ ok: false, code: 'bad_app_token' });
      }
    }

    let userId = null;
    if (requireUser) {
      // Verified against the RESOLVED app's audience — a token minted for
      // app A carries `usernode:app:<A>` and is rejected when presented
      // alongside app B's app token. On the user-token-only path the
      // "resolved" app came from the token's own aud, and this same
      // verification is what makes that identity authentic.
      let claims;
      try {
        claims = platformJwt.verifyAppIdentityToken(userToken, { appId: app.id });
      } catch (err) {
        return res.status(401).json({ ok: false, code: 'bad_user_token', message: err.message });
      }
      if (!claims || typeof claims.id !== 'number' || claims.scope) {
        return res.status(403).json({ ok: false, code: 'bad_user_token' });
      }
      userId = claims.id;
    }

    req.appPlatform = { appId: app.id, appSlug: app.slug, userId };
    if (userTokenOnly) req.appPlatform.viaUserToken = true;
    next();
  };
}

function appLlmAuth(pool, config) {
  return async function appLlmAuthMiddleware(req, res, next) {
    const ip = clientIp(req);
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

    if (!process.env.IFRAME_JWT_PUBLIC_KEY) {
      log.error('app-llm-auth', 'IFRAME_JWT_PUBLIC_KEY not configured');
      return res.status(500).json({ ok: false, code: 'server_misconfigured' });
    }

    // Resolve the app FIRST — the user token is verified against THIS
    // app's audience below, so the app identity has to be known before
    // the token is trusted.
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

    // Verify against the RESOLVED app's audience. This is what closes the
    // cross-app replay hole: under the old shared secret, app B's server
    // could take a user token minted for app A (any app the user visited)
    // and spend that user's AI budget through B's own app token. Now a
    // token minted for A carries audience `usernode:app:<A>` and is
    // rejected here when presented alongside B's app token.
    let claims;
    try {
      claims = platformJwt.verifyAppIdentityToken(userToken, { appId: app.id });
    } catch (err) {
      return res.status(401).json({ ok: false, code: 'bad_user_token', message: err.message });
    }
    // Belt-and-braces on the identity shape. `pur`/audience/algorithm are
    // already pinned by the verifier; this still rejects an infrastructure
    // token that somehow carried a scope claim.
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
