'use strict';

// Both the planner browser and deterministic replay reach private previews
// over HTTP. A self-app preview runs in production mode and exchanges its
// app-scoped JWT for a Secure session cookie, which Chromium cannot retain on
// those HTTP origins. Install that already-issued, clone-local cookie with
// the transport bit adjusted only inside the isolated evidence context.
class SessionBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sessionCookieValue(headers) {
  for (const header of headers || []) {
    if (String(header?.name || '').toLowerCase() !== 'set-cookie') continue;
    const first = String(header.value || '').split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator < 0 || first.slice(0, separator).trim() !== 'session') continue;
    const value = first.slice(separator + 1).trim();
    // Never include the rejected cookie or token in a diagnostic.
    if (!value || value.length > 4096
        || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)) {
      throw new SessionBootstrapError('invalid_session_cookie', 'The evidence origin returned an invalid session cookie.');
    }
    return value;
  }
  return null;
}

async function bootstrapInternalSession(context, origin, authorizedUrl, authToken, diagnostic = null, timeoutMs = 10_000) {
  if (diagnostic) diagnostic.attempted = origin.startsWith('http:');
  if (!origin.startsWith('http:')) return false;
  if (new URL(authorizedUrl).origin !== origin) {
    throw new SessionBootstrapError('cross_origin_navigation', 'Evidence authentication left its private origin.');
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
      throw new SessionBootstrapError('session_bootstrap_failed', 'The evidence browser could not install its private session cookie.');
    }
    const installed = await context.cookies(origin);
    if (!installed.some((cookie) => cookie.name === 'session' && cookie.value === value)) {
      throw new SessionBootstrapError('session_bootstrap_failed', 'The evidence browser did not retain its private session cookie.');
    }
    if (diagnostic) diagnostic.sessionCookieInstalled = true;
    return true;
  } finally {
    await response?.dispose?.().catch(() => {});
  }
}

module.exports = { SessionBootstrapError, sessionCookieValue, bootstrapInternalSession };
