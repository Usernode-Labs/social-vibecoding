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
  DELEGATED_TOKEN_PREFIX,
  DELEGATION_KINDS,
  DELEGATED_CLIENT_IDS,
  DELEGATION_MAX_TTL_SECONDS,
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
function makeDelegatedAccessToken() { return makeOpaqueSecret(DELEGATED_TOKEN_PREFIX); }
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

// ── Delegated grants (#2779) ───────────────────────────────────────────
//
// The platform's own agents reach the connector's tools on the user's behalf:
// the Mayor of an agent session, and the coding agent inside a change's
// worker. Nothing about that goes through consent — the user is already
// signed in to the platform that runs those agents — so a delegated grant is
// minted here, in-process, and is narrower than a consent in every direction
// that matters:
//
//   * an ACCESS row only. There is no refresh token to present, so a leaked
//     token dies at its expiry, which is at most one turn away
//     (DELEGATION_MAX_TTL_SECONDS);
//   * a synthetic client id that CLIENT_ID_RE refuses, so loadClient never
//     returns a client for it and the consent, token and registration
//     endpoints cannot act on it;
//   * a `kind` chosen here, never by a caller, which decides the tools
//     (services/mcp-audiences.js) and the routes (services/cli-api-policy.js)
//     the token reaches;
//   * a row in mcp_delegations that the bearer entry point joins on every
//     request, so revoking it — or closing the change it names — ends the
//     token without anything else having to run.
//
// A worker grant can read only; that is enforced here rather than trusted to
// the caller, because the worker runs the repository's own code with a shell.
function normalizeDelegation({ userId, kind, agentSessionId = null, changeId = null, appId = null, scopes, ttlSeconds }) {
  const positive = (value) => value == null || (Number.isSafeInteger(value) && value > 0);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('issueDelegatedAccess: userId is required');
  if (!DELEGATION_KINDS.includes(kind)) throw new Error(`issueDelegatedAccess: unknown kind ${kind}`);
  if (!positive(agentSessionId) || !positive(changeId) || !positive(appId)) {
    throw new Error('issueDelegatedAccess: ids must be positive integers');
  }
  if (kind === 'worker_read' && (changeId == null || appId == null)) {
    throw new Error('issueDelegatedAccess: a worker grant is bound to one change and its app');
  }
  const normalized = normalizeScopes(scopes == null ? [READ_SCOPE] : scopes);
  if (!normalized || !normalized.includes(READ_SCOPE)) {
    throw new Error('issueDelegatedAccess: scopes must include the read scope');
  }
  if (kind === 'worker_read' && normalized.includes(WRITE_SCOPE)) {
    throw new Error('issueDelegatedAccess: a worker grant is read-only');
  }
  const max = DELEGATION_MAX_TTL_SECONDS[kind];
  const ttl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : max;
  return {
    userId, kind, agentSessionId, changeId, appId,
    scopes: normalized,
    ttlSeconds: Math.max(30, Math.min(max, ttl)),
  };
}

async function issueDelegatedAccess(pool, options) {
  const grant = normalizeDelegation(options || {});
  const accessToken = makeDelegatedAccessToken();
  const grantId = makeGrantId();
  const clientId = DELEGATED_CLIENT_IDS[grant.kind];
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO mcp_delegations
         (grant_id, user_id, kind, agent_session_id, change_id, app_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               clock_timestamp(), clock_timestamp() + ($7 || ' seconds')::interval)
       RETURNING expires_at`,
      [
        grantId, grant.userId, grant.kind, grant.agentSessionId, grant.changeId,
        grant.appId, String(grant.ttlSeconds),
      ]
    );
    const expiresAt = rows[0].expires_at;
    const { rows: tokenRows } = await client.query(
      `INSERT INTO mcp_tokens
         (token_hash, token_hint, kind, user_id, client_id, grant_id, scopes,
          rotated_from, created_at, expires_at)
       VALUES ($1, $2, 'access', $3, $4, $5, $6::text[], NULL, clock_timestamp(), $7)
       RETURNING id`,
      [
        hashSecret(accessToken), tokenHint(accessToken), grant.userId, clientId,
        grantId, grant.scopes, expiresAt,
      ]
    );
    await insertAudit(client, {
      eventType: 'token_issued',
      occurredAt: new Date(),
      userId: grant.userId,
      actorUserId: grant.userId,
      accessTokenId: tokenRows[0].id,
      clientId,
      scopes: grant.scopes,
      metadata: { grant: 'delegated', kind: grant.kind },
    });
    return {
      accessToken,
      grantId,
      accessTokenId: tokenRows[0].id,
      kind: grant.kind,
      scopes: grant.scopes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });
}

// Revoke one delegated grant: the delegation row and every token minted
// under it, in one transaction, audited. Idempotent — revoking a grant that
// is already gone answers false and writes nothing. The turn that issued a
// grant calls this from its `finally`; the liveness join is what covers a
// caller that never gets there.
async function revokeDelegation(pool, { grantId, reason = 'turn_finished' }) {
  if (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) return false;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE mcp_delegations SET revoked_at = clock_timestamp()
        WHERE grant_id = $1 AND revoked_at IS NULL
        RETURNING user_id, kind`,
      [grantId]
    );
    if (!rows.length) return false;
    await revokeGrant(client, grantId);
    await insertAudit(client, {
      eventType: 'token_revoked',
      occurredAt: new Date(),
      userId: rows[0].user_id,
      actorUserId: rows[0].user_id,
      clientId: DELEGATED_CLIENT_IDS[rows[0].kind],
      scopes: [],
      metadata: { grant: 'delegated', kind: rows[0].kind, reason: String(reason).slice(0, 64) },
    });
    return true;
  });
}

