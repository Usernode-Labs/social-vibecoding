// Brotli / gzip for the platform's own text responses.
//
// Why this exists: nothing between the browser and this process compresses.
// Production's ingress is Cilium's embedded Envoy, which passes bodies through
// untouched, so every byte the shell sends crossed the network as written:
// ~5.8 MB of JavaScript and CSS on a first visit (the 2 MB React bundle, the
// 1.1 MB app-view.js, the 900 KB app.css), the 158 KB document on every
// navigation that is not a 304, the 90 KB service worker on every update
// check, and every JSON answer — GET /api/apps is 300-700 KB of it. Measured
// in the iOS Simulator through a 1.6 Mbps / 300 ms link, a first visit took
// 21 s to first paint. The same bytes are ~4x smaller as brotli and JSON is
// 5-10x smaller, and none of that needs a change to what is sent.
//
// Scope is deliberately narrow, because the one way compression goes wrong
// is holding back bytes a client is waiting on. zlib buffers until it has a
// block or is told to flush, so a response that is written a piece at a time
// and read a piece at a time (an event stream, a proxied model stream) would
// stall. So:
//
//   - Only GET and HEAD. Every streaming or proxied surface here that matters
//     is a POST (the Anthropic and app-LLM proxies, /mcp), and the reads the
//     shell waits on are all GETs.
//   - Never a request that asks for an event stream, and never a path that
//     proxies someone else's bytes (the worker and app model proxies, the
//     explorer passthrough) or speaks MCP.
//   - At header time, only the text types the shell itself is made of —
//     HTML, CSS, JavaScript, JSON, SVG, the web manifest — and never
//     text/event-stream, whatever the request said. text/plain and text/csv
//     are left alone: exports and logs are written row by row.
//   - `compression` itself already refuses a body under 1 KB, a response
//     that already carries a Content-Encoding, and `Cache-Control:
//     no-transform`, and sets `Vary: Accept-Encoding`.
//
// Brotli quality 5 rather than the library's 4: on the 2 MB shell bundle it
// is ~26 ms against ~17 ms of zlib's thread pool (not the event loop) for
// 516 KB against 561 KB, and the bundle is fetched once per build per device.
const compression = require('compression');
const zlib = require('zlib');

const SKIP_PREFIXES = [
  '/api/internal/',
  '/api/app-llm/',
  '/explorer-api',
  '/mcp',
];

const COMPRESSIBLE_TYPE = /^(?:text\/(?:html|css|javascript)|application\/(?:json|javascript|x-javascript|manifest\+json)|image\/svg\+xml)\b/i;

// Before `compression` wraps the response at all: a request this rejects is
// never touched, not merely left uncompressed.
function wantsCompression(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (/text\/event-stream/i.test(req.headers.accept || '')) return false;
  const p = req.path || '';
  return !SKIP_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

// At header time, once the handler has said what it is sending.
function compressibleResponse(req, res) {
  const type = String(res.getHeader('Content-Type') || '');
  if (!COMPRESSIBLE_TYPE.test(type)) return false;
  return compression.filter(req, res);
}

function responseCompression() {
  const compress = compression({
    filter: compressibleResponse,
    brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
  });
  return function responseCompressionMiddleware(req, res, next) {
    if (!wantsCompression(req)) return next();
    return compress(req, res, next);
  };
}

module.exports = {
  responseCompression,
  wantsCompression,
  compressibleResponse,
  COMPRESSIBLE_TYPE,
};
