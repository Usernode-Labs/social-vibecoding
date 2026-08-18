'use strict';

// X OAuth 2.0 + PKCE adapter for social identity. It requests the minimum
// scopes X currently requires for GET /2/users/me, reads the immutable user
// id + current username, revokes the token, and returns no credential.

const log = require('./logger');
const socialIdentity = require('./social-identity');

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const USER_URL = 'https://api.x.com/2/users/me';
const REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
const SCOPES = Object.freeze(['tweet.read', 'users.read']);
const PROVIDER_TIMEOUT_MS = 10_000;
const USERNAME_RE = socialIdentity.HANDLE_RE.x;

function oauthCredentials(config) {
  const dedicatedId = (config && config.xLinkClientId)
    || process.env.X_LINK_CLIENT_ID || '';
  const dedicatedSecret = (config && config.xLinkClientSecret)
    || process.env.X_LINK_CLIENT_SECRET || '';
  // A partially configured dedicated client is an operator error, not a
  // signal to splice in one half of the waitlist client. OAuth credentials
  // are an indivisible pair.
  if (dedicatedId || dedicatedSecret) {
    return dedicatedId && dedicatedSecret
      ? { clientId: dedicatedId, clientSecret: dedicatedSecret }
      : null;
  }

  const fallbackId = (config && config.waitlistXClientId)
    || process.env.WAITLIST_X_CLIENT_ID || '';
  const fallbackSecret = (config && config.waitlistXClientSecret)
    || process.env.WAITLIST_X_CLIENT_SECRET || '';
  return fallbackId && fallbackSecret
    ? { clientId: fallbackId, clientSecret: fallbackSecret }
    : null;
}

function isEnabled(config) {
  return !!oauthCredentials(config);
}

// Which pair oauthCredentials() would hand out, for diagnostics: the
// account-linking flow silently reuses the waitlist X app's credentials
// when no dedicated pair is set, and that app only works here if its
// developer-portal registration also lists the /api/me/x/callback URL
// (#1291). Mirrors oauthCredentials' precedence exactly, including the
// partial-dedicated-pair ⇒ disabled rule.
function credentialSource(config) {
  const dedicatedId = (config && config.xLinkClientId)
    || process.env.X_LINK_CLIENT_ID || '';
  const dedicatedSecret = (config && config.xLinkClientSecret)
    || process.env.X_LINK_CLIENT_SECRET || '';
  if (dedicatedId || dedicatedSecret) {
    return dedicatedId && dedicatedSecret ? 'dedicated' : null;
  }
  const fallbackId = (config && config.waitlistXClientId)
    || process.env.WAITLIST_X_CLIENT_ID || '';
  const fallbackSecret = (config && config.waitlistXClientSecret)
    || process.env.WAITLIST_X_CLIENT_SECRET || '';
  return fallbackId && fallbackSecret ? 'waitlist' : null;
}

// A dedicated pair whose client id equals the waitlist pair's is the same
// X app pasted under a different variable name — the callback-registration
// requirement still applies. Client ids only; secrets never compared.
function sameAppAsWaitlist(config) {
  if (credentialSource(config) !== 'dedicated') return false;
  const waitlistId = (config && config.waitlistXClientId)
    || process.env.WAITLIST_X_CLIENT_ID || '';
  const creds = oauthCredentials(config);
  return !!waitlistId && !!creds && creds.clientId === waitlistId;
}

// Live probe of the active pair against X's token endpoint, using a
// deliberately bogus authorization code. The grant always fails; what the
// failure looks like tells the pair's validity apart: a 401 (or an
// explicit invalid_client) means X rejected the Basic auth — the pair is
// wrong — while any other 4xx means client auth passed and only the grant
// was refused, as expected. No user token is ever minted.
async function checkClientCredentials(config) {
  const creds = oauthCredentials(config);
  if (!creds) return 'indeterminate';
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'diagnostic-probe-invalid-code',
    redirect_uri: 'https://invalid.example/api/me/x/callback',
    code_verifier: 'p'.repeat(43),
    client_id: creds.clientId,
  });
  try {
    const resp = await fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: basicAuth(creds),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    const errorCode = resp.body && typeof resp.body.error === 'string'
      ? resp.body.error
      : '';
    if (resp.status === 401 || errorCode === 'invalid_client') return 'rejected';
    if (resp.status >= 400 && resp.status < 500) return 'ok';
    return 'indeterminate';
  } catch (err) {
    log.warn('x-link', 'credential check unreachable', { err: err.message });
    return 'indeterminate';
  }
}

function authorizeUrl(config, { redirectUri, state, challenge }) {
  const creds = oauthCredentials(config);
  if (!creds || !socialIdentity.STATE_RE.test(String(state || ''))
      || !/^[A-Za-z0-9_-]{43}$/.test(String(challenge || ''))) return null;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function timeoutSignal() {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}

function basicAuth(creds) {
  return `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64')}`;
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, { ...options, signal: timeoutSignal() });
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { ok: resp.ok, status: resp.status, body };
}

async function revokeCredential(config, token) {
  const creds = oauthCredentials(config);
  if (!creds || typeof token !== 'string' || !token) return false;
  try {
    const body = new URLSearchParams({ token, client_id: creds.clientId });
    const resp = await fetch(REVOKE_URL, {
      method: 'POST',
      signal: timeoutSignal(),
      headers: {
        authorization: basicAuth(creds),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      log.warn('x-link', 'credential revoke refused', { status: resp.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('x-link', 'credential revoke failed', { err: err.message });
    return false;
  }
}

function scopeIsExact(value) {
  if (typeof value !== 'string') return false;
  const actual = value.split(/\s+/).filter(Boolean).sort();
  const expected = [...SCOPES].sort();
  return actual.length === expected.length
    && actual.every((scope, index) => scope === expected[index]);
}

async function exchangeCode(config, { code, redirectUri, verifier }) {
  const creds = oauthCredentials(config);
  if (!creds || typeof code !== 'string' || !code
      || typeof verifier !== 'string' || verifier.length < 43) return null;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: creds.clientId,
  });
  const tokenResp = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(creds),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });
  const token = tokenResp.body && tokenResp.body.access_token;
  if (!tokenResp.ok || typeof token !== 'string' || !token) {
    // The code/verifier never leave this function; X's own error strings
    // are what an admin needs to tell a bad pair from a bad grant.
    log.warn('x-link', 'token exchange refused', {
      status: tokenResp.status,
      error: String((tokenResp.body && tokenResp.body.error) || '').slice(0, 64),
      description: String((tokenResp.body && tokenResp.body.error_description) || '').slice(0, 200),
    });
    return null;
  }

  try {
    if (!scopeIsExact(tokenResp.body.scope)) {
      log.warn('x-link', 'refusing unexpected OAuth scope from identity app');
      return null;
    }
    const userResp = await fetchJson(USER_URL, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const user = userResp.body && userResp.body.data || {};
    const subject = String(user.id || '');
    const handle = user.username;
    if (!userResp.ok || !socialIdentity.SUBJECT_RE.test(subject)
        || typeof handle !== 'string' || !USERNAME_RE.test(handle)) return null;
    return { provider: 'x', subject, handle };
  } finally {
    await revokeCredential(config, token);
  }
}

module.exports = {
  SCOPES,
  PROVIDER_TIMEOUT_MS,
  USERNAME_RE,
  oauthCredentials,
  credentialSource,
  sameAppAsWaitlist,
  checkClientCredentials,
  isEnabled,
  authorizeUrl,
  exchangeCode,
  revokeCredential,
  scopeIsExact,
};
