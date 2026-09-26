'use strict';

// Baseline security response headers for the platform's own responses (#2507).
//
// Before this, server.js set no X-Content-Type-Options, no Referrer-Policy
// and no framing policy at all, so any origin could put the shell — which
// carries the session cookie and one-click destructive actions (vote, merge,
// app delete, the admin console) — in an invisible <iframe> and clickjack it.
//
// Three headers, each chosen for what it cannot break:
//
//   X-Content-Type-Options: nosniff
//     Every script/stylesheet the platform serves has an exact type (send's
//     mime table, or an explicit res.type), so refusing to sniff costs
//     nothing and stops a response being reinterpreted as script.
//
//   Referrer-Policy: strict-origin-when-cross-origin
//     The browsers' own default today, stated explicitly so an older WebView
//     or a changed default cannot send a full URL (a staging preview's
//     `?token=<JWT>`, a private route) to another origin. Same-origin
//     requests still see the full referrer. Nothing on the platform reads a
//     cross-origin Referer.
//
//   Content-Security-Policy: frame-ancestors 'self' https://<USERNODE_DOMAIN>
//     Clickjacking protection. NOT `'self'` alone and NOT X-Frame-Options:
//     the platform legitimately frames ITSELF from other origins —
//       - a staging preview of the platform runs at
//         `usernode-2d5619--s<N>.<apps domain>` and is shown inside the
//         production shell's staging overlay ("Test this change");
//       - the app-origin fallback pages the platform serves on an app's
//         subdomain (/__app_unavailable, the Caddy access gate's answers)
//         render inside the shell's app iframe.
//     In each case the framer is the platform's own public origin, which a
//     self-preview inherits through USERNODE_DOMAIN (services/staging-env.js).
//     X-Frame-Options can only say DENY/SAMEORIGIN, so it would blank those;
//     every browser that matters honours frame-ancestors instead. The mobile
//     app loads the shell as a top-level WebView document, which no framing
//     policy applies to. No script-src policy is set here: the shell still
//     carries inline scripts/handlers, so that is a separate, staged change.
//
// Scope. The centrally hosted app assets (/usernode-bridge, /usernode-native,
// /usernode-tailwind) are fetched on every hosted APP's own origin through
// Caddy. They get nosniff (their types are exact) but not the CSP or the
// referrer policy, so nothing the platform decides reaches into an app's
// documents. A route that needs its own CSP (the sandboxed chat and
// conversation attachments, the CLI/MCP approval pages, report snapshots)
// sets it with res.set/res.setHeader after this runs, which REPLACES the
// header — so those keep exactly the policy they had.

const REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Paths served on hosted apps' origins. `/usernode-bridge` (no slash) also
// covers the legacy root-level /usernode-bridge.js.
const APP_ORIGIN_ASSET_PREFIXES = ['/usernode-bridge', '/usernode-native/', '/usernode-tailwind/'];

// A bare DNS hostname (optionally with a port). Anything else — a wildcard,
// a scheme, whitespace, a `;` — is refused rather than spliced into a header
// where it could widen the policy.
const HOSTNAME = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

function frameAncestorsPolicy({ platformDomain, localDev } = {}) {
  const sources = ["'self'"];
  const domain = typeof platformDomain === 'string' ? platformDomain.trim() : '';
  if (domain && HOSTNAME.test(domain)) sources.push(`https://${domain}`);
  // Local stack: previews are http://localhost:<hostport>, framed by the
  // platform on another port of the same host.
  if (localDev) sources.push('http://localhost:*', 'http://127.0.0.1:*');
  return `frame-ancestors ${sources.join(' ')}`;
}

function isAppOriginAsset(reqPath) {
  return APP_ORIGIN_ASSET_PREFIXES.some((prefix) => reqPath.startsWith(prefix));
}

function securityHeaders(options = {}) {
  const csp = frameAncestorsPolicy(options);
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!isAppOriginAsset(req.path)) {
      res.setHeader('Referrer-Policy', REFERRER_POLICY);
      res.setHeader('Content-Security-Policy', csp);
    }
    next();
  };
}

module.exports = {
  securityHeaders,
  frameAncestorsPolicy,
  isAppOriginAsset,
  REFERRER_POLICY,
  APP_ORIGIN_ASSET_PREFIXES,
};
