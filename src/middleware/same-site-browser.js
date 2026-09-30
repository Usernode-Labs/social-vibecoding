'use strict';

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
  const proto = firstHeader(req.headers['x-forwarded-proto']) || req.protocol;
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

function sameOriginBrowserOnly(req, res, next) {
  const fetchSite = req.headers['sec-fetch-site'];
  const allowed = fetchSite != null ? fetchSite === 'same-origin' : sameOriginByOriginHeader(req);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
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

module.exports = { sameOriginBrowserOnly, sameOriginBrowserWrites };