// The grants the platform's own agents are handed turn by turn accumulate —
// one or two rows a turn — and are useless the moment they end. Remove the
// ones that ended more than `graceDays` ago, with their token rows, a bounded
// batch at a time. The audit trail keeps its own rows; it names the token by
// id only.
async function pruneDelegations(pool, { graceDays = 7, limit = 1000 } = {}) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `DELETE FROM mcp_delegations
        WHERE grant_id IN (
          SELECT grant_id FROM mcp_delegations
           WHERE COALESCE(revoked_at, expires_at) < clock_timestamp() - ($1 || ' days')::interval
           ORDER BY expires_at
           LIMIT $2)
        RETURNING grant_id`,
      [String(graceDays), limit]
    );
    if (!rows.length) return 0;
    await client.query(
      'DELETE FROM mcp_tokens WHERE grant_id = ANY($1::text[])',
      [rows.map((row) => row.grant_id)]
    );
    return rows.length;
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
  return pathname === '/api/me/connectors';
}

// Exactly one syntactically valid Bearer credential. Duplicate headers,
// comma-joined credentials, other schemes and whitespace ambiguity are all
// refused rather than normalised — a credential we had to guess at is one
// we should not accept.
//
// Two shapes are connector credentials: a consented client's `svmcp_…` and a
// delegated grant's `svmcd_…` (#2779). `delegated` reports which, so the
// staging gate can let the one through without touching the other; the
// token is honoured only if authenticateConnector agrees with the shape.
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
  const match = /^Bearer (svmc[pd]_[A-Za-z0-9_-]{43})$/.exec(values[0]);
  if (!match) return { error: 'invalid_token' };
  const delegated = match[1].startsWith(DELEGATED_TOKEN_PREFIX);
  if (!isCanonicalSecret(match[1], delegated ? DELEGATED_TOKEN_PREFIX : TOKEN_PREFIX)) {
    return { error: 'invalid_token' };
  }
  return { token: match[1], delegated };
}

// Does this request carry exactly one well-formed DELEGATED bearer? The
// staging and enablement gates ask this before anything reads a body or looks
// a credential up: a delegated grant is minted in-process by the deployment
// it is presented to, so it is the one connector credential that has to work
// where the consent surface is switched off.
function hasDelegatedBearer(rawHeaders) {
  const bearer = readBearerFromRawHeaders(rawHeaders);
  return !bearer.error && bearer.delegated === true;
}

// The request the staging and enablement gates let through for a delegated
// grant: POST /mcp carrying one well-formed `svmcd_…` bearer. Nothing else on
// the connector surface — metadata, registration, consent, token, revocation,
// the Settings list — is ever reachable that way.
function isDelegatedMcpRequest(method, pathname, rawHeaders) {
  return method === 'POST' && pathname === MCP_PATH && hasDelegatedBearer(rawHeaders);
}

module.exports = {
  READ_SCOPE,
  WRITE_SCOPE,
  SUPPORTED_SCOPES,
  isConnectorSurfacePath,
  isStagingReadableConnectorPath,
  readBearerFromRawHeaders,
  hasDelegatedBearer,
  isDelegatedMcpRequest,
  CLIENT_ID_RE,
  GRANT_ID_RE,
  CODE_CHALLENGE_RE,
  CODE_VERIFIER_RE,
  makeAccessToken,
  makeDelegatedAccessToken,
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
  normalizeDelegation,
  issueDelegatedAccess,
  revokeDelegation,
  pruneDelegations,
};
