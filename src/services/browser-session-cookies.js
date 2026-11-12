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

function sessionCookieOptions(expires, env = process.env) {
  return { httpOnly: true, secure: env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', ...(expires ? { expires: new Date(expires) } : {}) };
}

function setSessionCookie(res, token, expires) {
  res.cookie(sessionCookieName(), token, sessionCookieOptions(expires));
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
  protectedCookieName, requestCookieSecure };
