'use strict';

// The app-host gate on Kubernetes: a small reverse proxy that sits in front
// of every generated app and preview, and asks the platform about each
// request before passing it on.
//
// WHY THIS EXISTS. On the standalone deployment Caddy forward_auths every
// app-host request to the platform (GET /__caddy/access). On Kubernetes the
// apps' Ingresses go straight to each app's Service through Cilium's Envoy,
// which has no forward-auth hook, so nothing platform-owned saw those
// requests at all: a view-private app was gated only by its own code, and an
// app opened at its own address could not sign anyone in (#3657). When
// APP_GATE=on, services/kubernetes.js points each app Ingress's catch-all
// path at this Deployment (`usernode-app-gate`) instead, and this process
// does what Caddy's forward_auth does:
//
//   1. GET <platform>/__caddy/access with the request's headers (minus the
//      body), X-Forwarded-Host/-Method/-Uri, and `X-Usernode-Gate:
//      kubernetes`, which asks the platform to also name the app's Service
//      (`X-Usernode-Upstream`).
//   2. Not 2xx: that answer is the visitor's answer, verbatim (a 302 that
//      sets the sign-in cookie, a 404, a 403).
//   3. 2xx: proxy the request to the named Service, with the identity the
//      platform returned (`X-Usernode-Identity`) as `x-usernode-token`, and
//      the gate's own cookies removed. A client-supplied identity or
//      upstream header is always discarded. WebSocket handshakes go the same
//      way and are then piped.
//
// It also keeps the standalone deployment's two rescues: a 401 to a
// top-level document visit becomes the platform's chromeless view of the app
// (the Caddyfile's @chromeless), and an app that is down gets the platform's
// friendly /__app_unavailable page instead of a bare 502.
//
// The decision is never made here: this process holds no keys, reads no
// database, and fails CLOSED. If the platform cannot be asked (after a short
// retry window that covers a rolling restart), the answer is 503.
//
// Dependency-free like scripts/serve-platform-assets.js: it runs the
// platform's image in the generated-app namespace with none of the
// platform's configuration, only:
//
//   GATE_PLATFORM_URL     the platform's in-cluster URL (required)
//   GATE_UPSTREAM_DOMAIN  suffix for app Service names (optional; empty
//                         resolves them in this pod's own namespace)
//   GATE_UPSTREAM_PORT    the apps' Service port (default 3000)
//   PORT                  this server's port (default 3000)

const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

// The same stripping the Caddyfile does with a header_up replacement.
const GATE_COOKIE_RE = /^(?:__Host-usernode|__usernode)_(?:access|anon)$/;
function hasGateCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return false;
  return cookieHeader.split(';').some((part) => GATE_COOKIE_RE.test(part.split('=')[0].trim()));
}
function stripGateCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return '';
  return cookieHeader.split(';')
    .map((part) => part.trim())
    .filter((part) => part && !GATE_COOKIE_RE.test(part.split('=')[0].trim()))
    .join('; ');
}

const HEALTH_PATH = '/__usernode_gate/health';
const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Hop-by-hop headers (RFC 9110 7.6.1) never cross a proxy.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// Headers only the platform may set on what the app receives. A client that
// sends one has it discarded before anything else happens.
const GATE_HEADERS = ['x-usernode-identity', 'x-usernode-upstream', 'x-usernode-gate', 'x-usernode-applink'];
// What a refusal may carry back to the visitor.
const RELAYED = ['location', 'set-cookie', 'content-type', 'cache-control', 'referrer-policy'];

