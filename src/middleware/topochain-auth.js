// Auth middlewares for the /api/v4 (topochain) surface. Unlike
// src/middleware/auth.js (the platform's own session gate, which redirects
// or 401s), every middleware here is scoped to ONE of the three non-admin
// v4 groups and implements that group's own auth story end to end — the
// admin group needs none of this; it reuses the platform's own
// adminMiddleware/requireAdminWrite (src/middleware/admin.js) directly, per
// architecture decision #2.
//
//   - optionalSessionAuth — public group (SPEC §4.2). Mirrors the
//     session-cookie resolution in src/middleware/auth.js but NEVER 401s:
//     SPEC 900 ("auth.optional... any failure is swallowed, so the request
//     never 401s") — a missing/expired/garbled cookie just leaves req.user
//     unset and the request proceeds anonymously.
//   - partnerApiKey — partner group (SPEC §4.3). Architecture decision #5:
//     strict compare of X-API-Key against a single configured secret.
//   - ingestApiKey — ingest group's two write endpoints (SPEC §4.4 says
//     "Auth: none", carried from v2 where the endpoints sat behind a
//     network boundary; on this platform they are internet-reachable, so
//     the pre-merge review asked for a shared-secret gate). Same strict-
//     compare shape as partnerApiKey, on its own header (X-Ingest-Key)
//     and its own secret, so partner and ingest credentials can rotate
//     independently.
//   - mobileTokenAuth — mobile group (SPEC §4.5). Bearer token -> sha256 ->
//     mobile_auth_tokens lookup; enforces the token-ability contract (SPEC
//     1588-1599).

'use strict';

const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { fail } = require('../routes/topochain/helpers');

// ─── optionalSessionAuth (SPEC §4.2, §4.9 "auth.optional", SPEC 900) ────
//
// Same `sessions JOIN users` lookup as src/middleware/auth.js, trimmed to
// the fields v4 public reads actually branch on (id + is_admin — "Admin"
// in the endpoint reference means an authenticated user with
// is_admin = true; only Resource classes branch on it). Every failure
// mode (no cookie, unknown token, expired session, DB error) is swallowed
// and falls through to `next()` with req.user left unset — this
// middleware must NEVER produce a response itself.
function optionalSessionAuth(config) {
  const pool = getPool(config);

  return async (req, _res, next) => {
    try {
      const cookieToken = req.cookies?.session;
      if (!cookieToken) return next();

      const { rows } = await pool.query(
        `SELECT s.user_id, s.expires_at, u.username, u.is_admin
           FROM sessions s JOIN users u ON s.user_id = u.id
          WHERE s.token = $1`,
        [cookieToken]
      );

      if (rows.length > 0 && new Date(rows[0].expires_at) >= new Date()) {
        req.user = {
          id: rows[0].user_id,
          username: rows[0].username,
          isAdmin: !!rows[0].is_admin,
        };
      }
    } catch (err) {
      // Swallow EVERYTHING (SPEC 900) — a DB hiccup on a public read must
      // degrade to "anonymous", never to a 401 or 500.
      log.debug('topochain-auth', 'optionalSessionAuth swallowed a failure', { message: err.message });
    }
    return next();
  };
}

// ─── partnerApiKey (architecture decision #5, SPEC 1320's api.key middleware) ─
//
// v1's `api.key` middleware compared X-API-Key against one shared secret
// with no per-client keys or scopes; v4 keeps that exact comparison and
// error shape (issuing per-partner keys/scopes is future work per the
// SPEC note, not this task). Order matters: an unconfigured server 500s
// BEFORE the key is even inspected (Global Constraints #5), so a deployment
// that forgot to set TOPOCHAIN_PARTNER_API_KEY fails loudly instead of
// silently rejecting every caller with a generic 401.
function partnerApiKey(config) {
  return (req, res, next) => {
    if (!config.topochainPartnerApiKey) {
      return fail(res, 500, 'API key authentication not configured.');
    }

    const provided = req.headers['x-api-key'];
    if (typeof provided !== 'string' || provided !== config.topochainPartnerApiKey) {
      return fail(res, 401, 'Invalid or missing API key.');
    }

    return next();
  };
}

