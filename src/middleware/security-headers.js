'use strict';

// #2507: the shell shipped no security response headers at all.
//
// No `helmet`, no header middleware anywhere before the routers. A grep for
// `X-Frame-Options`, `frame-ancestors`, `Content-Security-Policy` and
// `Referrer-Policy` across server.js and src/middleware/ returned nothing;
// `applyShellDocumentHeaders` in services/static-cache.js sets only a
// build-id, `frontend/src/head.html` carries no CSP meta, and the Caddyfile
// sets headers only inside its 502/503 stub.
//
// Two concrete consequences, which is what this closes:
//
//   - CLICKJACKING. The shell was frameable by any origin while carrying the
//     session cookie, and it hosts one-click destructive actions: vote and
//     merge, the admin console, the secrets dialogs, app delete.
//   - REFERER LEAK. With no `Referrer-Policy`, the full URL travels on every
//     cross-origin navigation and subresource — including `?token=<JWT>` on a
//     staging preview link.
//
// TWO TIERS, and the split is the whole design.
//
// `baseSecurityHeaders` is safe on EVERY response and is mounted globally.
// `shellFramingHeaders` is NOT, and is applied only to the shell document.
//
// Why the framing headers cannot be global: the platform serves APP content
// too — app files, the app-error page, app-facing API surfaces — and the
// shell frames apps CROSS-ORIGIN, from their own domains. A blanket
// `frame-ancestors 'self'` on everything this process serves would forbid
// exactly the embedding the product is built on, and every app would go
// blank. So the framing headers go where the risk actually is: the shell
// document, which is the thing with the session cookie and the destructive
// buttons.
//
// Routes that set their own CSP still win. Seven do — the sandboxed
// attachment renderers in chat.js and conversations.js, the CLI approval
// page, the MCP consent page, report snapshots, the waitlist status page —
// and because this middleware runs FIRST, a later `res.set` from a route
// replaces it. That ordering is deliberate: a route that has thought about
// its own policy knows better than a default.

// `strict-origin-when-cross-origin` is what fixes the token leak: a
// cross-origin navigation sends the ORIGIN only, never the path or query, so
// `?token=<JWT>` cannot ride a `Referer`. Same-origin navigation keeps the
// full URL, which is what the app's own analytics and back-navigation need.
const REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Headers that are correct for anything this process returns — an API JSON
// body, an image, an app file, the shell itself. Neither constrains
// embedding, so neither can break the app frame.
function baseSecurityHeaders() {
  return function securityHeadersMiddleware(_req, res, next) {
    // Stop a browser second-guessing a declared Content-Type. Several image
    // and download routes already set this one by hand; this makes it the
    // floor rather than a per-route remembering.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', REFERRER_POLICY);
    next();
  };
}

const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');

// `'self'` rather than `'none'`, deliberately. The platform frames its own
// pages in places — the app-error page renders inside the shell's app iframe
// as well as in a direct tab — and `'none'` would block that too. `'self'`
// refuses every third-party framer, which is the clickjacking fix, while
// leaving same-origin embedding alone.
//
// THE STAGING EXCEPTION, which review caught and which is not optional.
//
// The platform is ITS OWN APP (SELF-HOSTING.md), so a proposal on this
// repository gets a staging container whose shell is loaded INSIDE THE
// PRODUCTION PLATFORM'S staging iframe — cross-origin, at
// `usernode-2d5619--sNNNN.<domain>` framed by the production host.
// `src/middleware/auth.js` documents the whole chain, ending in
// "app-view.js sets `iframe.src = stagingUrl + '?token=' + jwt`".
//
// So a flat `frame-ancestors 'self'` would make every self-app proposal
// preview render a browser refusal instead of the staged shell — breaking
// the review surface that gates this repository's own merges, and doing it
// only on staging, where nobody would look for a header bug.
//
// On staging the production parent is therefore allowed, and
// `X-Frame-Options` is OMITTED there rather than set: its vocabulary is only
// DENY / SAMEORIGIN (ALLOW-FROM is dead in every current browser), so a
// SAMEORIGIN it cannot qualify would contradict the CSP and a browser
// honouring the older header would refuse the frame anyway.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// `http://localhost:*` rides along on staging, and only on staging. Review
// caught the second half of the same flow: in local Docker development a
// self-app preview is published at `http://localhost:<random host port>`
// (services/application-runtime.js) while the parent shell sits on a
// DIFFERENT localhost port — cross-origin again, so the preview would be
// blank for anyone running the stack locally. A staging container cannot
// infer the parent's port, and it cannot key on NODE_ENV either: it inherits
// `NODE_ENV=production` from the image like every other container, and
// staging-env.js does not override it.
//
// The port wildcard is what CSP gives for this; there is no narrower form.
// It is bounded: it applies to STAGING ONLY, so what it admits is a page on
// the reviewer's own machine framing a preview of unreviewed code — a
// surface that is already lower-trust by construction. Production keeps
// `'self'` alone and never sees this.
const LOCAL_PREVIEW_ANCESTOR = 'http://localhost:*';

function shellFrameAncestors(isStaging = IS_STAGING) {
  return isStaging
    ? `frame-ancestors 'self' ${PRODUCTION_ORIGIN} ${LOCAL_PREVIEW_ANCESTOR}`
    : "frame-ancestors 'self'";
}

const SHELL_FRAME_ANCESTORS = shellFrameAncestors();

// Applied to the shell DOCUMENT only — `/index.html` and the SPA fallback.
//
// Deliberately NOT a full CSP. A `script-src`/`style-src` policy for this
// shell is a real piece of work with its own before/after evidence: the
// document carries inline bootstrap script, the legacy `public/js/**` tags,
// a compiled Tailwind sheet and the vendored marked/DOMPurify/qrcodejs, and
// a policy that merely looks right would break the whole app on a route
// nobody tested. Shipping the framing directive now is the half that is
// unambiguous; the rest belongs in its own change, behind
// `Content-Security-Policy-Report-Only` first.
function applyShellFramingHeaders(res, isStaging = IS_STAGING) {
  const directive = shellFrameAncestors(isStaging);
  const existing = res.getHeader('Content-Security-Policy');
  res.setHeader(
    'Content-Security-Policy',
    existing ? `${existing}; ${directive}` : directive
  );
  // Only where it can say the same thing as the CSP — see above.
  if (!isStaging) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

module.exports = {
  baseSecurityHeaders,
  applyShellFramingHeaders,
  shellFrameAncestors,
  REFERRER_POLICY,
  SHELL_FRAME_ANCESTORS,
  PRODUCTION_ORIGIN,
  LOCAL_PREVIEW_ANCESTOR,
};
