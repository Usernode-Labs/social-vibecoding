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
//     exact live native credential + bound token lookup. An unbound legacy
//     token is never authority.

'use strict';

const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { fail } = require('../routes/topochain/helpers');

const CREDENTIAL_REFERENCE_HEADER = 'Usernode-Credential-Reference';
const CREDENTIAL_GENERATION_HEADER = 'Usernode-Credential-Generation';
const CREDENTIAL_LEASE_EXPIRES_HEADER = 'Usernode-Credential-Lease-Expires-At';

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
// Bearer token -> sha256 hex -> exact protocol-2 credential lookup. A bearer
// row is not authority on its own: it must still be bound to one live native
// credential for the same user. Protocol-2 native establishment privately
// mints the only admitted ability: `session`.
//
// Constraint #12: mobile users' is_admin is always false and the mobile
// surface never trusts a client-supplied id — req.user.id always comes
// from the resolved token row, and isAdmin is hardcoded false here rather
// than read off the users row (defense in depth even if that invariant
// were ever violated in the data).
// Authorization: Bearer <token> -> the raw token string, or null.
function extractBearerToken(req) {
  const header = req.headers['authorization'];
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match ? match[1].trim() : null;
}

function publishCredentialLease(res, row) {
  res.setHeader(CREDENTIAL_REFERENCE_HEADER, row.credential_reference);
  res.setHeader(CREDENTIAL_GENERATION_HEADER, String(row.credential_generation));
  res.setHeader(
    CREDENTIAL_LEASE_EXPIRES_HEADER,
    new Date(row.expires_at).toISOString()
  );
}

async function renewCredentialLease(pool, authenticated, tokenHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Credential first, then token: revocation uses the same order before it
    // deletes the bearer. A concurrent logout therefore wins cleanly instead
    // of allowing a stale lookup to extend revoked authority.
    const { rows: credentialRows } = await client.query(
      `SELECT credential_reference, credential_generation, user_id,
              installation_id, mobile_auth_token_id, expires_at,
              expires_at <= NOW() + INTERVAL '89 days' AS renewal_due
         FROM native_session_credentials
        WHERE credential_reference = $1
          AND credential_generation = $2
          AND user_id = $3
          AND installation_id = $4
          AND mobile_auth_token_id = $5
          AND state = 'valid'
          AND expires_at > NOW()
        FOR UPDATE`,
      [
        authenticated.credential_reference,
        authenticated.credential_generation,
        authenticated.user_id,
        authenticated.installation_id,
        authenticated.id,
      ]
    );
    const credential = credentialRows[0];
    if (!credential) {
      await client.query('COMMIT');
      return null;
    }

    const { rows: tokenRows } = await client.query(
      `SELECT t.id
         FROM mobile_auth_tokens t
         JOIN native_session_credentials c
           ON c.credential_reference = $4
        WHERE t.id = $1
          AND t.user_id = $2
          AND t.token_hash = $3
          AND t.ability = 'session'
          AND t.expires_at > NOW()
          AND t.expires_at = c.expires_at
        FOR UPDATE OF t`,
      [
        authenticated.id,
        authenticated.user_id,
        tokenHash,
        authenticated.credential_reference,
      ]
    );
    const bearer = tokenRows[0];
    if (!bearer) {
      await client.query('COMMIT');
      return null;
    }

    // Another request may have renewed while this one waited for the lock.
    // Rechecking under the fence keeps writes coalesced to at most once/day.
    if (credential.renewal_due !== true) {
      await client.query('COMMIT');
      return { ...authenticated, expires_at: credential.expires_at };
    }

    const { rows: renewedRows } = await client.query(
      `UPDATE native_session_credentials
          SET expires_at = NOW() + INTERVAL '90 days'
        WHERE credential_reference = $1
          AND state = 'valid'
        RETURNING expires_at`,
      [authenticated.credential_reference]
    );
    const renewed = renewedRows[0];
    if (!renewed) {
      await client.query('COMMIT');
      return null;
    }

    const tokenUpdate = await client.query(
      `UPDATE mobile_auth_tokens t
          SET expires_at = c.expires_at, last_used_at = NOW()
         FROM native_session_credentials c
        WHERE t.id = $1
          AND t.user_id = $2
          AND t.token_hash = $3
          AND t.ability = 'session'
          AND c.credential_reference = $4`,
      [
        authenticated.id,
        authenticated.user_id,
        tokenHash,
        authenticated.credential_reference,
      ]
    );
    if (tokenUpdate.rowCount !== 1) {
      throw new Error('native_credential_lease_token_update_failed');
    }

    // Push installation UUIDs are intentionally independent from native key
    // installation ids. Renew only rows explicitly bound at registration to
    // this credential; never extend another device merely because it belongs
    // to the same user.
    await client.query(
      `UPDATE mobile_push_registrations r
          SET session_expires_at = c.expires_at, updated_at = NOW()
         FROM native_session_credentials c
        WHERE c.credential_reference = $1
          AND r.native_session_credential_reference = c.credential_reference
          AND r.session_expires_at < c.expires_at`,
      [authenticated.credential_reference]
    );

    await client.query('COMMIT');
    return { ...authenticated, expires_at: renewed.expires_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function mobileTokenAuth(config, { renewLease = true } = {}) {
  const pool = getPool(config);

  return async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) return fail(res, 401, 'Unauthenticated.');

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    let row;
    try {
      const { rows } = await pool.query(
        `SELECT t.id, c.user_id, t.ability, t.expires_at,
                c.credential_reference, c.credential_generation,
                c.installation_id, c.attempt_id,
                c.expires_at <= NOW() + INTERVAL '89 days' AS renewal_due,
                u.username
           FROM native_session_credentials c
           JOIN mobile_auth_tokens t
             ON t.id = c.mobile_auth_token_id AND t.user_id = c.user_id
           JOIN users u ON c.user_id = u.id
          WHERE t.token_hash = $1
            AND t.expires_at > NOW()
            AND c.state = 'valid'
            AND c.expires_at > NOW()
            AND c.expires_at = t.expires_at`,
        [tokenHash]
      );
      row = rows[0];
    } catch (err) {
      // A failed lookup says nothing about whether the presented credential
      // is valid. Keep the route fail-closed, but report an internal failure
      // rather than session invalidation: mobile clients treat a 401 as an
      // authoritative logout signal and clear their local application state.
      log.error('topochain-auth', 'mobileTokenAuth lookup failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }

    if (!row) {
      return fail(res, 401, 'Unauthenticated.');
    }

    if (row.ability !== 'session') {
      return fail(res, 403, 'A participant session token is required.');
    }

    if (renewLease && row.renewal_due === true) {
      try {
        row = await renewCredentialLease(pool, row, tokenHash);
      } catch (err) {
        log.error('topochain-auth', 'mobileTokenAuth lease renewal failed', {
          message: err.message,
        });
        return fail(res, 500, 'Internal server error.');
      }
      if (!row) return fail(res, 401, 'Unauthenticated.');
    }

    publishCredentialLease(res, row);

    req.user = { id: row.user_id, username: row.username, isAdmin: false };
    // Push registration mutations revalidate this credential inside their
    // transaction before copying its expiry bound. Never expose the raw token
    // or hash on the request object.
    req.mobileAuth = {
      tokenId: row.id,
      ability: row.ability,
      expiresAt: row.expires_at,
      credentialReference: row.credential_reference,
      credentialGeneration: row.credential_generation,
      attemptId: row.attempt_id,
    };

    return next();
  };
}

module.exports = { optionalSessionAuth, partnerApiKey, ingestApiKey, mobileTokenAuth };
