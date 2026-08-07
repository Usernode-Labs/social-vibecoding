'use strict';

// Hosted MCP connector — OAuth 2.1 authorization-server primitives.
//
// Structurally the twin of services/cli-auth.js, applied to the third-party
// connector flow: opaque secrets stored only as SHA-256, single-use PKCE
// authorization codes, rotating refresh tokens, and a durable audit row
// written BEFORE a protected request is dispatched.
//
// Everything here is pure data handling — no Express, no MCP SDK — so the
// token lifecycle can be unit-tested without a server.

const crypto = require('crypto');
const {
  READ_SCOPE,
  WRITE_SCOPE,
  SUPPORTED_SCOPES,
  TOKEN_PREFIX,
  REFRESH_PREFIX,
  AUTH_CODE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  DEFAULT_REDIRECT_HOSTS,
} = require('./mcp-connect-constants');

const SECRET_BODY_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CLIENT_ID_RE = /^svmc_[A-Za-z0-9_-]{22}$/;
const GRANT_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function makeOpaqueSecret(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function makeAccessToken() { return makeOpaqueSecret(TOKEN_PREFIX); }
function makeRefreshToken() { return makeOpaqueSecret(REFRESH_PREFIX); }
function makeAuthorizationCode() { return makeOpaqueSecret('svmca_'); }
function makeClientId() { return `svmc_${crypto.randomBytes(16).toString('base64url')}`; }
function makeGrantId() { return crypto.randomBytes(16).toString('base64url'); }

// Shape check for an opaque secret we minted. Prefix + exactly 43 base64url
// characters (32 random bytes). Anything else never reaches the database.
function isCanonicalSecret(value, prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  return SECRET_BODY_RE.test(value.slice(prefix.length));
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Display-only fingerprint for the Settings list. Never enough to
// reconstruct the credential.
function tokenHint(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

// PKCE S256 only. `plain` is not accepted anywhere: the metadata document
// advertises S256 alone and the token endpoint recomputes it here.
function verifyPkce(codeVerifier, storedChallenge) {
  if (typeof codeVerifier !== 'string' || !CODE_VERIFIER_RE.test(codeVerifier)) return false;
  if (typeof storedChallenge !== 'string' || !CODE_CHALLENGE_RE.test(storedChallenge)) return false;
  const computed = crypto.createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedChallenge, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// The deployment's accepted redirect hosts. Configurable so a self-hosted
// fork can point at whatever connector surfaces it actually uses, with the
// production defaults baked in.
function redirectHostAllowlist(config) {
  const raw = process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
  const hosts = raw
    ? raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_REDIRECT_HOSTS.slice();
  // Loopback is accepted ONLY in explicit local-development mode, never
  // because a request happened to arrive from localhost.
  if (config && config.cliAuthLocalMode) {
    hosts.push('localhost', '127.0.0.1');
  }
  return hosts;
}

// A redirect URI is acceptable when it parses, is https (or loopback http
// in local-dev), carries no fragment, and its host is exactly an allowlist
// entry or a subdomain of one.
function isAllowedRedirectUri(value, config) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  const hosts = redirectHostAllowlist(config);
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1';
  if (url.protocol === 'http:') {
    if (!(config && config.cliAuthLocalMode && loopback)) return false;
  } else if (url.protocol !== 'https:') {
    return false;
  }
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// Requested scopes must be a subset of what this server supports, with no
// duplicates and at least one entry. Returned in canonical order so the
// stored array is comparable.
function normalizeScopes(value) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/\s+/).filter(Boolean);
  else if (value == null) list = SUPPORTED_SCOPES.slice();
  else return null;
  if (!list.length) list = SUPPORTED_SCOPES.slice();
  const seen = new Set();
  for (const scope of list) {
    if (typeof scope !== 'string') return null;
    if (!SUPPORTED_SCOPES.includes(scope)) return null;
    if (seen.has(scope)) return null;
    seen.add(scope);
  }
  return SUPPORTED_SCOPES.filter((s) => seen.has(s));
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// Audit rows are written on the same connection as the decision they record,
// and (for token_used) BEFORE the request is dispatched — an authorization
// we cannot record is an authorization we do not grant.
async function insertAudit(client, {
  eventType,
  occurredAt,
  userId = null,
  actorUserId = null,
  accessTokenId = null,
  clientId,
  scopes = [],
  outcome = 'success',
  metadata = {},
}) {
  await client.query(
    `INSERT INTO mcp_auth_audit_events
       (event_type, occurred_at, user_id, actor_user_id, access_token_id,
        client_id, scopes, outcome, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9::jsonb)`,
    [
      eventType, occurredAt, userId, actorUserId, accessTokenId,
      clientId, scopes, outcome, JSON.stringify(metadata),
    ]
  );
}

// ── Client registration ────────────────────────────────────────────────
//
// Deduplicated on (client_name, sorted redirect_uris): Claude.ai
// re-registering on every reconnect must not accumulate rows forever.
async function registerClient(pool, { clientName, redirectUris }) {
  const sorted = redirectUris.slice().sort();
  const { rows: existing } = await pool.query(
    `SELECT client_id, client_name, redirect_uris, created_at
       FROM mcp_clients
      WHERE client_name = $1
        AND disabled_at IS NULL
        AND redirect_uris @> $2::text[] AND redirect_uris <@ $2::text[]
      ORDER BY id ASC LIMIT 1`,
    [clientName, sorted]
  );
  if (existing.length) return { ...existing[0], reused: true };

  const clientId = makeClientId();
  const { rows } = await pool.query(
    `INSERT INTO mcp_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, $3::text[])
     RETURNING client_id, client_name, redirect_uris, created_at`,
    [clientId, clientName, sorted]
  );
  return { ...rows[0], reused: false };
}

async function loadClient(pool, clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) return null;
  const { rows } = await pool.query(
    `SELECT client_id, client_name, redirect_uris, disabled_at
       FROM mcp_clients WHERE client_id = $1`,
    [clientId]
  );
  if (!rows.length || rows[0].disabled_at) return null;
  return rows[0];
}

// ── Authorization codes ────────────────────────────────────────────────

async function issueAuthorizationCode(pool, {
  clientId, userId, scopes, redirectUri, codeChallenge,
}) {
  const code = makeAuthorizationCode();
  const grantId = makeGrantId();
  await pool.query(
    `INSERT INTO mcp_authorization_codes
       (code_hash, client_id, user_id, scopes, redirect_uri, code_challenge,
        grant_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7,
             clock_timestamp(), clock_timestamp() + ($8 || ' seconds')::interval)`,
    [
      hashSecret(code), clientId, userId, scopes, redirectUri, codeChallenge,
      grantId, String(AUTH_CODE_TTL_SECONDS),
    ]
  );
  return { code, grantId };
}

// Single-use consumption under a row lock: two concurrent redemptions of the
// same code must not both succeed.
async function consumeAuthorizationCode(client, { code, clientId, redirectUri }) {
  const { rows } = await client.query(
    `SELECT id, client_id, user_id, scopes, redirect_uri, code_challenge,
            grant_id, expires_at, consumed_at, clock_timestamp() AS now
       FROM mcp_authorization_codes
      WHERE code_hash = $1
      FOR UPDATE`,
    [hashSecret(code)]
  );
  if (!rows.length) return { error: 'invalid_grant' };
  const row = rows[0];
  if (row.consumed_at) return { error: 'invalid_grant', replay: true, row };
  if (new Date(row.now) >= new Date(row.expires_at)) return { error: 'invalid_grant' };
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (row.redirect_uri !== redirectUri) return { error: 'invalid_grant' };
  await client.query(
    'UPDATE mcp_authorization_codes SET consumed_at = clock_timestamp() WHERE id = $1',
    [row.id]
  );
  return { row };
}

// ── Tokens ─────────────────────────────────────────────────────────────

async function issueTokenPair(client, { userId, clientId, grantId, scopes, rotatedFrom = null }) {
  const accessToken = makeAccessToken();
  const refreshToken = makeRefreshToken();
  const { rows: accessRows } = await client.query(
    `INSERT INTO mcp_tokens
       (token_hash, token_hint, kind, user_id, client_id, grant_id, scopes,
        rotated_from, created_at, expires_at)
     VALUES ($1, $2, 'access', $3, $4, $5, $6::text[], NULL,
             clock_timestamp(), clock_timestamp() + ($7 || ' seconds')::interval)
     RETURNING id`,
    [
      hashSecret(accessToken), tokenHint(accessToken), userId, clientId, grantId,
      scopes, String(ACCESS_TTL_SECONDS),
    ]
  );
  await client.query(
    `INSERT INTO mcp_tokens
       (token_hash, token_hint, kind, user_id, client_id, grant_id, scopes,
        rotated_from, created_at, expires_at)
     VALUES ($1, $2, 'refresh', $3, $4, $5, $6::text[], $7,
             clock_timestamp(), clock_timestamp() + ($8 || ' seconds')::interval)`,
    [
      hashSecret(refreshToken), tokenHint(refreshToken), userId, clientId, grantId,
      scopes, rotatedFrom, String(REFRESH_TTL_SECONDS),
    ]
  );
  return {
    accessToken,
    refreshToken,
    accessTokenId: accessRows[0].id,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

// Revoke every token minted from one consent. Used by refresh-reuse
// detection and by Settings → Disconnect; both want the whole chain gone,
// not just the one credential presented.
async function revokeGrant(client, grantId) {
  const { rowCount } = await client.query(
    `UPDATE mcp_tokens SET revoked_at = clock_timestamp()
      WHERE grant_id = $1 AND revoked_at IS NULL`,
    [grantId]
  );
  return rowCount;
}

// Refresh rotation. Presenting a refresh token that was already rotated
// away (consumed) is the classic stolen-token signal, so it kills the whole
// grant chain rather than merely refusing this one exchange.
async function rotateRefreshToken(pool, { refreshToken, clientId }) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, client_id, grant_id, scopes, expires_at, revoked_at,
              clock_timestamp() AS now
         FROM mcp_tokens
        WHERE token_hash = $1 AND kind = 'refresh'
        FOR UPDATE`,
      [hashSecret(refreshToken)]
    );
    if (!rows.length) return { error: 'invalid_grant' };
    const row = rows[0];
    if (row.client_id !== clientId) return { error: 'invalid_grant' };
    if (row.revoked_at) {
      // Reuse of a revoked/rotated refresh token: burn the chain.
      await revokeGrant(client, row.grant_id);
      return { error: 'invalid_grant', reuse: true };
    }
    if (new Date(row.now) >= new Date(row.expires_at)) return { error: 'invalid_grant' };

    // Rotate: this refresh token and its sibling access tokens die with the
    // exchange, so a leaked pair has a bounded life.
    await client.query(
      `UPDATE mcp_tokens SET revoked_at = clock_timestamp()
        WHERE grant_id = $1 AND revoked_at IS NULL`,
      [row.grant_id]
    );
    const issued = await issueTokenPair(client, {
      userId: row.user_id,
      clientId: row.client_id,
      grantId: row.grant_id,
      scopes: row.scopes,
      rotatedFrom: row.id,
    });
    await insertAudit(client, {
      eventType: 'token_issued',
      occurredAt: new Date(row.now),
      userId: row.user_id,
      actorUserId: row.user_id,
      accessTokenId: issued.accessTokenId,
      clientId: row.client_id,
      scopes: row.scopes,
      metadata: { grant: 'refresh_token' },
    });
    return { issued, scopes: row.scopes };
  });
}

// ── Request-shape helpers ──────────────────────────────────────────────
//
// These live here rather than in routes/mcp-remote.js so they carry no
// Express dependency and can be unit-tested directly; the router
// re-exports them.

const { MCP_PATH, CONSENT_PATH } = require('./mcp-connect-constants');

// Every path the connector feature owns. The staging gate 404s all of them
// wholesale, before anything reads a body or a credential.
function isConnectorSurfacePath(pathname) {
  if (typeof pathname !== 'string') return false;
  return pathname === MCP_PATH
    || pathname === CONSENT_PATH
    || pathname.startsWith('/api/connect/')
    || pathname === '/api/me/connectors'
    || pathname.startsWith('/api/me/connectors/')
    || pathname === '/api/me/github'
    || pathname.startsWith('/api/me/github/')
    || pathname === '/.well-known/oauth-authorization-server'
    || pathname.startsWith('/.well-known/oauth-protected-resource');
}

// The two read-only status reads the Settings screen makes. They are the
// ONLY connector paths that survive on staging, and only for GET.
//
// Everything that mints, presents or revokes a credential stays 404 there —
// a staging browser identity comes from an iframe token and must never be
// able to create or use a connector grant. But the Settings section itself
// has to be reviewable in a staging preview, and both backing tables are
// staging:private (so they are empty by construction). These two therefore
// answer with the ?demo=1 fixture, or an empty/unlinked payload, and never
// read real credential state.
function isStagingReadableConnectorPath(method, pathname) {
  if (method !== 'GET') return false;
  return pathname === '/api/me/connectors' || pathname === '/api/me/github';
}

// Exactly one syntactically valid Bearer credential. Duplicate headers,
// comma-joined credentials, other schemes and whitespace ambiguity are all
// refused rather than normalised — a credential we had to guess at is one
// we should not accept.
function readBearerFromRawHeaders(rawHeaders) {
  const values = [];
  const headers = Array.isArray(rawHeaders) ? rawHeaders : [];
  for (let i = 0; i < headers.length; i += 2) {
    if (String(headers[i]).toLowerCase() === 'authorization') {
      values.push(String(headers[i + 1] || ''));
    }
  }
  if (values.length === 0) return { error: 'missing_token' };
  if (values.length !== 1) return { error: 'invalid_token' };
  const match = /^Bearer (svmcp_[A-Za-z0-9_-]{43})$/.exec(values[0]);
  if (!match || !isCanonicalSecret(match[1], TOKEN_PREFIX)) {
    return { error: 'invalid_token' };
  }
  return { token: match[1] };
}

module.exports = {
  READ_SCOPE,
  WRITE_SCOPE,
  SUPPORTED_SCOPES,
  isConnectorSurfacePath,
  isStagingReadableConnectorPath,
  readBearerFromRawHeaders,
  CLIENT_ID_RE,
  GRANT_ID_RE,
  CODE_CHALLENGE_RE,
  CODE_VERIFIER_RE,
  makeAccessToken,
  makeRefreshToken,
  makeAuthorizationCode,
  makeClientId,
  makeGrantId,
  isCanonicalSecret,
  hashSecret,
  tokenHint,
  verifyPkce,
  redirectHostAllowlist,
  isAllowedRedirectUri,
  normalizeScopes,
  withTransaction,
  insertAudit,
  registerClient,
  loadClient,
  issueAuthorizationCode,
  consumeAuthorizationCode,
  issueTokenPair,
  revokeGrant,
  rotateRefreshToken,
};
