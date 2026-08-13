// Hosted MCP connector — the /mcp endpoint's authentication contract.
//
// Four properties this file pins, because each one is the kind of thing
// that stays "working" while being wrong:
//
//   1. the whole surface 404s on staging, before anything reads a body or a
//      credential (a staging browser identity must never mint or use a
//      connector credential);
//   2. a missing/invalid/expired/revoked credential answers 401 with the
//      resource_metadata pointer — without it Claude.ai and ChatGPT have
//      nowhere to discover the authorization server and the connector just
//      appears broken;
//   3. the authorization audit row is written BEFORE anything dispatches,
//      and a failure to write it fails the request closed; and
//   4. /mcp never falls back to an ambient cookie.
//
// Run with: node --test tests/mcp-remote-auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8'
);
const SERVER_SRC = fs.readFileSync(
  path.join(__dirname, '../server.js'), 'utf8'
);
const SW_SRC = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const { classifyRequest, NO_FALLBACK_PAGES, SW_VERSION } = require('../public/sw.js');

test('the connector surface 404s on staging and when disabled', () => {
  const gate = SRC.slice(SRC.indexOf('function mcpConnectGate'), SRC.indexOf('// Where the tool handlers'));
  assert.match(gate, /if \(!isConnectorSurface\(req\)\) return next\(\);/);
  assert.match(
    gate,
    /staging \|\| !config\.cliAuthEnabled/,
    'gated on the deployment mode and validated configuration'
  );
  assert.match(gate, /res\.status\(404\)\.json\(\{ error: 'not_found' \}\)/);
  assert.match(gate, /Cache-Control', 'no-store/);
  // The single documented staging exemption: the two read-only Settings
  // status reads, so the section is reviewable there from its ?demo=1
  // fixture. Nothing that mints, presents or revokes a credential.
  assert.match(
    gate,
    /isStagingReadableConnectorPath\(req\.method, req\.path\)[\s\S]{0,60}return next\(\)/,
    'the exemption is method- and path-scoped'
  );
  // The gate must precede the routers that parse bodies or read tokens.
  const gateMount = SERVER_SRC.indexOf('mcpConnectGate(config)');
  const preAuthMount = SERVER_SRC.indexOf('mcpPreAuthRoutes(config)');
  assert.ok(gateMount > 0 && preAuthMount > gateMount,
    'the gate mounts before the connector routers');
});

test('/mcp mounts before cookie auth and the consent POST after it', () => {
  const preAuth = SERVER_SRC.indexOf('app.use(mcpPreAuthRoutes(config));');
  const authMw = SERVER_SRC.indexOf('app.use(authMiddleware(config));');
  const browser = SERVER_SRC.indexOf('app.use(mcpBrowserRoutes(config));');
  assert.ok(preAuth > 0 && authMw > 0 && browser > 0, 'all three are mounted');
  assert.ok(preAuth < authMw,
    'POST /mcp is bearer-only: it must never inherit browser session semantics');
  assert.ok(browser > authMw,
    'the consent decision needs a real session, so it mounts after cookie auth');
});

test('an unauthenticated /mcp answers 401 with the discovery pointer', () => {
  assert.match(
    SRC,
    /function bearerChallenge[\s\S]{0,400}resource_metadata="\$\{resourceMetadataUrl\(config\)\}"/,
    'the challenge carries resource_metadata'
  );
  assert.match(SRC, /res\.status\(401\)\.json\(\{ error \}\)/);
  // Every credential failure mode maps onto that challenge.
  assert.match(SRC, /if \(bearer\.error\) return bearerChallenge\(config, res, bearer\.error\)/);
  assert.match(SRC, /if \(auth\.error\) return bearerChallenge\(config, res, auth\.error\)/);
  const authFn = SRC.slice(SRC.indexOf('async function authenticateConnector'));
  assert.match(authFn, /if \(row\.revoked_at\) return \{ error: 'revoked_token' \}/);
  assert.match(authFn, /expires_at\)\) return \{ error: 'expired_token' \}/);
  assert.match(authFn, /if \(!rows\.length\) return \{ error: 'invalid_token' \}/);
});

test('the user is loaded from the database, never from the token', () => {
  const authFn = SRC.slice(SRC.indexOf('async function authenticateConnector'));
  assert.match(authFn, /SELECT id, username, is_admin, admin_readonly[\s\S]{0,80}FROM users WHERE id = \$1/,
    'role and identity come from `users` on every request');
  // Nothing carried on the token row may become an authorization property.
  assert.match(authFn, /isAdmin: !!user\.is_admin/);
  assert.doesNotMatch(authFn, /isAdmin: .*row\./);
});