function cleanHeaders(headers) {
  const out = {};
  const connectionTokens = String(headers.connection || '').toLowerCase().split(',').map((t) => t.trim());
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || connectionTokens.includes(key)) continue;
    if (GATE_HEADERS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function forwardedFor(req) {
  const prior = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  const ip = clientIp(req);
  return prior ? `${prior}, ${ip}` : ip;
}

// A request whose answer cannot depend on who is asking: no gate cookie, no
// token in the header or the address, not a visit (which may hop to the
// apex), not the sign-in callback, and only a read. For a public app the
// platform answers every such request the same way, so its 2xx is reused
// for a few seconds instead of asked again for every asset. The platform
// caches visibility for 10s itself, so this adds no staleness it does not
// already have. Anything else is always asked.
const ANON_CACHE_MS = 5000;
function anonymousRead(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (hasGateCookie(req.headers.cookie)) return false;
  if (req.headers['x-usernode-token']) return false;
  if (String(req.headers['sec-fetch-dest'] || '').toLowerCase() === 'document') return false;
  if (req.headers['sec-websocket-key'] || req.headers.upgrade) return false;
  const url = String(req.url || '/');
  if (url.startsWith('/__usernode_access')) return false;
  if (/[?&]token=/.test(url)) return false;
  return true;
}

function createGate({
  platformUrl,
  upstreamDomain = '',
  upstreamPort = 3000,
  // Test seam: where a Service name connects.
  resolveUpstream = null,
  decisionTimeoutMs = 10_000,
  retryWindowMs = 15_000,
  anonCacheMs = ANON_CACHE_MS,
  log = console,
} = {}) {
  if (!platformUrl) throw new Error('app-gate: GATE_PLATFORM_URL is required');
  const platform = new URL(platformUrl);
  const platformAgent = platform.protocol === 'https:'
    ? new https.Agent({ keepAlive: true, maxSockets: 256 })
    : new http.Agent({ keepAlive: true, maxSockets: 256 });
  const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
  const transport = platform.protocol === 'https:' ? https : http;

  const anonDecisions = new Map(); // host -> { at, decision }

  const upstreamTarget = (name) => (resolveUpstream
    ? resolveUpstream(name)
    : { host: upstreamDomain ? `${name}.${upstreamDomain}` : name, port: upstreamPort });

  // One question to the platform. Network failures retry with backoff for
  // a rolling restart's worth of time; an ANSWER is never retried.
  function askOnce(req) {
    const headers = cleanHeaders(req.headers);
    delete headers['content-length'];
    delete headers.host;
    Object.assign(headers, {
      host: platform.host,
      'x-forwarded-host': String(req.headers.host || ''),
      'x-forwarded-method': req.method,
      'x-forwarded-uri': req.url,
      'x-forwarded-proto': String(req.headers['x-forwarded-proto'] || 'https'),
      'x-forwarded-for': forwardedFor(req),
      'x-usernode-gate': 'kubernetes',
    });
    return new Promise((resolve, reject) => {
      const ask = transport.request({
        protocol: platform.protocol,
        hostname: platform.hostname,
        port: platform.port || (platform.protocol === 'https:' ? 443 : 80),
        path: '/__caddy/access',
        method: 'GET',
        headers,
        agent: platformAgent,
        timeout: decisionTimeoutMs,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 64 * 1024) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      ask.on('timeout', () => ask.destroy(new Error('decision timed out')));
      ask.on('error', reject);
      ask.end();
    });
  }

  async function askPlatform(req) {
    const cacheable = anonymousRead(req);
    const host = String(req.headers.host || '').toLowerCase();
    if (cacheable) {
      const hit = anonDecisions.get(host);
      if (hit && Date.now() - hit.at < anonCacheMs) return hit.decision;
    }
    const decision = await askWithRetry(req);
    // Only an allow, and never one that carries an identity.
    if (cacheable && anonCacheMs > 0 && decision.status >= 200 && decision.status < 300 && !decision.headers['x-usernode-identity']) {
      if (anonDecisions.size >= 1000) anonDecisions.clear();
      anonDecisions.set(host, { at: Date.now(), decision });
    }
    return decision;
  }

  async function askWithRetry(req) {
    const deadline = Date.now() + retryWindowMs;
    let wait = 100;
    for (;;) {
      try {
        return await askOnce(req);
      } catch (err) {
        if (Date.now() + wait > deadline) throw err;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 2000);
      }
    }
  }

  // What the app receives: the visitor's headers, minus anything only the
  // platform may set, minus the gate's own cookies, plus the identity the
  // platform returned and the usual forwarding headers.
  function upstreamHeaders(req, decision) {
    const headers = cleanHeaders(req.headers);
    const cookie = stripGateCookies(req.headers.cookie);
    if (cookie) headers.cookie = cookie; else delete headers.cookie;
    const identity = decision.headers['x-usernode-identity'];
    if (typeof identity === 'string' && identity) headers['x-usernode-token'] = identity;
    headers['x-forwarded-for'] = forwardedFor(req);
    headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] || 'https');
    headers['x-forwarded-host'] = String(req.headers.host || '');
    return headers;
  }

  function relayRefusal(res, decision) {
    const headers = {};
    for (const name of RELAYED) {
      if (decision.headers[name] != null) headers[name] = decision.headers[name];
    }
    res.writeHead(decision.status, headers);
    res.end(decision.body);
  }

  function isDocumentVisit(req) {
    return (req.method === 'GET' || req.method === 'HEAD')
      && String(req.headers['sec-fetch-dest'] || '').toLowerCase() === 'document';
  }

  // The friendly "this app is restarting" page, from the platform, which
  // reads the app's host from Host (routes/app-error.js).
  function unavailable(req, res) {
    const page = transport.request({
      protocol: platform.protocol,
      hostname: platform.hostname,
      port: platform.port || (platform.protocol === 'https:' ? 443 : 80),
      path: '/__app_unavailable',
      method: 'GET',
      headers: {
        host: String(req.headers.host || ''),
        accept: String(req.headers.accept || '*/*'),
        'sec-fetch-dest': String(req.headers['sec-fetch-dest'] || ''),
      },
      agent: platformAgent,
      timeout: 5000,
    }, (pageRes) => {
      if (res.headersSent) { pageRes.resume(); return; }
      res.writeHead(pageRes.statusCode || 502, {
        'content-type': pageRes.headers['content-type'] || 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      pageRes.pipe(res);
    });
    page.on('timeout', () => page.destroy(new Error('timeout')));
    page.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('502 Bad Gateway');
    });
    page.end();
  }

  async function onRequest(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    let decision;
    try {
      decision = await askPlatform(req);
    } catch (err) {
      log.error?.('[app-gate] platform unreachable', err.message);
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' });
      return res.end('Homeroom is updating. Try again in a moment.');
    }
    if (decision.status < 200 || decision.status >= 300) return relayRefusal(res, decision);

    const upstream = String(decision.headers['x-usernode-upstream'] || '');
    if (!SERVICE_NAME_RE.test(upstream)) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('502 Bad Gateway');
    }
    const applink = String(decision.headers['x-usernode-applink'] || '');
    const target = upstreamTarget(upstream);
    const proxied = http.request({
      hostname: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: upstreamHeaders(req, decision),
      agent: upstreamAgent,
    }, (upRes) => {
      // The chromeless rescue: an app that answers a top-level visit with
      // 401 is sent to the platform's view of it, carrying the path.
      if (upRes.statusCode === 401 && applink && isDocumentVisit(req)) {
        upRes.resume();
        res.writeHead(302, { location: `${applink}?path=${req.url}`, 'cache-control': 'no-store' });
        return res.end();
      }
      const headers = cleanHeaders(upRes.headers);
      res.writeHead(upRes.statusCode || 502, headers);
      upRes.pipe(res);
    });
    proxied.on('error', (err) => {
      log.warn?.('[app-gate] upstream failed', upstream, err.code || err.message);
      if (res.headersSent) { res.destroy(); return; }
      unavailable(req, res);
    });
    req.on('aborted', () => proxied.destroy());
    req.pipe(proxied);
    return undefined;
  }

  function writeRefusalToSocket(socket, decision) {
    const lines = [`HTTP/1.1 ${decision.status} ${http.STATUS_CODES[decision.status] || 'Error'}`];
    for (const name of RELAYED) {
      const value = decision.headers[name];
      if (value == null) continue;
      for (const v of [].concat(value)) lines.push(`${name}: ${v}`);
    }
    lines.push(`content-length: ${decision.body.length}`, 'connection: close', '', '');
    socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), decision.body]));
  }

  async function onUpgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    let decision;
    try {
      decision = await askPlatform(req);
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    if (decision.status < 200 || decision.status >= 300) {
      writeRefusalToSocket(socket, decision);
      return;
    }
    const upstream = String(decision.headers['x-usernode-upstream'] || '');
    if (!SERVICE_NAME_RE.test(upstream)) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const target = upstreamTarget(upstream);
    const headers = upstreamHeaders(req, decision);
    // The handshake itself: these two are hop-by-hop everywhere else.
    headers.connection = 'Upgrade';
    headers.upgrade = String(req.headers.upgrade || 'websocket');
    const up = net.connect(target.port, target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const v of [].concat(value)) lines.push(`${name}: ${v}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      log.error?.('[app-gate] request failed', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('502 Bad Gateway');
      } else {
        res.destroy();
      }
    });
  });
  server.on('upgrade', (req, socket, head) => { onUpgrade(req, socket, head).catch(() => socket.destroy()); });
  // Long-lived streams (SSE, uploads) are the app's to time out, not ours.
  server.requestTimeout = 0;
  // Outlive the ingress's 60-second idle timeout, as the platform does.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
  return server;
}

function start() {
  const server = createGate({
    platformUrl: process.env.GATE_PLATFORM_URL,
    upstreamDomain: process.env.GATE_UPSTREAM_DOMAIN || '',
    upstreamPort: Number(process.env.GATE_UPSTREAM_PORT || 3000),
  });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`app gate listening on :${port}`));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) start();

module.exports = { createGate, stripGateCookies, cleanHeaders, anonymousRead, HEALTH_PATH, GATE_HEADERS, start };
