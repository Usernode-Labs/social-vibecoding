'use strict';

// Verified GitHub account link.
//
// Shaped after routes/waitlist-connect.js's OAuth round-trip (authorize →
// callback → GET /user), with three differences that matter:
//
//   1. It asks for the `public_repo` scope, because it has ONE privileged
//      use: creating a fork of an app's repo into the user's own account on
//      their behalf. App repos are public (services/github.js createRepo
//      sets private:false), so reads of that fork need no credential and PR
//      creation happens with the platform's bot token on the base repo.
//   2. The resulting token is stored encrypted (services/secrets.js, the
//      same AES-256-GCM envelope as users.anthropic_key_enc) and is never
//      returned to a browser.
//   3. The login it records is AUTHORIZATION-GRADE. The pre-existing
//      `users.github` profile column is self-declared display text and must
//      never be used for an ownership decision; this one may.
//
// The `state` parameter is a signed, single-use, session-bound nonce with a
// short TTL — an attacker-supplied callback must not be able to bind their
// GitHub identity to somebody else's Usernode account.

const crypto = require('crypto');
const secrets = require('./secrets');
const log = require('./logger');

const STATE_TTL_MS = 10 * 60 * 1000;
const SCOPE = 'public_repo';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// The OAuth app credentials. A deployment may either reuse the waitlist's
// GitHub app (adding this callback URL to it) or configure a dedicated one;
// with neither set the whole link surface 404s and the connector reports
// `github_link_unavailable` rather than half-working.
function oauthCredentials(config) {
  const clientId = process.env.GITHUB_LINK_CLIENT_ID
    || (config && config.waitlistGithubClientId) || '';
  const clientSecret = process.env.GITHUB_LINK_CLIENT_SECRET
    || (config && config.waitlistGithubClientSecret) || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function isEnabled(config) {
  return !!oauthCredentials(config);
}

// ── state ───────────────────────────────────────────────────────────────
//
// `<userId>.<expiry>.<nonce>.<hmac>`. Signed with the platform session
// secret so it cannot be forged, carrying the user id so the callback binds
// to the account that STARTED the flow rather than whatever session happens
// to present the code.

function stateSecret(config) {
  return (config && config.sessionSecret) || process.env.SESSION_SECRET || '';
}

function signState(config, userId, nonce, expiresAt) {
  return crypto.createHmac('sha256', stateSecret(config))
    .update(`github-link\0${userId}\0${expiresAt}\0${nonce}`, 'utf8')
    .digest('base64url');
}

function makeState(config, userId) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const expiresAt = Date.now() + STATE_TTL_MS;
  const mac = signState(config, userId, nonce, expiresAt);
  return `${userId}.${expiresAt}.${nonce}.${mac}`;
}

function verifyState(config, value, userId) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [rawUser, rawExpiry, nonce, mac] = parts;
  if (!/^[1-9][0-9]{0,9}$/.test(rawUser) || !/^[0-9]{10,16}$/.test(rawExpiry)) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) return null;
  const stateUserId = Number(rawUser);
  // Bound to the browser session presenting the callback.
  if (Number(userId) !== stateUserId) return null;
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) return null;
  const expected = signState(config, stateUserId, nonce, expiresAt);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId: stateUserId, nonce, expiresAt };
}

function authorizeUrl(config, { userId, redirectUri }) {
  const creds = oauthCredentials(config);
  if (!creds) return null;
  const state = makeState(config, userId);
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    allow_signup: 'false',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { ok: resp.ok, status: resp.status, body };
}

// Exchange the callback code for a token and resolve the login it belongs
// to. Returns { login, token } or null — the caller maps null onto a
// generic failure page rather than reflecting GitHub's error text.
async function exchangeCode(config, { code, redirectUri }) {
  const creds = oauthCredentials(config);
  if (!creds) return null;
  const tokenResp = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = tokenResp.body && tokenResp.body.access_token;
  if (!tokenResp.ok || typeof token !== 'string' || !token) return null;

  const userResp = await fetchJson(USER_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'usernode-social-vibecoding',
    },
  });
  const login = userResp.body && userResp.body.login;
  if (!userResp.ok || typeof login !== 'string' || !LOGIN_RE.test(login)) return null;
  return { login, token };
}

async function saveLink(pool, config, userId, { login, token }) {
  const enc = secrets.encrypt(token, config.dataEncryptionKey);
  await pool.query(
    `UPDATE users
        SET github_login = $2,
            github_oauth_token_enc = $3,
            github_linked_at = NOW()
      WHERE id = $1`,
    [userId, login, enc]
  );
}

async function clearLink(pool, userId) {
  await pool.query(
    `UPDATE users
        SET github_login = NULL,
            github_oauth_token_enc = NULL,
            github_linked_at = NULL
      WHERE id = $1`,
    [userId]
  );
}

// Non-secret status for the Settings row and the connector's `whoami`.
// Never includes the token.
async function linkStatus(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT github_login, github_linked_at,
              (github_oauth_token_enc IS NOT NULL) AS has_token
         FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows.length) return { linked: false, login: null, linkedAt: null };
    const row = rows[0];
    return {
      linked: !!(row.github_login && row.has_token),
      login: row.github_login || null,
      linkedAt: row.github_linked_at ? new Date(row.github_linked_at).toISOString() : null,
    };
  } catch (err) {
    log.warn('github-link', 'link status read failed', { userId, err: err.message });
    return { linked: false, login: null, linkedAt: null };
  }
}

// The user's decrypted OAuth token, for the ONE privileged operation
// (forking an app repo into their account). A decrypt failure is treated as
// "not linked", matching how limits.loadUserApiKey tolerates the same case.
async function loadUserToken(pool, config, userId) {
  try {
    const { rows } = await pool.query(
      'SELECT github_login, github_oauth_token_enc FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length || !rows[0].github_oauth_token_enc) return null;
    const token = secrets.decrypt(rows[0].github_oauth_token_enc, config.dataEncryptionKey);
    if (!token) {
      log.warn('github-link', 'token decryption failed; treating as unlinked', { userId });
      return null;
    }
    return { login: rows[0].github_login, token };
  } catch (err) {
    log.warn('github-link', 'token load failed', { userId, err: err.message });
    return null;
  }
}

// Staging mock data: users.github_oauth_token_enc is staging:private, so a
// staging clone always renders the unlinked state and the connected layout
// (login + Disconnect) would never be reviewable. Honoured only in staging,
// only with ?demo=1 — a strict no-op in production.
function demoLinkStatus() {
  const day = 24 * 60 * 60 * 1000;
  return {
    linked: true,
    login: 'octo-contributor',
    linkedAt: new Date(Date.now() - 6 * day).toISOString(),
    demo: true,
  };
}

module.exports = {
  SCOPE,
  STATE_TTL_MS,
  LOGIN_RE,
  isEnabled,
  oauthCredentials,
  makeState,
  verifyState,
  authorizeUrl,
  exchangeCode,
  saveLink,
  clearLink,
  linkStatus,
  loadUserToken,
  demoLinkStatus,
};
