'use strict';

// What the platform answers for an address it does not have (request 7166,
// point 1, from the search check of 25 Nov 2026).
//
// A signed-out request for any address no route knew was answered 302 to
// `/`. A search engine reads that as a soft 404: `/nonexistent-page-xyz`,
// `/u/someone`, `/@someone` and the rest all showed the home page, so the
// home page was listed under many addresses. Three answers replace it:
//
//   - an address that MOVED answers 301 to its new place (movedAddress),
//     whoever asks, signed in or not;
//   - an address behind sign-in that people bookmark keeps its 302 to the
//     front door (isSignInFirst), where they sign in;
//   - everything else answers 404 with a small page that links home
//     (notFoundPage). middleware/auth.js sends it for a signed-out request
//     only: a signed-in one still gets the shell, which draws its own screen.
//
// The addresses the shell's own router reads from the path (`/`,
// `/communities`, `/app/<slug>…`, `/invite/<token>`, `/welcome/<code>`) are
// `isSpaDocumentPath` in middleware/auth.js and never reach any of this.

const crypto = require('crypto');
const { termsUrl, privacyNoticeUrl } = require('./marketing-links');

// Same-origin moves. `/apps` was Discover, whose screen is gone: the landing
// is where its list is now. `/private-communities` is the name people guess
// for the page about private communities, which lives at `/communities`.
const MOVED_HERE = {
  '/apps': '/',
  '/private-communities': '/communities',
};

/**
 * Where a moved address went, or null when this one did not move. Exact
 * paths only (one trailing slash is forgiven), so `/apps/foo` and `/termsx`
 * are not moves. The legal pages are on the marketing site
 * (services/marketing-links.js); every target is a fixed string from
 * configuration, never from the request, so this is no open redirect. A
 * same-origin move keeps the query string a link carried.
 */
function movedAddress(pathname, config, search = '') {
  const raw = String(pathname || '');
  const path = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (path === '/terms' || path === '/terms.html') return termsUrl(config);
  if (path === '/privacy' || path === '/privacy.html') return privacyNoticeUrl(config);
  if (Object.prototype.hasOwnProperty.call(MOVED_HERE, path)) {
    const query = typeof search === 'string' && search.startsWith('?') ? search : '';
    return `${MOVED_HERE[path]}${query}`;
  }
  return null;
}

// Real addresses that need a session and that people bookmark or scan: the
// five retired admin pages (server.js serves a stub for each, and for its
// `.html` form, that forwards into the admin console) and `/get-app`, the
// address the notification ask's code opens on a phone. Signed out they go
// to the front door as before, never to "Page not found".
const SIGN_IN_FIRST = new Set([
  '/admin', '/admin.html',
  '/admin-features', '/admin-features.html',
  '/dashboard', '/dashboard.html',
  '/debug', '/debug.html',
  '/gallery', '/gallery.html',
  '/get-app',
]);

function isSignInFirst(pathname) {
  return SIGN_IN_FIRST.has(String(pathname || ''));
}

// The page loads no script and no file from anywhere: one inline style,
// allowed by its hash. This page has no shell bundle, so its English stays
// in code (the standalone-page rule in frontend/locales/README.md).
const STYLE = [
  ':root{color-scheme:light dark;--ground:#fffeea;--card:#fff;--ink:#1d1d1b;--muted:#55554f;--line:#d9d6c3;--btn:#1d1d1b;--on-btn:#fff}',
  '@media (prefers-color-scheme: dark){:root{--ground:#161614;--card:#1f1f1c;--ink:#f4f3ea;--muted:#a9a89d;--line:#3a3a35;--btn:#f4f3ea;--on-btn:#1d1d1b}}',
  '*{box-sizing:border-box}',
  'html,body{min-height:100%;margin:0}',
  'body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;background:var(--ground);color:var(--ink);font:1rem/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  '.card{width:100%;max-width:30rem;padding:2.5rem 1.5rem;border:1px solid var(--line);border-radius:20px;background:var(--card);text-align:center}',
  '.mark{margin:0 0 1.125rem;font-size:1.125rem;font-weight:800}',
  'h1{margin:0 0 .625rem;font-size:1.75rem;line-height:1.2;font-weight:700}',
  '.line{margin:0 0 1.5rem;color:var(--muted);font-size:.9375rem}',
  '.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 1.375rem;border-radius:999px;background:var(--btn);color:var(--on-btn);font-size:.9375rem;font-weight:600;text-decoration:none}',
].join('\n');

const STYLE_HASH = `'sha256-${crypto.createHash('sha256').update(STYLE).digest('base64')}'`;

/** The "Page not found" document. The same bytes for every address. */
function notFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found · Homeroom</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
<p class="mark">Homeroom</p>
<h1>Page not found</h1>
<p class="line">There is nothing at this address. It may have moved, or the link may be mistyped.</p>
<a class="btn" href="/">Go to Home</a>
</main>
</body>
</html>
`;
}

/** The headers every not-found answer carries, page or not. */
function notFoundHeaders() {
  return {
    'Content-Security-Policy': `default-src 'none'; style-src ${STYLE_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  };
}

/**
 * Answer 404 for an address nothing knows. A request that takes HTML (a
 * browser, a crawler, a plain `curl`) gets the page; anything else gets the
 * same JSON the signed-in catch-all in server.js sends. Express drops the
 * body of a HEAD by itself.
 */
function sendNotFound(req, res) {
  res.status(404).set(notFoundHeaders());
  if ((req.method === 'GET' || req.method === 'HEAD') && req.accepts('html')) {
    return res.type('html').send(notFoundPage());
  }
  return res.json({ error: 'Not found' });
}

/**
 * The 301 for a moved address, mounted before the session is read: the
 * answer is the same for everyone. Anything else passes through.
 */
function movedAddressRedirect(config) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const at = req.originalUrl.indexOf('?');
    const target = movedAddress(req.path, config, at === -1 ? '' : req.originalUrl.slice(at));
    if (!target) return next();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.redirect(301, target);
  };
}

module.exports = {
  movedAddress,
  movedAddressRedirect,
  isSignInFirst,
  SIGN_IN_FIRST,
  notFoundPage,
  notFoundHeaders,
  sendNotFound,
  STYLE,
};
