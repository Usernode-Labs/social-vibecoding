// Waitlist social-connect OAuth (two-stage waitlist survey, ported from
// the original topochain waitlist's GitHub / X verification).
//
// A waitlist signer on the stage-2 "Want in sooner?" form can verify a
// GitHub or X account — "connecting an account proves you're a person
// with a history, which is most of what gets a signup read quickly".
// There is no platform account involved: the signup's unguessable
// `more_token` is the capability, carried through the OAuth round-trip
// in the `state` parameter (a random nonce keyed to a short-lived
// server-side record — the token itself never appears in provider URLs
// or referer headers).
//
// Config-gated per provider (WAITLIST_GITHUB_CLIENT_ID/SECRET,
// WAITLIST_X_CLIENT_ID/SECRET): without credentials the start route
// bounces back to the form and the SPA shows a plain text input instead
// of a connect button (the GET /api/public/waitlist/more/:token payload
// carries per-provider availability).
//
// Verified handles land under answers.verified.{github,x} — distinct
// from the self-reported answers.handles entries.
'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const waitlist = require('../services/waitlist');
const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');

// state nonce → { token, provider, verifier, expiresAt }. In-memory is
// fine: the platform is a single process, and an entry only needs to
// survive the seconds-long hop to the provider and back.
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function putState(entry) {
  // Opportunistic sweep so abandoned round-trips don't accumulate.
  const now = Date.now();
  for (const [k, v] of pending) {
    if (v.expiresAt < now) pending.delete(k);
  }
  const nonce = crypto.randomBytes(24).toString('hex');
  pending.set(nonce, { ...entry, expiresAt: now + STATE_TTL_MS });
  return nonce;
}

function takeState(nonce) {
  const entry = pending.get(nonce);
  if (!entry) return null;
  pending.delete(nonce);
  return entry.expiresAt < Date.now() ? null : entry;
}

// Where the round-trip lands back in the SPA. `status` rides in the
// hash's query segment (after '?' INSIDE the fragment) so it never
// reaches any server log, ours or a proxy's.
function formUrl(token, status) {
  return `/#more/${token}` + (status ? `?connect=${status}` : '');
}

function providerConfig(config, provider) {
  if (provider === 'github') {
    return config.waitlistGithubClientId && config.waitlistGithubClientSecret
      ? { id: config.waitlistGithubClientId, secret: config.waitlistGithubClientSecret }
      : null;
  }
  if (provider === 'x') {
    return config.waitlistXClientId && config.waitlistXClientSecret
      ? { id: config.waitlistXClientId, secret: config.waitlistXClientSecret }
      : null;
  }
  return null;
}

// The redirect_uri registered with the OAuth apps. Overridable for
// staging (WAITLIST_OAUTH_ORIGIN); defaults to the production origin in
// production and localhost in dev. The provider validates it against
// the app's registered callback either way.
function connectOrigin(config) {
  if (config.waitlistOauthOrigin) return config.waitlistOauthOrigin;
  if (config.env === 'production') return PRODUCTION_ORIGIN;
  return `http://localhost:${config.port}`;
}

function callbackUrl(config, provider) {
  return `${connectOrigin(config)}/waitlist/connect/${provider}/callback`;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { /* provider error page */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

// Exchange the authorization code and resolve the account's handle.
async function resolveHandle(provider, creds, code, redirectUri, verifier) {
  if (provider === 'github') {
    const tokenResp = await fetchJson('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: creds.id,
        client_secret: creds.secret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResp || !tokenResp.access_token) throw new Error('no access token');
    const user = await fetchJson('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${tokenResp.access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'usernode-waitlist',
      },
    });
    if (!user || !user.login) throw new Error('no login in profile');
    return String(user.login);
  }

  // X (OAuth 2.0 with PKCE; confidential client → Basic auth on the
  // token exchange).
  const basic = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: creds.id,
  });
  const tokenResp = await fetchJson('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: form.toString(),
  });
  if (!tokenResp || !tokenResp.access_token) throw new Error('no access token');
  const me = await fetchJson('https://api.x.com/2/users/me', {
    headers: { authorization: `Bearer ${tokenResp.access_token}` },
  });
  const username = me && me.data && me.data.username;
  if (!username) throw new Error('no username in profile');
  return String(username);
}

function waitlistConnectRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /waitlist/connect/:provider?token=… ──────────────────────────
  // Starts the round-trip: validates the capability token, parks a state
  // record, and redirects to the provider's authorize page.
  router.get('/waitlist/connect/:provider', async (req, res) => {
    const provider = req.params.provider;
    if (provider !== 'github' && provider !== 'x') return res.status(404).end();

    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const row = await waitlist.getSignupByMoreToken(pool, token).catch(() => null);
    if (!row) return res.redirect('/#landing');

    const creds = providerConfig(config, provider);
    if (!creds) return res.redirect(formUrl(token, 'unavailable'));

    const redirectUri = callbackUrl(config, provider);

    if (provider === 'github') {
      const state = putState({ token, provider });
      const url = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
        client_id: creds.id,
        redirect_uri: redirectUri,
        state,
        allow_signup: 'false',
      });
      return res.redirect(url);
    }

    // X: PKCE is mandatory. The verifier stays server-side in the state
    // record; only its S256 challenge goes to the provider.
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = putState({ token, provider, verifier });
    const url = 'https://x.com/i/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id: creds.id,
      redirect_uri: redirectUri,
      scope: 'users.read tweet.read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return res.redirect(url);
  });

  // ── GET /waitlist/connect/:provider/callback ─────────────────────────
  // Provider redirect target: exchange the code, store the verified
  // handle on the signup, land back on the stage-2 form.
  router.get('/waitlist/connect/:provider/callback', async (req, res) => {
    const provider = req.params.provider;
    if (provider !== 'github' && provider !== 'x') return res.status(404).end();

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const entry = takeState(state);
    if (!entry || entry.provider !== provider) {
      // Expired / replayed / cross-provider state: nothing to recover.
      return res.redirect('/#landing');
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      // User denied on the provider page.
      return res.redirect(formUrl(entry.token, 'denied'));
    }

    const creds = providerConfig(config, provider);
    if (!creds) return res.redirect(formUrl(entry.token, 'unavailable'));

    try {
      const handle = await resolveHandle(
        provider, creds, code, callbackUrl(config, provider), entry.verifier
      );
      const updated = await waitlist.setVerifiedHandle(pool, entry.token, provider, handle);
      if (!updated) return res.redirect('/#landing');
      log.info('waitlist-connect', 'Social handle verified', { provider });
      return res.redirect(formUrl(entry.token, 'ok'));
    } catch (err) {
      log.error('waitlist-connect', 'OAuth exchange failed', {
        provider, message: err.message,
      });
      return res.redirect(formUrl(entry.token, 'failed'));
    }
  });

  return router;
}

module.exports = { waitlistConnectRoutes };
