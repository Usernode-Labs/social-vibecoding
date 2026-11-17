'use strict';

// Both the planner browser and deterministic replay reach private previews
// over HTTP. A self-app preview runs in production mode and exchanges its
// app-scoped JWT for a Secure session cookie, which Chromium cannot retain on
// those HTTP origins. Install that already-issued, clone-local cookie with
// the transport bit adjusted only inside the isolated shots context.
class SessionBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A header clears its cookie when it carries no value, when Max-Age parses to
// an integer of 0 or less, or when Expires parses to a date at or before now.
// An attribute that does not parse (Max-Age=abc, a bad date) does not make a
// header a clear. Since #6743 a preview writes the partitioned copy after a
// clearing Lax one, so the clear must be skipped rather than read as the
// session's value.
function clearingSessionCookie(parts) {
  const attributes = new Map();
  for (const part of parts) {
    const separator = part.indexOf('=');
    const name = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
    if (name !== 'max-age' && name !== 'expires') continue;
    attributes.set(name, separator < 0 ? '' : part.slice(separator + 1).trim());
  }
  const maxAge = attributes.get('max-age');
  if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) {
    const seconds = Number(maxAge);
    if (Number.isSafeInteger(seconds) && seconds <= 0) return true;
  }
  const expires = attributes.get('expires');
  if (expires !== undefined) {
    const at = Date.parse(expires);
    if (Number.isFinite(at) && at <= Date.now()) return true;
  }
  return false;
}

function sessionCookieValue(headers) {
  let found = null;
  for (const header of headers || []) {
    if (String(header?.name || '').toLowerCase() !== 'set-cookie') continue;
    const parts = String(header.value || '').split(';');
    const first = parts[0];
    const separator = first.indexOf('=');
    if (separator < 0 || first.slice(0, separator).trim() !== 'session') continue;
    const value = first.slice(separator + 1).trim();
    // A clearing copy says nothing about the session: keep looking, and use
    // the last header that sets a value.
    if (!value || clearingSessionCookie(parts.slice(1))) continue;
    // Never include the rejected cookie or token in a diagnostic.
    if (value.length > 4096
        || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)) {
      throw new SessionBootstrapError('invalid_session_cookie', 'The shots origin returned an invalid session cookie.');
    }
    found = value;
  }
  return found;
}

async function bootstrapInternalSession(context, origin, authorizedUrl, authToken, diagnostic = null, timeoutMs = 10_000) {
  if (diagnostic) diagnostic.attempted = origin.startsWith('http:');
  if (!origin.startsWith('http:')) return false;
  if (new URL(authorizedUrl).origin !== origin) {
    throw new SessionBootstrapError('cross_origin_navigation', 'Shots authentication left its private origin.');
  }
  const existing = await context.cookies(origin);
  if (existing.some((cookie) => cookie.name === 'session')) {
    if (diagnostic) diagnostic.cookieAlreadyPresent = true;
    return false;
  }

  let response;
  try {
    response = await context.request.get(authorizedUrl, {
      headers: { 'x-usernode-token': authToken },
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: timeoutMs,
    });
    if (diagnostic) diagnostic.responseStatus = response.status();
    const value = sessionCookieValue(await Promise.resolve(response.headersArray()));
    // Child apps that do not issue a session cookie still use their normal
    // token-bearing navigation and local storage below.
    if (!value) return false;
    try {
      await context.addCookies([{
        name: 'session', value, url: origin, httpOnly: true,
        secure: false, sameSite: 'Lax',
      }]);
    } catch (_) {
      throw new SessionBootstrapError('session_bootstrap_failed', 'The shots browser could not install its private session cookie.');
    }
    const installed = await context.cookies(origin);
    if (!installed.some((cookie) => cookie.name === 'session' && cookie.value === value)) {
      throw new SessionBootstrapError('session_bootstrap_failed', 'The shots browser did not retain its private session cookie.');
    }
    if (diagnostic) diagnostic.sessionCookieInstalled = true;
    return true;
  } finally {
    await response?.dispose?.().catch(() => {});
  }
}

module.exports = { SessionBootstrapError, sessionCookieValue, bootstrapInternalSession };
