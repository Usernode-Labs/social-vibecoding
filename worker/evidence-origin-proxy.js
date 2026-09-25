#!/usr/bin/env node
'use strict';

// Mandatory egress boundary for evidence-browser MCP servers. Playwright's
// allowed-origins option is useful filtering but explicitly is not a security
// boundary; this proxy independently rejects HTTP requests and CONNECT
// tunnels outside the paired internal origins and their authenticated,
// public deployed-app catalog. The catalog arrives after browser bootstrap.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseHostedOriginsFile } = require('./evidence-hosted-origins');

const DIAGNOSTIC_MARKER = '__USERNODE_EVIDENCE_BROWSER__ ';

let origins;
try {
  origins = new Set(JSON.parse(process.env.EVIDENCE_ALLOWED_ORIGINS || '[]').map((value) => new URL(value).origin));
} catch {
  origins = new Set();
}
if (origins.size !== 2) {
  process.stderr.write('Evidence proxy requires exactly two allowed origins.\n');
  process.exit(1);
}
const authorities = new Set([...origins].map((origin) => {
  const url = new URL(origin);
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}));
const port = Number(process.env.EVIDENCE_PROXY_PORT || 17891);
const readyFile = process.env.EVIDENCE_PROXY_READY || '';
const originList = [...origins];
const hostedFile = process.env.EVIDENCE_HOSTED_ORIGINS_FILE || '';
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
let documentOrdinal = 0;
const controlToken = String(process.env.EVIDENCE_PROXY_CONTROL_TOKEN || '');
const controlPath = '/__usernode_evidence_control/request-failure';
const controlledFailures = new Set();
let controlledFailureHits = 0;

function validApiPath(value) {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/api/')
      || value.includes('*') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value, 'http://evidence.invalid');
    return !url.hash && `${url.pathname}${url.search}` === value;
  } catch { return false; }
}

function validControlToken(value) {
  if (!/^[0-9a-f]{64}$/.test(controlToken) || typeof value !== 'string'
      || value.length !== controlToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(controlToken));
}

function controlRequest(req, res) {
  if (req.method !== 'POST' || !validControlToken(req.headers['x-evidence-control-token'])) {
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
    socketOrResponse.end('Blocked by visual-evidence origin policy.');
  } else {
    socketOrResponse.end(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === controlPath) return controlRequest(req, res);
  let target;
  try {
    target = new URL(req.url);
  } catch {
    try { target = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { return reject(res, 400); }
  }
  if (!permittedOrigin(target.origin)) return reject(res);
  if (origins.has(target.origin) && req.method === 'GET'
      && controlledFailures.has(`${target.pathname}${target.search}`)) {
    controlledFailureHits += 1;
    diagnostic({ kind: 'controlled_failure_hit',
      side: target.origin === originList[0] ? 'base' : 'head', hitOrdinal: controlledFailureHits });
    return res.destroy();
  }
  const isDocument = req.headers['sec-fetch-dest'] === 'document';
  const ordinal = isDocument ? ++documentOrdinal : null;
  const startedAt = performance.now();
  const side = target.origin === originList[0] ? 'base'
    : target.origin === originList[1] ? 'head' : 'hosted';
  if (isDocument) diagnostic({ kind: 'document_request', documentOrdinal: ordinal, side });
  const headers = { ...req.headers, host: target.host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: req.method, headers }, (upstreamResponse) => {
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
});

server.on('connect', (req, client, head) => {
  const authority = String(req.url || '').toLowerCase();
  if (!permittedAuthority(authority)) return reject(client);
  const split = authority.lastIndexOf(':');
  const host = authority.slice(0, split);
  const targetPort = Number(authority.slice(split + 1));
  const upstream = net.connect(targetPort, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => {
  if (readyFile) fs.writeFileSync(readyFile, String(server.address().port), { mode: 0o600 });
});

function stop() {
  if (readyFile) { try { fs.unlinkSync(readyFile); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
