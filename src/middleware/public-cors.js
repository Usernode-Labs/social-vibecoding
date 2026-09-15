// Browser cross-origin access for the anonymous `/api/public/*` surface.
//
// Why this exists: the waitlist join and check-my-status calls are made from
// marketing pages the platform does not host — a Framer site on its own
// origin, for one. Those are browser calls, and a browser discards a
// perfectly good 200 whose response carries no Access-Control-Allow-Origin
// header, so the page reports a network failure it can say nothing useful
// about. A JSON POST also triggers an OPTIONS preflight first, which nothing
// answered: the status route is registered for POST only, so the preflight
// fell through to the SPA catch-all and never carried CORS headers at all.
//
// Scope is the `/api/public/` prefix and nothing else. That prefix is already
// the platform's fully-anonymous tier — it is in PUBLIC_PATHS
// (src/middleware/auth.js) and, per the header of src/routes/public-api.js,
// NOTHING under it reads req.user. That is exactly the property that makes
// opening it to other origins safe: there is no session to ride, so a
// cross-origin caller reaches nothing an unauthenticated curl could not
// already fetch. Every other route on the platform is untouched and still
// sends no CORS headers, which is what keeps a cookie-authenticated API from
// becoming readable by any page a logged-in user happens to visit.
//
// Four deliberate choices, each of which is the thing to re-read before
// widening this:
//
//   - `Access-Control-Allow-Origin: *`, never an echoed Origin. The browser's
//     own rules forbid pairing a wildcard with credentials, so "no cookies
//     here" becomes structural rather than a convention this file has to
//     remember. A wildcard also needs no `Vary: Origin`, so no cache in front
//     of the platform can hand one origin's response to another.
//   - `Access-Control-Allow-Credentials` is never set, for the same reason.
//     If some future route under this prefix ever needs a session, it does
//     not belong under this prefix.
//   - The allowed request headers are the two a browser JSON call actually
//     needs. `x-waitlist-client-key` is deliberately absent: that shared
//     secret re-keys the join endpoint's rate-limit budget for a
//     server-to-server integrator (src/services/waitlist-integrator.js), and
//     a browser cannot hold a secret. Leaving the header out of the
//     allowlist means a cross-origin page cannot send it even by mistake, so
//     every browser signup stays on the ordinary per-IP budget.
//   - Only the methods this surface serves: the waitlist status, join,
//     resend and confirm calls are POSTs, the options/confirm/more reads and
//     the app directory are GETs. No PUT, PATCH or DELETE exists here.
//
// A preflight for a path that does not exist still gets the 204 rather than
// a 404. That is ordinary CORS-middleware behaviour and discloses nothing —
// the real request behind it still 404s.
'use strict';

const PUBLIC_API_PREFIX = '/api/public/';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Accept';
// Ten minutes. Chrome caps preflight caching well below its own maximum
// anyway; this is only here so a page that polls the status route does not
// pay a preflight per call.
const MAX_AGE_SECONDS = '600';

function publicApiCors() {
  return function publicApiCorsMiddleware(req, res, next) {
    if (!req.path.startsWith(PUBLIC_API_PREFIX)) return next();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);

    if (req.method === 'OPTIONS') {
      // `Allow` is for the non-CORS client that sent a bare OPTIONS; the
      // three headers above are what the preflight came for.
      res.setHeader('Allow', ALLOWED_METHODS);
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = {
  publicApiCors,
  PUBLIC_API_PREFIX,
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
};
