'use strict';

const crypto = require('node:crypto');

const SCOPE_COOKIE = 'usernode_api_scope';
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
  res.cookie(SCOPE_COOKIE, sessionCacheScope(token), {
    httpOnly: false, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', expires: new Date(expiresAt),
  });
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
