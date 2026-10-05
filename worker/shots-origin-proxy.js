#!/usr/bin/env node
'use strict';

// Mandatory egress boundary for shots-browser MCP servers. The browsers send
// everything through here. The paired internal origins and the
// authenticated, public deployed-app catalog (which arrives after browser
// bootstrap) are reached as before. Anything else is the public internet: a
// web port, and a name whose every address is public, connected to at the
// address that was checked (shots-boundary.js). The network the worker runs
// in is never reachable from the browser.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseHostedOriginsFile } = require('./shots-hosted-origins');
const { vetPublicDestination } = require('./shots-boundary');
const shotsMemory = require('./shots-memory');

const DIAGNOSTIC_MARKER = '__USERNODE_SHOTS_BROWSER__ ';

let origins;
try {
  origins = new Set(JSON.parse(process.env.SHOTS_ALLOWED_ORIGINS || '[]').map((value) => new URL(value).origin));
} catch {
  origins = new Set();
}
if (origins.size !== 2) {
  process.stderr.write('Shots proxy requires exactly two allowed origins.\n');
  process.exit(1);
}
const authorities = new Set([...origins].map((origin) => {
  const url = new URL(origin);
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}));
const port = Number(process.env.SHOTS_PROXY_PORT || 17891);
const readyFile = process.env.SHOTS_PROXY_READY || '';
const originList = [...origins];
const hostedFile = process.env.SHOTS_HOSTED_ORIGINS_FILE || '';

// One listener per fixture persona, so the proxy knows whose browser a
// request comes from: Chromium's --proxy-server cannot carry credentials, so
// the port is the identity. run-cc.sh names the ports; the verifiers that
// start this proxy without them get the single shared listener, as before.
const PERSONAS = Object.freeze(['member', 'read_only_admin', 'full_admin']);
const PERSONA_TOKEN_ENV = Object.freeze({
  member: 'SHOTS_MEMBER_TOKEN',
  read_only_admin: 'SHOTS_ADMIN_TOKEN',
  full_admin: 'SHOTS_FULL_ADMIN_TOKEN',
});
function personaPorts() {
  let parsed;
  try { parsed = JSON.parse(process.env.SHOTS_PROXY_PERSONA_PORTS || '{}'); } catch { return {}; }
  const ports = {};
  for (const persona of PERSONAS) {
    const value = parsed?.[persona];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 65535) ports[persona] = value;
  }
  return ports;
}
// A hosted app is told who is signed in only by the `?token=` on its first
// iframe load, which its frontend keeps in memory and forwards as
// x-usernode-token; the app's server refuses its own page without one
// ("Open this app inside Homeroom", services/template.js). The shots browser
// signs in once, so every later page the shots agent opens arrived with no
// token. Each persona's listener adds that persona's token to requests for
// the pair's two origins instead. The tokens are the run's non-loginable
// fixture identities, already in this process's environment from the
// runner; they stay here: the header is added after the browser has sent
// the request, so the page, the browser and the shots agent never see it,
// and nothing below logs a header.
const personaTokens = {};
for (const persona of PERSONAS) {
  const value = String(process.env[PERSONA_TOKEN_ENV[persona]] || '');
  if (/^[A-Za-z0-9._-]{1,8192}$/.test(value)) personaTokens[persona] = value;
}
let hostedOrigins = new Set();
let hostedAuthorities = new Set();
let hostedLoaded = !hostedFile;
let hostedFailureReported = false;

function loadHostedOrigins() {
  if (hostedLoaded) return;
  try {
    const approved = parseHostedOriginsFile(hostedFile, originList[0], originList[1]);
    hostedOrigins = new Set(approved);
    hostedAuthorities = new Set(approved.map((origin) => {
      const url = new URL(origin);
      return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
    }));
    hostedLoaded = true;
    diagnostic({ kind: 'hosted_app_allowlist', outcome: 'loaded', count: approved.length });
  } catch (error) {
    // Bootstrap creates this file after the proxy starts. Any other read or
    // validation failure keeps the external origin boundary closed.
    if (error?.code === 'ENOENT') return;
    if (!hostedFailureReported) {
      diagnostic({ kind: 'hosted_app_allowlist', outcome: 'invalid' });
      hostedFailureReported = true;
    }
  }
}

function permittedOrigin(origin) {
  if (origins.has(origin)) return true;
  loadHostedOrigins();
  return hostedOrigins.has(origin);
}

