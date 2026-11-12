'use strict';

const crypto = require('node:crypto');

const { scopeCookieName } = require('./browser-session-cookies');
const SCOPE_COOKIE = scopeCookieName();
const SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const EXPIRY_HEADER = 'X-Usernode-Cache-Expires';

// A partition label, never an authentication credential. Session tokens are
// independently random 256-bit secrets; exposing their domain-separated
// fingerprint neither exposes the token nor grants any server authority.
function sessionCacheScope(token) {
  return crypto.createHash('sha256').update('homeroom-api-cache-v1\0').update(token).digest('hex');
}

// Write the hint only when the session cookie itself is written. Updating it
// on ordinary reads would let an old request overwrite a newer login's hint.
function setSessionCacheCookie(res, token, expiresAt) {
  const secure = process.env.NODE_ENV === 'production' || res.req?.secure === true;
  res.cookie(scopeCookieName(process.env, secure), sessionCacheScope(token), {
    httpOnly: false, secure,
    sameSite: 'lax', path: '/', expires: new Date(expiresAt),
  });
  // Old tabs must lose their previous hint when a new server pairs the
  // protected label with a different login. They may refresh to regain
  // offline use; they must never keep using the former partition meanwhile.
  if (secure) res.clearCookie?.('usernode_api_scope', { path: '/' });
}

function stampApiIdentity(req, res, token, expiresAt) {
  // Non-HTTP consumers may use a minimal response adapter. Without these
  // headers the worker simply cannot cache the representation.
  if (!req.path.startsWith('/api/') || typeof res.setHeader !== 'function') return;
  res.setHeader(SCOPE_HEADER, sessionCacheScope(token));
  res.setHeader(EXPIRY_HEADER, new Date(expiresAt).toISOString());
}

// Also covers refusals and pre-auth routers. Route-specific no-store/public
// policies may tighten/replace this default. A private HTTP representation
// must never be reusable for another cookie or bearer credential (incl. 304).
function browserApiCachePolicy(req, res, next) {
  if (req.path.startsWith('/api/')) {
    res.vary('Cookie');
    res.vary('Authorization');
    res.vary('X-Usernode-Token');
    res.setHeader('Cache-Control', req.path.startsWith('/api/auth/')
      || req.headers.authorization || req.headers['x-usernode-token']
      ? 'private, no-store' : 'private');
  }
  next();
}

module.exports = { SCOPE_COOKIE, SCOPE_HEADER, EXPIRY_HEADER, sessionCacheScope,
  setSessionCacheCookie, stampApiIdentity, browserApiCachePolicy };
