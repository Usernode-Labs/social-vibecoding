// Waitlist social-connect OAuth (two-stage waitlist survey, ported from
// the original topochain waitlist's GitHub / X verification).
//
// A waitlist signer on the stage-2 "Want in sooner?" form can verify a
// GitHub, X or LinkedIn account — "connecting an account proves you're a
// person with a history, which is most of what gets a signup read
// quickly".
//
// What this proves is ACCOUNT OWNERSHIP, and nothing more. The onboarding
// doc asks to "verify that the follow action was completed"; that cannot
// be built as asked. LinkedIn exposes no API reporting whether a member
// follows a page, and neither does Instagram; X can answer it, but only
// with the follows.read scope on a paid API tier. So the form says
// "connect" and never claims a follow was checked.
// There is no platform account involved: the signup's unguessable
// `more_token` is the capability, carried through the OAuth round-trip
// in the `state` parameter (a random nonce keyed to a short-lived
// server-side record — the token itself never appears in provider URLs
// or referer headers).
//
// Config-gated per provider (WAITLIST_GITHUB_CLIENT_ID/SECRET,
// WAITLIST_X_CLIENT_ID/SECRET, WAITLIST_LINKEDIN_CLIENT_ID/SECRET):
// without credentials the start route
// bounces back to the form and the SPA shows a plain text input instead
// of a connect button (the GET /api/public/waitlist/more/:token payload
// carries per-provider availability).
//
// Verified handles land under answers.verified.{github,x,linkedin} —
// distinct from the self-reported answers.handles entries.
'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const waitlist = require('../services/waitlist');
const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');

// Every provider this router serves. Both routes gate on it, so adding a
// fourth is one edit rather than two divergent conditions.
const PROVIDERS = new Set(['github', 'x', 'linkedin']);

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

// state nonce → { token, status, provider, expiresAt }, for a round trip
// that has already finished.
//
// `takeState` consumes the nonce, so the SECOND request to a callback URL
// found nothing and fell through to `/#landing` — the public landing page,
// with no message and no log line, after a provider round trip that had
// already succeeded and stored the handle. Reported from production on
// 2026-08-27 for GitHub and again for X: the server logged "Social handle
// verified" both times, and both times the person landed on the home screen
// instead of their form.
//
// A second request is ordinary: the back button, a reload, copying the URL
// out of the address bar and reopening it, a link scanner, a browser retry.
// So a finished round trip remembers WHERE it landed, and a repeat replays
// that same destination.
//
// It records the outcome, never the authorization code, and the replay is a
// redirect and nothing else — the code is single-use at the provider, so
// re-exchanging it could only turn a success into an error. Reading is
// deliberately non-destructive: people reload more than once. The record
// holds no more than the caller already has (they must present the state
// nonce, which was minted for that token and rides in their own URL), and it
// expires on the same clock as the pending state.
const completed = new Map();

function rememberOutcome(nonce, provider, token, status) {
  const now = Date.now();
  for (const [k, v] of completed) {
    if (v.expiresAt < now) completed.delete(k);
  }
  completed.set(nonce, { token, status, provider, expiresAt: now + STATE_TTL_MS });
}

function peekOutcome(nonce, provider) {
  const done = completed.get(nonce);
  if (!done || done.provider !== provider) return null;
  if (done.expiresAt < Date.now()) {
    completed.delete(nonce);
    return null;
  }
  return done;
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
  if (provider === 'linkedin') {
    return config.waitlistLinkedinClientId && config.waitlistLinkedinClientSecret
      ? { id: config.waitlistLinkedinClientId, secret: config.waitlistLinkedinClientSecret }
      : null;
  }
  return null;
}