test('the audit row is written before dispatch and fails closed', () => {
  const handler = SRC.slice(SRC.indexOf("router.post(MCP_PATH"), SRC.indexOf('// Stateless mode has no server-to-client stream'));
  const auditIdx = handler.indexOf("eventType: 'token_used'");
  const dispatchIdx = handler.indexOf('transport.handleRequest');
  assert.ok(auditIdx > 0 && dispatchIdx > auditIdx,
    'the token_used audit is inserted before the MCP request is handled');
  assert.match(
    handler,
    /catch \(err\)[\s\S]{0,200}audit insert failed[\s\S]{0,120}503/,
    'an audit we cannot write is an authorization we do not grant'
  );
  // last_used_at is non-authoritative metadata and must never gate the
  // decision or move backwards.
  assert.match(handler, /GREATEST\(COALESCE\(last_used_at, created_at\), clock_timestamp\(\)\)/);
});

test('rate limits run per IP and per token, and fail closed', () => {
  const handler = SRC.slice(SRC.indexOf("router.post(MCP_PATH"));
  const ipIdx = handler.indexOf("namespace: 'mcp-ip'");
  const bearerIdx = handler.indexOf('readConnectorBearer(req)');
  const tokenIdx = handler.indexOf("namespace: 'mcp-token'");
  assert.ok(ipIdx > 0 && ipIdx < bearerIdx, 'the IP bucket runs before any token lookup');
  assert.ok(tokenIdx > bearerIdx, 'the per-token bucket runs once the token is resolved');

  const bucket = SRC.slice(SRC.indexOf('async function enforceBucket'), SRC.indexOf('function jsonBody'));
  assert.match(bucket, /Retry-After/);
  assert.match(bucket, /429\).json\(\{ error: 'rate_limited' \}\)/);
  assert.match(bucket, /catch[\s\S]{0,300}503\)\.json\(\{ error: 'temporarily_unavailable' \}\)/,
    'an unavailable limiter stops the request rather than waving it through');
});

test('the transport is stateless and non-POST methods are refused', () => {
  assert.match(SRC, /sessionIdGenerator: undefined/,
    'stateless: a fresh server+transport per request, restart-safe');
  assert.match(SRC, /res\.on\('close'[\s\S]{0,120}transport\.close\(\)[\s\S]{0,80}server\.close\(\)/,
    'both are torn down with the response');
  assert.match(
    SRC,
    /router\.all\(MCP_PATH[\s\S]{0,240}405/,
    'GET/DELETE answer 405 with a JSON-RPC error body'
  );
});

test('/mcp is bearer-only and never reads a cookie', () => {
  const handler = SRC.slice(SRC.indexOf("router.post(MCP_PATH"), SRC.indexOf('router.all(MCP_PATH'));
  assert.doesNotMatch(handler, /req\.cookies/);
  assert.doesNotMatch(handler, /req\.user\b(?!\s*=)/);
  assert.match(handler, /readConnectorBearer\(req\)/);
  // And no browser CORS is enabled anywhere on the surface.
  assert.doesNotMatch(SRC, /Access-Control-Allow-Origin/);
});

test('the browser-session routes are CSRF-checked against the configured origin', () => {
  assert.match(
    SRC,
    /function browserCsrf[\s\S]{0,220}req\.headers\.origin !== config\.cliAuthOrigin/,
    'compared against configured configuration, never a request header'
  );
  assert.match(SRC, /sec-fetch-site'\][\s\S]{0,80}!== 'same-origin'/);
  // Every state-changing browser route uses it.
  for (const marker of [
    "router.post('/api/connect/oauth/authorize'",
    "router.delete('/api/me/connectors/:id'",
  ]) {
    const idx = SRC.indexOf(marker);
    assert.ok(idx > 0, `${marker} exists`);
    const body = SRC.slice(idx, idx + 900);
    assert.match(body, /browserCsrf\(config, req, res\)/, `${marker} is CSRF-checked`);
  }
});

test('the service worker hard-bypasses every connector path', () => {
  const origin = 'https://social-vibecoding.usernodelabs.org';
  for (const p of [
    '/mcp',
    '/api/connect/oauth/token',
    '/api/me/connectors',
    '/api/me/connectors/abc',
    '/api/me/social-identities',
    '/api/me/social-identities/github/connect',
    '/api/me/github',
    '/api/me/github/callback',
    '/api/me/x/callback',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
  ]) {
    assert.equal(
      classifyRequest('GET', `${origin}${p}`, 'application/json', 'cors', origin),
      'bypass',
      `${p} is never cached`
    );
    assert.equal(
      classifyRequest('GET', `${origin}${p}?demo=1`, 'application/json', 'cors', origin),
      'bypass',
      `${p} is never cached, query or not`
    );
  }
  // The consent page must not be answered from the cached SPA shell.
  assert.ok(NO_FALLBACK_PAGES.includes('/connect/authorize'));
  assert.equal(
    classifyRequest('GET', `${origin}/connect/authorize`, 'text/html', 'navigate', origin),
    'bypass'
  );
  // The version bump is what pushes the new classifications (and the new
  // credit-options.js) to already-installed clients.
  assert.notEqual(SW_VERSION, 'v6', 'the service-worker version was bumped');
  assert.match(SW_SRC, /const SW_VERSION = 'v7';/);
});