function permittedAuthority(authority) {
  if (authorities.has(authority)) return true;
  loadHostedOrigins();
  return hostedAuthorities.has(authority);
}
// A child app's pages load the platform's bridge, native kit and Tailwind
// build from their own origin, and the production edge routes those paths to
// the platform. Shots deployments have no edge in front of them, so these
// requests would reach the app's SPA fallback, come back as HTML, and leave
// the page unstyled. Route them to the platform instead, for a child-app pair
// (SHOTS_PLATFORM_ASSETS=1) or a hosted app; the platform's own pairs
// serve the copies their revision carries. GET/HEAD of these prefixes only,
// with no cookie or credential of the page's.
const PLATFORM_ASSET_PREFIXES = Object.freeze(['/usernode-bridge/', '/usernode-native/', '/usernode-tailwind/']);
const platformAssetsOrigin = (() => {
  try {
    const url = new URL(String(process.env.PLATFORM_URL || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
})();
const childAppPair = process.env.SHOTS_PLATFORM_ASSETS === '1';
// A legacy child app still on the Tailwind CDN script renders with it in
// staging and production. It is an ordinary public host now; its use is
// still counted, since apps are meant to move off it.
const LEGACY_TAILWIND_CDN = 'cdn.tailwindcss.com:443';
const FORWARDED_ASSET_HEADERS = Object.freeze(['accept', 'accept-encoding', 'if-none-match', 'if-modified-since', 'user-agent']);
const RETURNED_ASSET_HEADERS = Object.freeze(['content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'last-modified']);

function platformAssetPath(pathname) {
  if (!PLATFORM_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return !decoded.split('/').includes('..') && !decoded.includes('\\') && !decoded.includes('\0');
}

function routesPlatformAsset(target, method) {
  if (!platformAssetsOrigin || !['GET', 'HEAD'].includes(method) || !platformAssetPath(target.pathname)) return false;
  if (origins.has(target.origin)) return childAppPair;
  return hostedOrigins.has(target.origin);
}

function forwardPlatformAsset(req, res, target, side) {
  const headers = {};
  for (const name of FORWARDED_ASSET_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  const source = new URL(`${target.pathname}${target.search}`, platformAssetsOrigin);
  const transport = source.protocol === 'https:' ? https : http;
  const upstream = transport.request(source, { method: req.method, headers }, (assetResponse) => {
    const status = assetResponse.statusCode || 502;
    diagnostic({ kind: 'platform_asset', side, httpStatus: status });
    const returned = {};
    for (const name of RETURNED_ASSET_HEADERS) {
      if (assetResponse.headers[name] != null) returned[name] = assetResponse.headers[name];
    }
    res.writeHead(status, returned);
    assetResponse.pipe(res);
  });
  upstream.on('error', () => {
    diagnostic({ kind: 'platform_asset', side, httpStatus: 502 });
    reject(res, 502);
  });
  upstream.end();
}

// The app's tile on Homeroom's home screen, which a pair's copies do not
// serve: each side's address answers this path with that side's tile, drawn
// by the platform from the side's own dapp.json (services/shots-home-tile.js)
// and fetched with this run's shots token, which never reaches the page.
const HOME_TILE_PATH = '/__shots/home-tile';
const RETURNED_TILE_HEADERS = Object.freeze(['content-type', 'content-length', 'cache-control',
  'content-security-policy', 'x-content-type-options']);
const shotsRunId = String(process.env.SHOTS_RUN_ID || '');
const shotsJwt = String(process.env.SHOTS_JWT || '');

function forwardHomeTile(req, res, side) {
  if (!['GET', 'HEAD'].includes(req.method)) return reject(res, 405);
  if (!platformAssetsOrigin || !/^[0-9a-f]{32}$/.test(shotsRunId) || !shotsJwt) return reject(res, 404);
  const source = new URL(`/api/internal/shots/${shotsRunId}/home-tile/${side}`, platformAssetsOrigin);
  const transport = source.protocol === 'https:' ? https : http;
  const upstream = transport.request(source, {
    method: req.method,
    headers: { authorization: `Bearer ${shotsJwt}`, accept: 'text/html' },
  }, (tileResponse) => {
    const status = tileResponse.statusCode || 502;
    diagnostic({ kind: 'home_tile', side, httpStatus: status });
    const returned = {};
    for (const name of RETURNED_TILE_HEADERS) {
      if (tileResponse.headers[name] != null) returned[name] = tileResponse.headers[name];
    }
    res.writeHead(status, returned);
    tileResponse.pipe(res);
  });
  upstream.on('error', () => {
    diagnostic({ kind: 'home_tile', side, httpStatus: 502 });
    reject(res, 502);
  });
  upstream.end();
}

let documentOrdinal = 0;
const controlToken = String(process.env.SHOTS_PROXY_CONTROL_TOKEN || '');
const controlPath = '/__usernode_shots_control/request-failure';
const controlledFailures = new Set();
let controlledFailureHits = 0;

function validApiPath(value) {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/api/')
      || value.includes('*') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value, 'http://shots.invalid');
    return !url.hash && `${url.pathname}${url.search}` === value;
  } catch { return false; }
}

function validControlToken(value) {
  if (!/^[0-9a-f]{64}$/.test(controlToken) || typeof value !== 'string'
      || value.length !== controlToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(controlToken));
}

function controlRequest(req, res) {
  if (req.method !== 'POST' || !validControlToken(req.headers['x-shots-control-token'])) {
    return reject(res);
  }
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 1024) req.destroy();
  });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(data); } catch { return reject(res, 400); }
    if (!body || Object.keys(body).sort().join(',') !== 'enabled,path'
        || typeof body.enabled !== 'boolean' || !validApiPath(body.path)) return reject(res, 400);
    if (body.enabled) controlledFailures.add(body.path);
    else controlledFailures.delete(body.path);
    diagnostic({ kind: 'controlled_failure_set', enabled: body.enabled });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, enabled: body.enabled, hitCount: controlledFailureHits }));
  });
}

