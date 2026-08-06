// Hosted MCP connector — OAuth 2.1 authorization-server primitives.
//
// These cover the parts that decide whether a credential is real, and they
// are deliberately pure (crypto only, no database, no Express) so they run
// anywhere: PKCE verification, the redirect-host allowlist that keeps this
// from being an open OAuth provider, scope normalisation, the opaque-secret
// shapes, and the bearer-header parse.
//
// The stateful halves (code single-use, refresh rotation, reuse revoking the
// chain) are enforced in SQL under a row lock in services/mcp-oauth.js and
// are asserted here against the statements themselves, since a Postgres
// instance is not available to the unit suite.
//
// Run with: node --test tests/mcp-oauth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mcpOauth = require('../src/services/mcp-oauth');
const {
  TOKEN_PREFIX,
  REFRESH_PREFIX,
  SUPPORTED_SCOPES,
} = require('../src/services/mcp-connect-constants');

const OAUTH_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/mcp-oauth.js'), 'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8'
);
const SCHEMA_SRC = fs.readFileSync(
  path.join(__dirname, '../src/db/schema.sql'), 'utf8'
);

const prodConfig = { cliAuthLocalMode: false };
const localConfig = { cliAuthLocalMode: true };

// ── PKCE ────────────────────────────────────────────────────────────────

test('PKCE S256 accepts the matching verifier and nothing else', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  assert.equal(mcpOauth.verifyPkce(verifier, challenge), true);
  assert.equal(mcpOauth.verifyPkce(crypto.randomBytes(32).toString('base64url'), challenge), false,
    'a different verifier is refused');
  assert.equal(mcpOauth.verifyPkce('', challenge), false, 'an empty verifier is refused');
  assert.equal(mcpOauth.verifyPkce(undefined, challenge), false, 'a missing verifier is refused');
  assert.equal(mcpOauth.verifyPkce(verifier, ''), false, 'a missing challenge is refused');
});

test('PKCE plain is not accepted — the challenge is never the verifier', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  // `plain` would mean challenge === verifier. S256-only means that fails.
  assert.equal(mcpOauth.verifyPkce(verifier, verifier), false);
  // And the advertised metadata must not claim otherwise.
  assert.match(ROUTE_SRC, /code_challenge_methods_supported: \['S256'\]/);
  assert.doesNotMatch(ROUTE_SRC, /code_challenge_methods_supported: \[[^\]]*'plain'/);
});

test('PKCE is mandatory at the consent step', () => {
  // No challenge, or a non-S256 method, must not produce an authorization
  // code at all — refusing only at the token endpoint would be too late.
  assert.match(
    ROUTE_SRC,
    /body\.code_challenge_method !== 'S256'[\s\S]{0,200}invalid_request/,
    'the consent POST refuses anything but S256'
  );
});

// ── Redirect allowlist ─────────────────────────────────────────────────

test('registration accepts only allowlisted https redirect hosts', () => {
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://platform.openai.com/oauth/callback',
  ]) {
    assert.equal(mcpOauth.isAllowedRedirectUri(uri, prodConfig), true, `${uri} is allowed`);
  }

  for (const uri of [
    'https://evil.example/callback',           // not on the list
    'https://claude.ai.evil.example/callback',  // suffix-confusion attempt
    'http://claude.ai/callback',                // plaintext
    'javascript:alert(1)',                      // not even a fetchable scheme
    'https://claude.ai/callback#fragment',      // fragments are refused
    'https://user:pw@claude.ai/callback',       // embedded credentials
    'not a url',
    '',
    null,
  ]) {
    assert.equal(mcpOauth.isAllowedRedirectUri(uri, prodConfig), false,
      `${String(uri)} is refused`);
  }
});

test('loopback redirects are local-dev only, never inferred from the request', () => {
  assert.equal(mcpOauth.isAllowedRedirectUri('http://localhost:5173/cb', prodConfig), false);
  assert.equal(mcpOauth.isAllowedRedirectUri('http://127.0.0.1:5173/cb', prodConfig), false);
  // Only an explicit deployment mode opens them.
  assert.equal(mcpOauth.isAllowedRedirectUri('http://localhost:5173/cb', localConfig), true);
  assert.equal(mcpOauth.isAllowedRedirectUri('http://127.0.0.1:5173/cb', localConfig), true);
});

test('the allowlist is configurable but defaults to the known connectors', () => {
  const previous = process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
  try {
    delete process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
    assert.deepEqual(
      mcpOauth.redirectHostAllowlist(prodConfig),
      ['claude.ai', 'claude.com', 'chatgpt.com', 'openai.com']
    );
    process.env.MCP_CONNECTOR_REDIRECT_HOSTS = 'example.test, other.test';
    assert.deepEqual(
      mcpOauth.redirectHostAllowlist(prodConfig),
      ['example.test', 'other.test']
    );
    assert.equal(mcpOauth.isAllowedRedirectUri('https://claude.ai/cb', prodConfig), false,
      'the configured list replaces the defaults rather than extending them');
  } finally {
    if (previous === undefined) delete process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
    else process.env.MCP_CONNECTOR_REDIRECT_HOSTS = previous;
  }
});

