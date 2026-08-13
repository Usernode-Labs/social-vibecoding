'use strict';

// GitHub adapter for the generic social-identity link.
//
// This OAuth app is deliberately dedicated to account linking. GitHub OAuth
// apps have one callback URL, so silently falling back to the waitlist app
// made one of the two flows dead on arrival. The authorization asks for no
// scope, uses PKCE S256, resolves the immutable numeric account id plus the
// current login, then revokes and discards the access token.

const log = require('./logger');
const socialIdentity = require('./social-identity');

const SCOPE = '';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const API_BASE = 'https://api.github.com';
const PROVIDER_TIMEOUT_MS = 10_000;
const LOGIN_RE = socialIdentity.HANDLE_RE.github;

function oauthCredentials(config) {
  const clientId = (config && config.githubLinkClientId)
    || process.env.GITHUB_LINK_CLIENT_ID || '';
  const clientSecret = (config && config.githubLinkClientSecret)
    || process.env.GITHUB_LINK_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function isEnabled(config) {
  return !!oauthCredentials(config);
}

function authorizeUrl(config, { redirectUri, state, challenge }) {
  const creds = oauthCredentials(config);
  if (!creds || !socialIdentity.STATE_RE.test(String(state || ''))
      || !/^[A-Za-z0-9_-]{43}$/.test(String(challenge || ''))) return null;
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'false',
  });
  // No `scope` parameter at all. A dedicated app plus the response-scope
  // check below makes "identity only" an enforced property, not just copy.
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function timeoutSignal() {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, { ...options, signal: timeoutSignal() });
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { ok: resp.ok, status: resp.status, body };
}

function appBasicAuth(creds) {
  return `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64')}`;
}

// Revocation is best-effort because the token is never persisted. `grant`
// is used if a misconfigured/reused app returns any cumulative scope; that
// removes the unexpected authorization rather than accepting a privileged
// token for even this one identity read.
async function revokeCredential(config, token, kind = 'token') {
  const creds = oauthCredentials(config);
  if (!creds || typeof token !== 'string' || !token) return false;
  const path = kind === 'grant' ? 'grant' : 'token';
  try {
    const resp = await fetch(
      `${API_BASE}/applications/${encodeURIComponent(creds.clientId)}/${path}`,
      {
        method: 'DELETE',
        signal: timeoutSignal(),
        headers: {
          authorization: appBasicAuth(creds),
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'usernode-social-vibecoding',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: token }),
      }
    );
    if (!resp.ok) {
      log.warn('github-link', 'credential revoke refused', { kind, status: resp.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('github-link', 'credential revoke failed', { kind, err: err.message });
    return false;
  }
}

async function exchangeCode(config, { code, redirectUri, verifier }) {
  const creds = oauthCredentials(config);
  if (!creds || typeof code !== 'string' || !code
      || typeof verifier !== 'string' || verifier.length < 43) return null;

  const tokenResp = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const token = tokenResp.body && tokenResp.body.access_token;
  if (!tokenResp.ok || typeof token !== 'string' || !token) return null;

  const returnedScope = tokenResp.body && tokenResp.body.scope;
  const unexpectedScope = typeof returnedScope !== 'string' || returnedScope.trim() !== '';
  const revokeKind = unexpectedScope ? 'grant' : 'token';
  try {
    if (unexpectedScope) {
      log.warn('github-link', 'refusing non-empty OAuth scope from identity app');
      return null;
    }
    const userResp = await fetchJson(USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'usernode-social-vibecoding',
        'x-github-api-version': '2022-11-28',
      },
    });
    const body = userResp.body || {};
    const handle = body.login;
    const id = body.id;
    if (!userResp.ok || typeof handle !== 'string' || !LOGIN_RE.test(handle)
        || !Number.isSafeInteger(id) || id <= 0) return null;
    return { provider: 'github', subject: String(id), handle };
  } finally {
    await revokeCredential(config, token, revokeKind);
  }
}

async function saveLink(pool, _config, userId, linked) {
  return socialIdentity.saveIdentity(pool, userId, {
    provider: 'github',
    subject: linked && linked.subject,
    handle: linked && (linked.handle || linked.login),
  });
}

async function clearLink(pool, userId) {
  return socialIdentity.clearIdentity(pool, userId, 'github');
}

// Compatibility surface for the existing GitHub-attribution consumers.
// Those readers need the verified login, while the generic table's immutable
// subject remains the credit/uniqueness authority.
async function linkStatus(pool, userId) {
  try {
    const { rows } = await pool.query(
      'SELECT github_login, github_linked_at FROM users WHERE id = $1',
      [userId]
    );
    const row = rows[0];
    return {
      linked: !!(row && row.github_login),
      login: row && row.github_login || null,
      linkedAt: row && row.github_linked_at
        ? new Date(row.github_linked_at).toISOString()
        : null,
      access: 'identity',
    };
  } catch (err) {
    log.warn('github-link', 'link status read failed', { userId, err: err.message });
    return { linked: false, login: null, linkedAt: null, access: 'identity' };
  }
}

function demoLinkStatus() {
  const day = 24 * 60 * 60 * 1000;
  return {
    linked: true,
    login: 'octo-contributor',
    linkedAt: new Date(Date.now() - 6 * day).toISOString(),
    access: 'identity',
    demo: true,
  };
}

module.exports = {
  SCOPE,
  PROVIDER_TIMEOUT_MS,
  LOGIN_RE,
  isEnabled,
  oauthCredentials,
  authorizeUrl,
  exchangeCode,
  revokeCredential,
  saveLink,
  clearLink,
  linkStatus,
  demoLinkStatus,
};