function diagnostic(event) {
  // Only fixed-shape metadata leaves the proxy. Never log URL, query,
  // headers, document content, cookies, or upstream error messages.
  try { process.stderr.write(`${DIAGNOSTIC_MARKER}${JSON.stringify(event)}\n`); }
  catch { /* Observability cannot affect the browser's network path. */ }
}

function reject(socketOrResponse, code = 403) {
  if (typeof socketOrResponse.writeHead === 'function') {
    socketOrResponse.writeHead(code, { 'content-type': 'text/plain', connection: 'close' });
    socketOrResponse.end('Blocked by shots origin policy.');
  } else {
    socketOrResponse.end(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`);
  }
}

// Only a hosted-app pair, only the pair's own two origins (never a hosted
// production app's), and never over a token the page sent itself.
function identityToken(persona, target, headers) {
  if (!persona || !childAppPair || !origins.has(target.origin)) return null;
  if (headers['x-usernode-token']) return null;
  return personaTokens[persona] || null;
}

// What kind of host a refused destination was, as one of a few fixed words:
// one of the pair's or the catalog's own hosts on another port or scheme
// (a browser trying https:// first, say), a loopback address, or anything
// else. Never the host itself.
function hostKind(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const hostOf = (origin) => { try { return new URL(origin).hostname.replace(/^\[(.*)\]$/, '$1'); } catch { return null; } };
  if (originList.some((origin) => hostOf(origin) === host)) return 'pair_host';
  if ([...hostedOrigins].some((origin) => hostOf(origin) === host)) return 'catalog_host';
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'loopback';
  return 'other';
}

// A destination outside the pair and the catalog: reachable only when public.
// The refusal is counted by reason and kind of host, never with the destination.
async function vetOutside(hostname, targetPort) {
  const vetted = await vetPublicDestination(hostname, targetPort);
  if (!vetted.ok) diagnostic({ kind: 'egress_blocked', blockReason: vetted.reason, hostKind: hostKind(hostname) });
  return vetted;
}

const handleRequest = (persona) => (req, res) => {
  handleRequestAsync(persona, req, res).catch(() => { if (!res.headersSent) reject(res, 502); else res.destroy(); });
};

async function handleRequestAsync(persona, req, res) {
  // The control plane answers on the shared listener only.
  if (req.url === controlPath) return persona ? reject(res) : controlRequest(req, res);
  let target;
  try {
    target = new URL(req.url);
  } catch {
    try { target = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { return reject(res, 400); }
  }
  // The pair and the catalog are reached by name, as they always were; any
  // other destination only at the public address that was checked.
  let vetted = null;
  if (!permittedOrigin(target.origin)) {
    if (!['http:', 'https:'].includes(target.protocol)) return reject(res);
    vetted = await vetOutside(target.hostname,
      Number(target.port) || (target.protocol === 'https:' ? 443 : 80));
    if (!vetted.ok) return reject(res);
  }
  if (origins.has(target.origin) && req.method === 'GET'
      && controlledFailures.has(`${target.pathname}${target.search}`)) {
    controlledFailureHits += 1;
    diagnostic({ kind: 'controlled_failure_hit',
      side: target.origin === originList[0] ? 'base' : 'head', hitOrdinal: controlledFailureHits });
    return res.destroy();
  }
  const side = target.origin === originList[0] ? 'base'
    : target.origin === originList[1] ? 'head' : vetted ? 'outside' : 'hosted';
  if ((side === 'base' || side === 'head') && target.pathname === HOME_TILE_PATH) {
    return forwardHomeTile(req, res, side);
  }
  if (routesPlatformAsset(target, req.method)) return forwardPlatformAsset(req, res, target, side);
  const isDocument = req.headers['sec-fetch-dest'] === 'document';
  const ordinal = isDocument ? ++documentOrdinal : null;
  const startedAt = performance.now();
  const headers = { ...req.headers, host: target.host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const token = identityToken(persona, target, headers);
  if (token) headers['x-usernode-token'] = token;
  // Whether this page load carried the persona's identity: a boolean, never
  // the token.
  if (isDocument) diagnostic({ kind: 'document_request', documentOrdinal: ordinal, side,
    ...(persona ? { identityAttached: !!token } : {}) });
  const transport = target.protocol === 'https:' ? https : http;
  // Pin a public destination to the address that was checked, so a second
  // lookup cannot answer with an internal one.
  const pinned = vetted ? {
    lookup: (_hostname, options, callback) => (options?.all
      ? callback(null, [{ address: vetted.address, family: vetted.family }])
      : callback(null, vetted.address, vetted.family)),
  } : {};
  const upstream = transport.request(target, { method: req.method, headers, ...pinned }, (upstreamResponse) => {
    let bodyBytes = 0;
    upstreamResponse.on('data', (chunk) => { bodyBytes += chunk.length; });
    if (isDocument) res.once('finish', () => diagnostic({
      kind: 'document_response', documentOrdinal: ordinal, side,
      outcome: (upstreamResponse.statusCode || 502) < 400 ? 'ok' : 'http_error',
      httpStatus: upstreamResponse.statusCode || 502,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      bodyBytes: Math.min(bodyBytes, 10_000_000),
    }));
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', () => {
    if (isDocument) diagnostic({ kind: 'document_response', documentOrdinal: ordinal,
      side, outcome: 'network_error',
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
    reject(res, 502);
  });
  req.pipe(upstream);
}

// A CONNECT tunnel is opaque, so no persona adds anything to one: the pair's
// origins are plain HTTP inside the cluster.
const handleConnect = (req, client, head) => {
  let upstream = null;
  client.on('error', () => upstream?.destroy());
  connectTunnel(req, client, head, (socket) => { upstream = socket; })
    .catch(() => client.destroy());
};

async function connectTunnel(req, client, head, onUpstream) {
  const authority = String(req.url || '').toLowerCase();
  const split = authority.lastIndexOf(':');
  if (split <= 0) return reject(client);
  const host = authority.slice(0, split).replace(/^\[(.*)\]$/, '$1');
  const targetPort = Number(authority.slice(split + 1));
  // The pair and the catalog by name; anything else at its checked address.
  let address = host;
  if (!permittedAuthority(authority)) {
    const vetted = await vetOutside(host, targetPort);
    if (!vetted.ok) return reject(client);
    if (authority === LEGACY_TAILWIND_CDN) diagnostic({ kind: 'legacy_tailwind_cdn' });
    address = vetted.address;
  }
  if (client.destroyed) return undefined;
  const upstream = net.connect(targetPort, address, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  onUpstream(upstream);
  upstream.on('error', () => client.destroy());
  return undefined;
}

function listener(persona) {
  const server = http.createServer(handleRequest(persona));
  server.on('connect', handleConnect);
  return server;
}

const server = listener(null);
const personaServers = Object.entries(personaPorts())
  .map(([persona, personaPort]) => ({ persona, personaPort, server: listener(persona) }));
const listening = (target, targetPort) => new Promise((resolve, reject_) => {
  target.once('error', reject_);
  target.listen(targetPort, '127.0.0.1', () => resolve(target.address().port));
});

// Ready only once every listener is up: the runner starts the browsers as
// soon as this file exists. It holds the shared port, as it always has.
Promise.all([
  listening(server, port),
  ...personaServers.map(({ server: personaServer, personaPort }) => listening(personaServer, personaPort)),
]).then(([sharedPort]) => {
  if (readyFile) fs.writeFileSync(readyFile, String(sharedPort), { mode: 0o600 });
  // The worker's memory through the turn (shots-memory.js), when the runner
  // asks for it: the proxy lives as long as the turn does.
  const sampleMs = Number(process.env.SHOTS_MEMORY_SAMPLE_MS);
  if (Number.isFinite(sampleMs) && sampleMs > 0) shotsMemory.startSampler(diagnostic, { intervalMs: sampleMs });
}, () => {
  process.stderr.write('Shots proxy could not listen on its ports.\n');
  process.exit(1);
});

function stop() {
  if (readyFile) { try { fs.unlinkSync(readyFile); } catch {} }
  for (const { server: personaServer } of personaServers) personaServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