// The redirect_uri registered with the OAuth apps. All three providers
// validate it against the app's registered callback BEFORE any platform
// code runs, so a wrong value fails on the provider's own page — after the
// person has left the site, with no log line and no way back into the
// flow.
//
// That asymmetry decides the order of the checks below. It used to read
// `if (config.env === 'production') return PRODUCTION_ORIGIN;` with
// localhost as the fallback, which made the DEFAULT a value that cannot
// work anywhere but a laptop. `config.env` is
// `process.env.NODE_ENV || 'development'` (src/config.js) and the platform
// injects USERNODE_ENV, not NODE_ENV — so production took the fallback and
// sent every real signup to
// `http://localhost:3000/waitlist/connect/<provider>/callback`. GitHub
// answered "The redirect_uri is not associated with this application", X
// "You weren't able to give access to the App", for as long as it took
// somebody to report it.
//
// So the canonical origin is the default and localhost is opt-in, keyed on
// the one flag that positively means "a developer is running this on their
// laptop" rather than "an environment variable happens to be missing" —
// which a container can say by accident, and this one did.
function connectOrigin(config) {
  if (config.waitlistOauthOrigin) return config.waitlistOauthOrigin;
  if (config.cliAuthLocalMode) return `http://localhost:${config.port || 3000}`;
  return PRODUCTION_ORIGIN;
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

  if (provider === 'linkedin') {
    // OpenID Connect. The secret goes in the form body (LinkedIn does not
    // accept Basic here), and /v2/userinfo returns the member's name —
    // there is no public handle to read, so the display name IS the
    // identifier we can store.
    const tokenResp = await fetchJson('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: creds.id,
        client_secret: creds.secret,
      }).toString(),
    });
    if (!tokenResp || !tokenResp.access_token) throw new Error('no access token');
    const me = await fetchJson('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${tokenResp.access_token}` },
    });
    const name = me && (me.name || [me.given_name, me.family_name].filter(Boolean).join(' '));
    if (!name) throw new Error('no name in profile');
    return String(name);
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
    if (!PROVIDERS.has(provider)) return res.status(404).end();

    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const row = await waitlist.getSignupByMoreToken(pool, token).catch(() => null);
    if (!row) return res.redirect('/#landing');

    const creds = providerConfig(config, provider);
    if (!creds) return res.redirect(formUrl(token, 'unavailable'));

    const redirectUri = callbackUrl(config, provider);

    if (provider === 'linkedin') {
      // OpenID Connect, no PKCE. `openid profile` is the smallest scope
      // that returns a name; we deliberately do NOT ask for email (the
      // waitlist row already has one), and there is no follow scope to
      // ask for — LinkedIn exposes no API reporting whether a member
      // follows a page, which is why the form says "connect" and never
      // claims a verified follow.
      const state = putState({ token, provider });
      const url = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
        response_type: 'code',
        client_id: creds.id,
        redirect_uri: redirectUri,
        state,
        scope: 'openid profile',
      });
      return res.redirect(url);
    }

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
    if (!PROVIDERS.has(provider)) return res.status(404).end();

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const entry = takeState(state);
    if (!entry || entry.provider !== provider) {
      // Already finished: a reload, the back button, or anything else that
      // re-requests this URL. The first pass knows where it sent them; send
      // them there again rather than to a landing page that answers a
      // question they did not ask.
      const done = peekOutcome(state, provider);
      if (done) return res.redirect(formUrl(done.token, done.status));
      // Genuinely unknown: no state record means no token, so there is no
      // form to return to and the landing page is all that is left. Logged,
      // because this used to be the one path through here that produced
      // neither a redirect anybody could explain nor a line to grep for.
      log.info('waitlist-connect', 'Callback with unknown or expired state', { provider });
      return res.redirect('/#landing');
    }

    // Every exit below is terminal, so each one records where it sent the
    // person before sending them.
    const land = (status) => {
      rememberOutcome(state, provider, entry.token, status);
      return res.redirect(formUrl(entry.token, status));
    };

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      // User denied on the provider page.
      return land('denied');
    }

    const creds = providerConfig(config, provider);
    if (!creds) return land('unavailable');

    try {
      const handle = await resolveHandle(
        provider, creds, code, callbackUrl(config, provider), entry.verifier
      );
      const updated = await waitlist.setVerifiedHandle(pool, entry.token, provider, handle);
      if (!updated) {
        // The exchange worked but the token no longer resolves to a signup.
        // Nothing to write and nothing to show, so the landing page stands —
        // but say so, rather than leaving a silent bounce.
        log.warn('waitlist-connect', 'Verified handle had no signup to write to', { provider });
        return res.redirect('/#landing');
      }
      log.info('waitlist-connect', 'Social handle verified', { provider });
      return land('ok');
    } catch (err) {
      log.error('waitlist-connect', 'OAuth exchange failed', {
        provider, message: err.message,
      });
      return land('failed');
    }
  });

  return router;
}

module.exports = { waitlistConnectRoutes };