// ─── ingestApiKey (ingest write gate — see the header note above) ────────
//
// Mirrors partnerApiKey exactly: unconfigured server 500s BEFORE the key
// is inspected (fail loudly, never silently reject every caller), then a
// strict compare of X-Ingest-Key against the one configured secret. The
// sole known caller is the observability-hub-receiver's sidecar sinks
// (usernode repo, tools/observability-hub-receiver), which must be
// configured with this header when it is cut over to the v4 paths.
function ingestApiKey(config) {
  return (req, res, next) => {
    if (!config.topochainIngestApiKey) {
      return fail(res, 500, 'Ingest key authentication not configured.');
    }

    const provided = req.headers['x-ingest-key'];
    if (typeof provided !== 'string' || provided !== config.topochainIngestApiKey) {
      return fail(res, 401, 'Invalid or missing ingest key.');
    }

    return next();
  };
}

// ─── mobileTokenAuth (SPEC §4.5, token model + errors at SPEC 1588-1599) ─
//
// Bearer token -> sha256 hex -> mobile_auth_tokens.token_hash lookup,
// joined to users for the fields data endpoints need. Two abilities exist
// (`session`, `set-password` — Global Constraints #4); callers pass the
// ability THEIR route requires via `{ ability }` (default 'session', the
// ability nearly every data/auth endpoint needs). A token of the wrong
// ability still authenticates (it's a real, unexpired token) but is
// refused with 403, never 401 — mirroring SPEC 1599's distinction between
// "not a valid credential" (401) and "valid credential, wrong scope" (403).
// `ability: null` (used by mobile-auth.js's POST /logout, SPEC 1734 "Auth:
// any valid token") skips the ability check entirely — any live token of
// EITHER ability authenticates. `forbiddenMessage` lets one call site
// override the generic ABILITY_MESSAGES text with a route-specific SPEC
// sentence (POST /set-password's 403 is "This token cannot set a
// password.", SPEC 1729 — distinct from the generic
// "A set-password token is required." every other set-password-gated
// route would get by default).
//
// Constraint #12: mobile users' is_admin is always false and the mobile
// surface never trusts a client-supplied id — req.user.id always comes
// from the resolved token row, and isAdmin is hardcoded false here rather
// than read off the users row (defense in depth even if that invariant
// were ever violated in the data).
const ABILITY_MESSAGES = {
  session: 'A participant session token is required.',
  'set-password': 'A set-password token is required.',
};

// Authorization: Bearer <token> -> the raw token string, or null if the
// header is absent/malformed. Shared by mobileTokenAuth itself and by
// mobile-auth.js routes (set-password, logout) that need to re-derive the
// SAME token's sha256 hash after authentication, to revoke exactly the
// one token presented — never every token the user holds.
function extractBearerToken(req) {
  const header = req.headers['authorization'];
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match ? match[1].trim() : null;
}

function mobileTokenAuth(config, { ability = 'session', forbiddenMessage } = {}) {
  const pool = getPool(config);

  return async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) return fail(res, 401, 'Unauthenticated.');

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    let row;
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.user_id, t.ability, t.expires_at, u.username
           FROM mobile_auth_tokens t JOIN users u ON t.user_id = u.id
          WHERE t.token_hash = $1`,
        [tokenHash]
      );
      row = rows[0];
    } catch (err) {
      // A lookup failure is not a valid credential either — fail closed
      // as 401 rather than leaking a 500 (no data endpoint here has a
      // legitimate reason to work without a resolvable token).
      log.error('topochain-auth', 'mobileTokenAuth lookup failed', { message: err.message });
      return fail(res, 401, 'Unauthenticated.');
    }

    if (!row || new Date(row.expires_at) < new Date()) {
      return fail(res, 401, 'Unauthenticated.');
    }

    if (ability !== null && row.ability !== ability) {
      return fail(res, 403, forbiddenMessage || ABILITY_MESSAGES[ability] || 'Wrong token type.');
    }

    req.user = { id: row.user_id, username: row.username, isAdmin: false };
    // Push registration mutations revalidate this credential inside their
    // transaction before copying its expiry bound. Never expose the raw token
    // or hash on the request object.
    req.mobileAuth = {
      tokenId: row.id,
      ability: row.ability,
      expiresAt: row.expires_at,
    };

    // Fire-and-forget last_used_at bump — never blocks/fails the request
    // over a bookkeeping write.
    pool.query('UPDATE mobile_auth_tokens SET last_used_at = NOW() WHERE id = $1', [row.id])
      .catch((err) => log.debug('topochain-auth', 'mobileTokenAuth last_used_at update failed', { message: err.message }));

    return next();
  };
}

module.exports = { optionalSessionAuth, partnerApiKey, ingestApiKey, mobileTokenAuth, extractBearerToken };
