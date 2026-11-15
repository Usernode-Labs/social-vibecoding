'use strict';

const crypto = require('crypto');
const log = require('../services/logger');
const { clientIp, isDirectInternalCall } = require('../services/client-ip');

// Authenticates dapp → platform app-group requests (#6669): the call an app
// makes to keep a group of people its approval rules can name.
//
// Sibling of app-storage-auth.js, with ONE credential instead of two: the
// list is the app's own statement about who uses it, so there is no user
// token to verify. The credential is the app's opaque per-app
// apps.groups_api_token (random 64-hex, injected as USERNODE_GROUPS_TOKEN
// at production deploy). It is not a JWT: every dapp container holds the
// shared JWT_SECRET, so a JWT-based app identity would be forgeable by any
// other app.
//
// Staging containers never receive the token (the column is
// staging:private and the staging deploy path does not inject the env var),
// so unreviewed PR code is rejected here.

// Look up the calling app by its opaque token. The SQL equality match
// finds the candidate row; the timingSafeEqual re-check makes the
// in-process comparison constant-time (same stance as app-storage-auth).
async function resolveApp(pool, token) {
  const { rows } = await pool.query(
    'SELECT id, slug, groups_api_token FROM apps WHERE groups_api_token = $1',
    [token]
  );
  const app = rows[0];
  if (!app || !app.groups_api_token) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(app.groups_api_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: app.id, slug: app.slug };
}

function appGroupAuth(pool, config) {
  return async function appGroupAuthMiddleware(req, res, next) {
    if (!isDirectInternalCall(req)) {
      log.warn('app-group-auth', 'Rejected non-direct internal call',
        { ip: clientIp(req), path: req.path });
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
      log.error('app-group-auth', 'App token lookup failed', { err: err.message });
      return res.status(500).json({ ok: false, code: 'lookup_failed' });
    }
    if (!app) {
      return res.status(401).json({ ok: false, code: 'bad_app_token' });
    }

    req.appGroup = { appId: app.id, appSlug: app.slug };
    next();
  };
}

module.exports = { appGroupAuth, resolveApp };