// ── Scopes ─────────────────────────────────────────────────────────────

test('scopes are narrow, canonical, and never the CLI api:access', () => {
  assert.deepEqual(SUPPORTED_SCOPES, ['usernode:apps:read', 'usernode:proposals:write']);
  assert.deepEqual(mcpOauth.normalizeScopes('usernode:apps:read'), ['usernode:apps:read']);
  // Requested out of order → stored in canonical order, so the array is
  // comparable wherever it is checked.
  assert.deepEqual(
    mcpOauth.normalizeScopes('usernode:proposals:write usernode:apps:read'),
    ['usernode:apps:read', 'usernode:proposals:write']
  );
  // Absent means "everything this server offers" (what both clients send).
  assert.deepEqual(mcpOauth.normalizeScopes(undefined), SUPPORTED_SCOPES);

  assert.equal(mcpOauth.normalizeScopes('api:access'), null, 'the CLI scope is not accepted');
  assert.equal(mcpOauth.normalizeScopes('usernode:apps:read usernode:apps:read'), null,
    'duplicates are refused rather than deduped');
  assert.equal(mcpOauth.normalizeScopes(['usernode:apps:read', 'admin']), null);
  assert.equal(mcpOauth.normalizeScopes(42), null);
});

// ── Secret shapes ──────────────────────────────────────────────────────

test('minted secrets are opaque, prefixed and shape-checked', () => {
  const access = mcpOauth.makeAccessToken();
  const refresh = mcpOauth.makeRefreshToken();
  assert.ok(access.startsWith(TOKEN_PREFIX));
  assert.ok(refresh.startsWith(REFRESH_PREFIX));
  assert.equal(mcpOauth.isCanonicalSecret(access, TOKEN_PREFIX), true);
  assert.equal(mcpOauth.isCanonicalSecret(refresh, REFRESH_PREFIX), true);

  // A refresh token must never be usable where an access token is expected.
  assert.equal(mcpOauth.isCanonicalSecret(refresh, TOKEN_PREFIX), false);
  assert.equal(mcpOauth.isCanonicalSecret(access, REFRESH_PREFIX), false);
  assert.equal(mcpOauth.isCanonicalSecret(`${TOKEN_PREFIX}short`, TOKEN_PREFIX), false);
  assert.equal(mcpOauth.isCanonicalSecret(`${TOKEN_PREFIX}${'!'.repeat(43)}`, TOKEN_PREFIX), false);
  assert.equal(mcpOauth.isCanonicalSecret(null, TOKEN_PREFIX), false);

  // Two mints never collide, and the hint reveals nothing usable.
  assert.notEqual(mcpOauth.makeAccessToken(), mcpOauth.makeAccessToken());
  const hint = mcpOauth.tokenHint(access);
  assert.ok(hint.length < access.length / 2, 'the hint is not the token');
  assert.ok(!access.includes(hint), 'the hint is not a substring of the token');
});

test('tokens are stored as SHA-256, never in the clear', () => {
  const token = mcpOauth.makeAccessToken();
  const hash = mcpOauth.hashSecret(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(mcpOauth.hashSecret(token), hash, 'hashing is deterministic');

  // Every lookup goes through the hash, so no statement may bind a raw
  // secret into a query.
  assert.doesNotMatch(OAUTH_SRC, /WHERE token_hash = \$1[^)]*\[\s*(?:refreshToken|token)\s*\]/);
  const schemaTokenTable = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf('CREATE TABLE IF NOT EXISTS mcp_tokens'));
  assert.match(schemaTokenTable.slice(0, 900), /token_hash\s+TEXT NOT NULL UNIQUE CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
});

// ── Bearer header parse ────────────────────────────────────────────────

