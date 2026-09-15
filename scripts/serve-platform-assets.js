'use strict';

// Serves the three centrally hosted asset trees — /usernode-bridge/,
// /usernode-native/ and /usernode-tailwind/ — as its own tiny Deployment in
// the generated-app namespace, so that every app's OWN hostname can serve
// them (services/kubernetes.js adds the matching path rules to each app's
// Ingress). Apps then reference them at a RELATIVE path and never carry the
// platform's hostname, which is what makes a domain move survivable: the
// last one left every app scaffolded before it still requesting these
// files from the previous hostname, which no longer answers.
//
// WHY A SEPARATE PROCESS rather than pointing the apps' Ingress at the
// platform Service: an Ingress backend must be a Service in the SAME
// namespace as the Ingress, and the apps' Ingresses live in the
// generated-app namespace while the platform runs in its own. The two
// alternatives — an ExternalName Service, or a hand-maintained EndpointSlice
// aimed at the platform's ClusterIP — both lean on ingress-controller
// behaviour that varies by implementation, and an Ingress whose backend
// silently programs to nothing is a black hole on every app's asset path.
// A Service with an ordinary selector is the one shape every controller
// programs.
//
// This runs the PLATFORM'S OWN IMAGE (read from the running platform
// Deployment), so the bytes here are the same bytes at the same commit the
// platform serves at its own origin, and the fleet-wide fix that central
// hosting buys still reaches every app on its next page load.
//
// Deliberately dependency-free: no express, no config.load(), no database.
// It has to boot in a container holding none of the platform's environment.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..', 'public');

// The same three prefixes services/kubernetes.js routes and
// middleware/auth.js already serves anonymously. Anything else is a 404:
// this process is not a general static server for public/.
const PREFIXES = ['/usernode-bridge/', '/usernode-native/', '/usernode-tailwind/'];

const TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function isAssetPath(pathname) {
  return PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// The three asset directories, resolved once. The containment check below
// is against THESE, not against ROOT: `new URL()` already folds a literal
// `..` out of the pathname, but a percent-encoded one survives it and is
// only decoded here — and a check that stopped at ROOT would let
// `/usernode-native/%2e%2e/js/app.js` serve any file under public/, which
// would quietly make this a general static server for the whole tree.
// Everything under public/ is public either way; the point is that this
// process serves three directories and nothing else.
const ASSET_DIRS = PREFIXES.map((prefix) => path.resolve(ROOT, '.' + prefix));

// Resolve inside one of those directories or not at all. decodeURIComponent
// throws on a malformed escape, and a NUL byte truncates a path in some
// syscalls, so both are refused rather than assumed away.
function resolveAsset(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(ROOT, '.' + path.posix.normalize(decoded));
  const contained = ASSET_DIRS.some((dir) => resolved.startsWith(dir + path.sep));
  return contained ? resolved : null;
}

// max-age=0 + a validator, NOT a long TTL. The whole promise of central
// hosting is that a fix lands on the next page load; a cached copy with a
// long TTL would quietly opt every app out of it.
function send(res, status, headers, body, method) {
  res.writeHead(status, { 'Cache-Control': 'public, max-age=0, must-revalidate', ...headers });
  if (method === 'HEAD' || body === null) return res.end();
  return res.end(body);
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, 'Method Not Allowed', method);
  }

  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = '/'; }

  if (pathname === '/health') {
    return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok', method);
  }
  if (!isAssetPath(pathname)) {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found', method);
  }

  const file = resolveAsset(pathname);
  if (!file) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found', method);

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found', method);
    }
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      // Public, immutable-by-commit static assets. Same-origin once an app
      // is on relative paths, so this only matters to callers still naming
      // an absolute origin during the transition.
      'Access-Control-Allow-Origin': '*',
    };
    if (req.headers['if-none-match'] === etag) return send(res, 304, headers, null, method);
    if (method === 'HEAD') return send(res, 200, { ...headers, 'Content-Length': String(stat.size) }, null, method);

    res.writeHead(200, { 'Cache-Control': 'public, max-age=0, must-revalidate', ...headers, 'Content-Length': String(stat.size) });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

// Guarded so the tests can require this module for its path handling
// without binding a port or leaving the runner with an open handle.
function start() {
  server.listen(PORT, () => console.log(`platform assets listening on :${PORT}`));

  // Convention 9: stop accepting, drain briefly, exit.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
  return server;
}

if (require.main === module) start();

module.exports = { PREFIXES, isAssetPath, resolveAsset, ROOT, server, start };
