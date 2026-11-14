'use strict';

const log = require('../services/logger');
const { readSessionCookie } = require('../services/browser-session-cookies');

// Refuse a BROWSER request that did not come from the Homeroom page itself.
//
// The session cookie is SameSite=Lax, and child apps and staging previews
// are served on subdomains of the platform's own domain — the same SITE. So a
// page on one of them can send a credentialed, bodyless POST to the platform
// (no JSON body, so no CORS preflight) and the cookie rides along. For a
// cookie-authenticated write that needs nothing but the URL, that is enough
// to act for a signed-in visitor.
//
// The rule is the Sec-Fetch-Site half of the browserCsrf guard the dev-flow
// and sign-in routes use (routes/dev-flow.js, routes/cli-auth.js): a browser
// stamps every request with it, and only 'same-origin' means the Homeroom
// page sent it. The fixed-origin comparison those routes make is not used
// here: they compare against config.cliAuthOrigin, which is null on staging
// previews, and these routes must work there. Instead the fallback below
// compares Origin with the host the request itself was sent to.
//
// - 'same-origin' → allowed.
// - 'none' → refused. It marks a navigation the user started themselves
//   (typed URL, bookmark), which never produces a POST or DELETE fetch, so
//   nothing legitimate is lost by treating it like any other non-same-origin
//   value.
// - 'same-site' / 'cross-site' → refused: exactly the requests this stops.
// - Sec-Fetch-Site absent, Origin present → a browser (or WebView) that
//   predates Fetch Metadata. Allowed only when Origin is this request's own
//   origin; 'null' and anything else is refused.
// - Both absent → allowed. That is a non-browser client (the native app's
//   HTTP calls, the CLI, curl, a test); a browser sends Origin on every
//   cross-origin POST. A per-session CSRF token would be the stronger check
//   and is the follow-up if a client ever needs more than this.
function firstHeader(value) {
  return String(value || '').split(',')[0].trim();
}

// The origin this request was sent to, as the proxy in front received it.
// Same source as community-invites.js's requestOrigin(); a browser cannot set
// X-Forwarded-* on a request that skips the CORS preflight.
function ownOrigin(req) {
  // A WebSocket upgrade reaches us as a bare http.IncomingMessage, which has
  // no Express `req.protocol`; its socket says whether TLS ended here.
  const proto = firstHeader(req.headers['x-forwarded-proto']) || req.protocol
    || (req.socket?.encrypted ? 'https' : 'http');
  const host = firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host);
  if (!/^https?$/.test(proto) || !host) return null;
  try {
    return new URL(`${proto}://${host}`).origin.toLowerCase();
  } catch {
    return null;
  }
}

function sameOriginByOriginHeader(req) {
  const origin = req.headers.origin;
  if (origin == null) return true;
  let claimed;
  try {
    claimed = new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }
  // new URL('null') throws, and an opaque origin serialises as 'null'.
  const own = ownOrigin(req);
  return claimed !== 'null' && own != null && claimed === own;
}

// The rule itself, for callers that are not Express routes (the WebSocket
// upgrade in services/ws.js).
function isSameOriginBrowserRequest(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  return fetchSite != null ? fetchSite === 'same-origin' : sameOriginByOriginHeader(req);
}

function sameOriginBrowserOnly(req, res, next) {
  if (!isSameOriginBrowserRequest(req)) return res.status(403).json({ error: 'forbidden' });
  return next();
}

// The same rule for a whole path prefix, applied to its writes only: reads
// stay open to every caller. server.js mounts it on the admin prefixes, whose
// writes are spread over many routers.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function sameOriginBrowserWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  return sameOriginBrowserOnly(req, res, next);
}

// ── Every cookie-authenticated write, by default ─────────────────────────
//
// The per-route guard above is opt-in, and the routes without it were safe
// only because the JSON body parser makes their requests preflight and the
// platform answers no credentialed CORS. That held, but silently: a new
// urlencoded or text parser, a write driven by the query string, or a CORS
// rule would have opened them without a test failing. server.js mounts this
// ahead of every router, so a write that carries the session cookie is
// refused unless the Homeroom page itself sent it, whatever the route.
//
// It reads only the session cookie, the one credential a browser attaches by
// itself; bearer and token requests carry none and are not its concern.
// The anonymous /api/public tier never reads the session (the marketing site
// on the same domain posts its waitlist forms there), so it is not guarded.
//
// A write with the cookie and neither Origin nor Sec-Fetch-Site comes from a
// client that is not a browser (every browser since 2020 sends at least one):
// the native app's own HTTP calls, the CLI, a test. It passes, as it does in
// sameOriginBrowserOnly, and is logged once per method and path prefix, so
// the clients that still depend on it can be found before it is refused.
const PUBLIC_PREFIX = '/api/public/';
const MAX_LOGGED_SHAPES = 500;
const loggedShapes = new Set();

function logHeaderlessCookieWrite(req) {
  if (loggedShapes.size >= MAX_LOGGED_SHAPES) return;
  const shape = `${req.method} ${req.path.split('/').slice(0, 4).join('/')}`;
  if (loggedShapes.has(shape)) return;
  loggedShapes.add(shape);
  log.info('same-site-browser',
    'Cookie-authenticated write without Origin or Sec-Fetch-Site', { shape });
}

function sameOriginCookieWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path.startsWith(PUBLIC_PREFIX)) return next();
  if (!readSessionCookie(req)) return next();
  if (req.headers['sec-fetch-site'] == null && req.headers.origin == null) {
    logHeaderlessCookieWrite(req);
    return next();
  }
  return sameOriginBrowserOnly(req, res, next);
}

module.exports = { sameOriginBrowserOnly, sameOriginBrowserWrites, sameOriginCookieWrites,
  isSameOriginBrowserRequest };