test('exactly one well-formed Bearer credential is accepted', () => {
  const token = mcpOauth.makeAccessToken();
  const read = (headers) => mcpOauth.readBearerFromRawHeaders(headers);

  assert.deepEqual(read(['Authorization', `Bearer ${token}`]), { token });
  assert.deepEqual(read(['authorization', `Bearer ${token}`]), { token },
    'the header name is case-insensitive');

  assert.deepEqual(read([]), { error: 'missing_token' });
  assert.deepEqual(read(['Content-Type', 'application/json']), { error: 'missing_token' });
  // Duplicate credentials are ambiguous — refuse rather than pick one.
  assert.deepEqual(
    read(['Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`]),
    { error: 'invalid_token' }
  );
  assert.deepEqual(read(['Authorization', `Bearer ${token}, Bearer x`]), { error: 'invalid_token' });
  assert.deepEqual(read(['Authorization', `Basic ${token}`]), { error: 'invalid_token' });
  assert.deepEqual(read(['Authorization', `Bearer  ${token}`]), { error: 'invalid_token' },
    'whitespace ambiguity is refused');
  assert.deepEqual(read(['Authorization', 'Bearer svcli_' + 'a'.repeat(43)]), { error: 'invalid_token' },
    'a CLI token is not a connector token');
});

// ── Surface predicate ──────────────────────────────────────────────────

test('the staging gate covers every path the connector owns', () => {
  for (const p of [
    '/mcp',
    '/connect/authorize',
    '/api/connect/oauth/register',
    '/api/connect/oauth/token',
    '/api/connect/oauth/revoke',
    '/api/connect/oauth/authorize',
    '/api/connect/authorization',
    '/api/me/connectors',
    '/api/me/connectors/abc',
    '/api/me/github',
    '/api/me/github/connect',
    '/api/me/github/callback',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    assert.equal(mcpOauth.isConnectorSurfacePath(p), true, `${p} is gated`);
  }
  // …and nothing else. A gate that swallowed unrelated routes would 404
  // the platform on staging.
  for (const p of ['/', '/api/apps', '/api/me/cli-tokens', '/cli/authorize', '/health']) {
    assert.equal(mcpOauth.isConnectorSurfacePath(p), false, `${p} is untouched`);
  }
});

test('only the two read-only Settings reads survive on staging', () => {
  // These two exist so the Settings section is reviewable in a staging
  // preview from its ?demo=1 fixture. They never read real credential
  // state there (both backing stores are staging:private and empty).
  assert.equal(mcpOauth.isStagingReadableConnectorPath('GET', '/api/me/connectors'), true);
  assert.equal(mcpOauth.isStagingReadableConnectorPath('GET', '/api/me/github'), true);

  // Nothing that mints, presents or revokes a credential is exempt.
  for (const [method, p] of [
    ['POST', '/mcp'],
    ['GET', '/connect/authorize'],
    ['POST', '/api/connect/oauth/register'],
    ['POST', '/api/connect/oauth/token'],
    ['POST', '/api/connect/oauth/authorize'],
    ['GET', '/api/connect/authorization'],
    ['DELETE', '/api/me/connectors/abc'],
    ['DELETE', '/api/me/github'],
    ['GET', '/api/me/github/connect'],
    ['GET', '/api/me/github/callback'],
    ['GET', '/.well-known/oauth-authorization-server'],
    // Right path, wrong method: a write must not ride the read exemption.
    ['DELETE', '/api/me/connectors'],
    ['POST', '/api/me/github'],
  ]) {
    assert.equal(
      mcpOauth.isStagingReadableConnectorPath(method, p), false,
      `${method} ${p} stays 404 on staging`
    );
  }
});

// ── Stateful guarantees, asserted against the statements ───────────────

test('authorization codes are single-use, short-lived and bound', () => {
  const consume = OAUTH_SRC.slice(
    OAUTH_SRC.indexOf('async function consumeAuthorizationCode'),
    OAUTH_SRC.indexOf('// ── Tokens')
  );
  assert.match(consume, /FOR UPDATE/, 'redemption takes a row lock');
  assert.match(consume, /if \(row\.consumed_at\) return \{ error: 'invalid_grant', replay: true/);
  assert.match(consume, /expires_at\)\) return \{ error: 'invalid_grant' \}/);
  assert.match(consume, /row\.client_id !== clientId/, 'bound to the client');
  assert.match(consume, /row\.redirect_uri !== redirectUri/, 'bound to the redirect URI');
  assert.match(consume, /SET consumed_at = clock_timestamp\(\)/);
  // A replayed code means it leaked, so the whole grant dies rather than
  // just this exchange failing.
  assert.match(ROUTE_SRC, /consumed\.replay[\s\S]{0,200}revokeGrant/);
});

test('refresh rotation kills the whole chain on reuse', () => {
  const rotate = OAUTH_SRC.slice(OAUTH_SRC.indexOf('async function rotateRefreshToken'));
  assert.match(rotate, /FOR UPDATE/);
  assert.match(rotate, /if \(row\.revoked_at\)[\s\S]{0,200}revokeGrant\(client, row\.grant_id\)/,
    'presenting an already-rotated refresh token revokes every sibling');
  assert.match(rotate, /UPDATE mcp_tokens SET revoked_at = clock_timestamp\(\)\s*\n\s*WHERE grant_id = \$1/,
    'a successful rotation retires the previous pair');
  assert.match(rotate, /rotatedFrom: row\.id/, 'the chain is recorded');
});

test('every OAuth table is staging:private', () => {
  for (const table of [
    'mcp_clients', 'mcp_authorization_codes', 'mcp_tokens', 'mcp_auth_audit_events',
  ]) {
    assert.match(
      SCHEMA_SRC,
      new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`),
      `${table} is not cloned into staging`
    );
  }
  // The verified-link token gets the same treatment at column level.
  assert.match(
    SCHEMA_SRC,
    /COMMENT ON COLUMN users\.github_oauth_token_enc IS 'staging:private'/
  );
});
