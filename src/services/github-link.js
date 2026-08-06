'use strict';

// Verified GitHub account link — IDENTITY ONLY.
//
// Shaped after routes/waitlist-connect.js's OAuth round-trip (authorize →
// callback → GET /user), with three differences that matter:
//
//   1. It asks for NO SCOPE AT ALL. GitHub's narrowest classic scope that can
//      fork a repository is `public_repo`, which grants read/write access to
//      code on *every* public repository the user can reach — and the only
//      reason this link ever wanted it was to create a fork on the user's
//      behalf. That fork is now made by the user's OWN coding agent (or by
//      one click on GitHub's fork page), so the platform needs nothing but
//      the login: a no-scope token reads public profile data, which is all
//      `GET /user` requires. Every other GitHub call in the fork path is
//      either a PUBLIC read (app repos and their forks are public —
//      services/github.js createRepo sets private:false) or a write made
//      with the platform's own bot credentials on the base repo.
//   2. NO TOKEN IS EVER STORED. The token that comes back from the code
//      exchange is used once, for that one `GET /user`, then best-effort
//      revoked and dropped on the floor. users.github_oauth_token_enc is
//      written NULL and exists only until every deployment has migrated off
//      it (see src/db/migrate.js revokeLegacyGithubGrants).
//   3. The login it records is AUTHORIZATION-GRADE. The pre-existing
//      `users.github` profile column is self-declared display text and must
//      never be used for an ownership decision; this one may. It is the ONLY
//      thing this link produces, and the attribution gate in
//      services/external-agent-tasks.js is the only thing that consumes it.
//
// The `state` parameter is a signed, single-use, session-bound nonce with a
// short TTL — an attacker-supplied callback must not be able to bind their
// GitHub identity to somebody else's Usernode account.

const crypto = require('crypto');
const log = require('./logger');

const STATE_TTL_MS = 10 * 60 * 1000;
// Deliberately empty: see (1) above. `authorizeUrl` omits the parameter
// entirely rather than sending `scope=`, so GitHub's consent screen reads
// "public data only" instead of naming repository write access.
const SCOPE = '';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const API_BASE = 'https://api.github.com';
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
  // No `scope` parameter at all. GitHub then issues a token with no scopes,
  // whose consent screen says "public data only" and which can do nothing
  // but read public information — see (1) at the top of this file.
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
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

// The OAuth app's own credential, for the two endpoints that are
// authenticated as the APPLICATION rather than as a user (token/grant
// revocation). Basic auth on client_id:client_secret, per
// docs.github.com/en/rest/apps/oauth-applications.
function appBasicAuth(creds) {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

// Hand a credential back to GitHub. Both revocations are BEST-EFFORT: the
// token has no scopes and is never stored, so a failure leaves nothing
// dangerous behind — it must never fail the link (or the migration).
//
//   'token' — DELETE /applications/{client_id}/token, kills just this token
//             and leaves the user's authorization record in place, so a
//             later re-link does not need a second trip through consent.
//   'grant' — DELETE /applications/{client_id}/grant, kills the whole
//             authorization INCLUDING any scope it accumulated. This is what
//             the legacy-token migration needs: a classic OAuth grant is
//             cumulative, so a previously-granted `public_repo` survives
//             re-authorizing with no scope and can only be handed back here.
async function revokeCredential(config, token, kind = 'token') {
  const creds = oauthCredentials(config);
  if (!creds || typeof token !== 'string' || !token) return false;
  const path = kind === 'grant' ? 'grant' : 'token';
  try {
    const resp = await fetch(
      `${API_BASE}/applications/${encodeURIComponent(creds.clientId)}/${path}`,
      {
        method: 'DELETE',
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

// Exchange the callback code for a token, resolve the login it belongs to,
// and hand the token straight back to GitHub. Returns { login } or null —
// the caller maps null onto a generic failure page rather than reflecting
// GitHub's error text. The token is deliberately NOT returned: nothing
// downstream of this function is allowed to hold a user credential.
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

  let verified = null;
  try {
    const userResp = await fetchJson(USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'usernode-social-vibecoding',
      },
    });
    // Validated before it is trusted: this string becomes an ownership
    // comparison in the attribution gate, so a malformed one is no login.
    const login = userResp.body && userResp.body.login;
    if (userResp.ok && typeof login === 'string' && LOGIN_RE.test(login)) {
      verified = login;
    }
  } finally {
    // Always, whether the login read worked or not: the token has done the
    // only job it will ever have.
    await revokeCredential(config, token, 'token');
  }
  if (!verified) return null;
  return { login: verified };
}

// The link is the login. `token` is accepted and ignored so an older caller
// cannot accidentally persist a credential; the column is written NULL on
// every link, which also clears a legacy value on re-link.
async function saveLink(pool, config, userId, { login }) {
  await pool.query(
    `UPDATE users
        SET github_login = $2,
            github_oauth_token_enc = NULL,
            github_linked_at = NOW()
      WHERE id = $1`,
    [userId, login]
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
// The link is `github_login` alone now — there is no token to be present,
// so requiring one would read every identity-only link as unlinked.
// `access` is what lets the Settings row state plainly that the platform
// holds no credential, rather than the client inferring it.
async function linkStatus(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT github_login, github_linked_at FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows.length) return { linked: false, login: null, linkedAt: null, access: 'identity' };
    const row = rows[0];
    return {
      linked: !!row.github_login,
      login: row.github_login || null,
      linkedAt: row.github_linked_at ? new Date(row.github_linked_at).toISOString() : null,
      access: 'identity',
    };
  } catch (err) {
    log.warn('github-link', 'link status read failed', { userId, err: err.message });
    return { linked: false, login: null, linkedAt: null, access: 'identity' };
  }
}

// Staging mock data: users.github_login is only ever set by a real OAuth
// round-trip, which a staging clone cannot carry out, so the connected
// layout (login + "no token held" + Disconnect) would never be reviewable.
// Honoured only in staging, only with ?demo=1 — a strict no-op in
// production.
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
  STATE_TTL_MS,
  LOGIN_RE,
  isEnabled,
  oauthCredentials,
  makeState,
  verifyState,
  authorizeUrl,
  exchangeCode,
  revokeCredential,
  saveLink,
  clearLink,
  linkStatus,
  demoLinkStatus,
};
