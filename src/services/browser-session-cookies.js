'use strict';

// One deployment decision for every session consumer. Strict mode deliberately
// has no legacy fallback: an old Domain cookie is not proof of host ownership.
function isolationMode(env = process.env) {
  const mode = env.BROWSER_SITE_ISOLATION === undefined ? 'legacy' : env.BROWSER_SITE_ISOLATION;
  if (mode !== 'legacy' && mode !== 'strict') {
    throw new Error('BROWSER_SITE_ISOLATION must be legacy or strict');
  }
  if (mode === 'strict' && env.NODE_ENV !== 'production') {
    throw new Error('Strict browser isolation requires HTTPS production cookies');
  }
  return mode;
}

function sessionCookieName(env = process.env) {
  return isolationMode(env) === 'strict' ? '__Host-usernode_session' : 'session';
}

function scopeCookieName(env = process.env, secure = env.NODE_ENV === 'production') {
  return secure ? '__Host-usernode_api_scope' : 'usernode_api_scope';
}

// A cookie that carries a token or a sign-in binder is named `__Host-` when
// it is Secure. A browser accepts that name only when it is Secure, Path=/
// and has no Domain, so an app on a sibling host (<slug>.onhomeroom.com)
// cannot plant one for the platform to read. Plain-HTTP development keeps the
// bare name, which a browser refuses with the prefix. A reader makes the same
// decision as its writer and never falls back to the bare name: that is the
// cookie a sibling host can plant.
function protectedCookieName(base, secure) {
  return secure ? `__Host-${base}` : base;
}

// Secure for a cookie whose writer decides by the request (an invite's):
// always in production, else when the request reached the proxy over HTTPS.
function requestCookieSecure(req, env = process.env) {
  if (env.NODE_ENV === 'production' || req?.secure === true) return true;
  return String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// ── A preview of Homeroom, in a frame on another site ───────────────────
//
// A preview of Homeroom itself (USERNODE_ENV=staging) is shown in a frame on
// the platform's own page, and it signs its reviewer in by trading the frame's
// token for a session cookie of its own (middleware/auth.js). Since previews
// have a domain of their own (config.previewsDomain: onhomeroom.dev beside
// app.onhomeroom.com) that frame is on another site, where a browser neither
// keeps nor sends a SameSite=Lax cookie: the session was set, dropped, and the
// preview showed its signed-out "Sign in to open this page" sheet.
//
// So a preview's session cookie and its cache label are partitioned (CHIPS:
// SameSite=None, Secure, Partitioned), as the app gate's frame door is
// (edge-gate.js doorCookieOptions). The browser keeps them only under the
// top-level site that framed the preview, and a preview opened in a tab of
// its own keeps them as that tab's. Requests still need Homeroom's own page:
// the write guard (middleware/same-site-browser.js) refuses every
// cookie-carrying write the preview's page did not send, and the platform
// answers no credentialed CORS. `Partitioned` needs `Secure`, so a preview
// over plain HTTP (local development) keeps Lax. Production never takes this
// branch: the platform's own session stays Lax, never framed by another site.
function partitionedPreviewCookies(env = process.env) {
  return env.USERNODE_ENV === 'staging' && env.NODE_ENV === 'production';
}

// The SameSite half of the session's cookies (the session and its cache label).
function sessionSameSite(env = process.env) {
  return partitionedPreviewCookies(env) ? { sameSite: 'none', partitioned: true } : { sameSite: 'lax' };
}

// Before a preview writes the partitioned copy of a cookie, drop the
// unpartitioned Lax copy an earlier build left when the preview was opened in
// a tab of its own. With both, that tab sends the name twice, and
// readSessionCookie refuses a duplicated session. Inside the frame the browser
// ignores this deletion, as it ignores every Lax cookie there. `expires` is
// left out: Express's clearCookie would take it over its own past date.
function dropUnpartitionedCopy(res, name, options, env = process.env) {
  if (!partitionedPreviewCookies(env) || typeof res.clearCookie !== 'function') return;
  const unpartitioned = { ...options, sameSite: 'lax' };
  delete unpartitioned.partitioned;
  delete unpartitioned.expires;
  res.clearCookie(name, unpartitioned);
}

function sessionCookieOptions(expires, env = process.env) {
  return { httpOnly: true, secure: env.NODE_ENV === 'production',
    ...sessionSameSite(env), path: '/', ...(expires ? { expires: new Date(expires) } : {}) };
}

function setSessionCookie(res, token, expires) {
  const name = sessionCookieName();
  const options = sessionCookieOptions(expires);
  dropUnpartitionedCopy(res, name, options);
  res.cookie(name, token, options);
}

// Cookie parsers disagree about first/last duplicate wins. Refuse ambiguity
// before querying authority, including on WebSocket handshakes. Minimal test
// adapters may supply parsed cookies without a raw Cookie header.
function readSessionCookie(req, env = process.env) {
  const name = sessionCookieName(env);
  const header = req.headers?.cookie;
  if (header != null) {
    if (typeof header !== 'string') return null;
    const values = header.split(';').map(pair => pair.trim())
      .filter(pair => pair.slice(0, pair.indexOf('=')) === name);
    if (values.length !== 1) return null;
    const raw = values[0].slice(name.length + 1);
    try { return decodeURIComponent(raw) || null; } catch { return null; }
  }
  const value = req.cookies?.[name];
  return typeof value === 'string' && value ? value : null;
}

function clearSessionCookies(res) {
  const options = sessionCookieOptions();
  const secureScope = options.secure || res.req?.secure === true;
  res.clearCookie(sessionCookieName(), options);
  res.clearCookie(scopeCookieName(process.env, secureScope), { ...options, secure: secureScope, httpOnly: false });
  // Clear host-local legacy names too. Never read them in strict mode and
  // never widen deletion to a parent Domain we do not own.
  if (sessionCookieName() !== 'session') res.clearCookie('session', { path: '/' });
  if (secureScope) res.clearCookie('usernode_api_scope', { path: '/' });
}

module.exports = { isolationMode, sessionCookieName, scopeCookieName,
  sessionCookieOptions, setSessionCookie, readSessionCookie, clearSessionCookies,
  protectedCookieName, requestCookieSecure, partitionedPreviewCookies, sessionSameSite,
  dropUnpartitionedCopy };
