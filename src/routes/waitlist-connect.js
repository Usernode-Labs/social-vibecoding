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
const { Router, json } = require('express');
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

// state nonce → { token, status, provider, handle, expiresAt }, for a round trip
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
// It records the outcome, never the authorization code, and the replay
// reports that outcome and nothing else — the code is single-use at the
// provider, so re-exchanging it could only turn a success into an error. Reading is
// deliberately non-destructive: people reload more than once. The record
// holds no more than the caller already has (they must present the state
// nonce, which was minted for that token and rides in their own URL), and it
// expires on the same clock as the pending state.
const completed = new Map();

function rememberOutcome(nonce, provider, token, status, handle) {
  const now = Date.now();
  for (const [k, v] of completed) {
    if (v.expiresAt < now) completed.delete(k);
  }
  completed.set(nonce, {
    token, status, provider, handle: handle || null, expiresAt: now + STATE_TTL_MS,
  });
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

// ── The callback's status page ─────────────────────────────────────────
//
// A standalone document, not the SPA: it has to paint before the exchange
// finishes, for somebody who has no platform session, and it must not load
// anything that could pass the code in its URL to another origin. So it is
// inline and locked to a per-response nonce — nothing else can run or
// style it — and the only request it can make is to this origin.
//
// It renders as "working" and its script fills in the outcome from
// POST …/complete. The copy for every outcome lives in the script, because
// the server only learns the outcome after the page is already on screen.

const PROVIDER_LABELS = { github: 'GitHub', x: 'X', linkedin: 'LinkedIn' };

function statusPageCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// `provider` is one of PROVIDERS (the route 404s anything else) and the
// label comes from the fixed map above, so nothing request-supplied is
// interpolated into this document.
function statusPageHtml(provider, nonce) {
  const label = PROVIDER_LABELS[provider];
  const page = JSON.stringify({ provider, label });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connecting ${label} · Homeroom</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --ground: #eaeaea; --card: #ffffff; --ink: #1c1c1e;
    --muted: #68686c; --line: #e3e3e6; --accent: #0a6ee0; --ok: #15803d; --warn: #b45309;
    /* Filled button: the darker accent in both schemes, so white text keeps its contrast. */
    --button: #0a6ee0; }
  @media (prefers-color-scheme: dark) {
    :root { --ground: #0b0b0c; --card: #1c1c1e; --ink: #f5f5f7; --muted: #8e8e93;
      --line: #3a3a3c; --accent: #5aa9ff; --ok: #4ade80; --warn: #fbbf24; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: var(--ground); color: var(--ink);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(26rem, 100%); padding: 2rem 1.5rem; border: 1px solid var(--line);
    border-radius: 1.25rem; background: var(--card); text-align: center; }
  .mark { width: 3rem; height: 3rem; margin: 0 auto 1rem; border-radius: 999px;
    display: grid; place-items: center; font-size: 1.5rem; font-weight: 700; }
  .mark.working { border: 3px solid var(--line); border-top-color: var(--accent);
    animation: spin .9s linear infinite; }
  .mark.ok { color: var(--ok); border: 2px solid currentColor; }
  .mark.warn { color: var(--warn); border: 2px solid currentColor; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mark.working { animation-duration: 3s; } }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; line-height: 1.3; }
  p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .actions { margin-top: 1.5rem; }
  .actions:empty { display: none; }
  .button { display: inline-block; min-height: 44px; padding: .65rem 1.25rem; border: 0;
    border-radius: 999px; background: var(--button); color: #fff; font: inherit;
    font-weight: 600; text-decoration: none; cursor: pointer; }
</style>
</head>
<body>
<main id="waitlist-connect-status" data-state="working">
  <div id="waitlist-connect-mark" class="mark working" aria-hidden="true"></div>
  <div role="status" aria-live="polite">
    <h1 id="waitlist-connect-title">Connecting your ${label} account…</h1>
    <p id="waitlist-connect-detail">This takes a few seconds. Keep this tab open.</p>
  </div>
  <div id="waitlist-connect-actions" class="actions"></div>
  <noscript><p>This page needs JavaScript to finish connecting. Turn it on and reload.</p></noscript>
</main>
<script nonce="${nonce}">
(function () {
  var page = ${page};
  var label = page.label;
  var root = document.getElementById('waitlist-connect-status');
  var mark = document.getElementById('waitlist-connect-mark');
  var title = document.getElementById('waitlist-connect-title');
  var detail = document.getElementById('waitlist-connect-detail');
  var actions = document.getElementById('waitlist-connect-actions');

  function action(text, href) {
    var a = document.createElement(href ? 'a' : 'button');
    a.className = 'button';
    a.textContent = text;
    if (href) a.href = href;
    else a.addEventListener('click', function () { location.reload(); });
    actions.appendChild(a);
  }

  // Only ever a same-origin form route the server built; anything else is
  // dropped rather than followed.
  function formHref(r) {
    return r && typeof r.redirect === 'string' && r.redirect.indexOf('/#more/') === 0
      ? r.redirect : null;
  }

  function show(r) {
    var status = r && r.status;
    var form = formHref(r);
    root.setAttribute('data-state', status || 'error');
    actions.textContent = '';
    if (status === 'ok') {
      var who = r.handle ? (page.provider === 'linkedin' ? r.handle : '@' + r.handle) : '';
      mark.className = 'mark ok';
      mark.textContent = '\\u2713';
      title.textContent = label + ' account connected';
      detail.textContent = (who ? 'Verified as ' + who + '. ' : '')
        + (form ? 'Taking you back to your waitlist form\\u2026' : '');
      if (form) {
        action('Back to your form', form);
        setTimeout(function () { location.replace(form); }, 1500);
      }
      return;
    }
    mark.className = 'mark warn';
    mark.textContent = '!';
    if (status === 'denied') {
      title.textContent = 'Connection cancelled';
      detail.textContent = 'Access wasn\\u2019t approved on ' + label + ', so nothing was connected.';
    } else if (status === 'failed') {
      title.textContent = 'Couldn\\u2019t verify your account';
      detail.textContent = label + ' didn\\u2019t confirm the account. Go back to your form and try again.';
    } else if (status === 'unavailable') {
      title.textContent = label + ' sign-in isn\\u2019t available yet';
      detail.textContent = 'You can still add your handle on the waitlist form.';
    } else if (status === 'expired') {
      title.textContent = 'This link has expired';
      detail.textContent = 'It was already used or is too old. Go back to the tab with your waitlist form and press Connect again.';
      return;
    } else {
      title.textContent = 'Something went wrong';
      detail.textContent = 'We couldn\\u2019t finish connecting your ' + label + ' account. Check your connection and try again.';
      action('Try again');
      return;
    }
    if (form) action('Back to your form', form);
  }

  var query = new URLSearchParams(location.search);
  fetch('/waitlist/connect/' + page.provider + '/complete', {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: query.get('state') || '', code: query.get('code') || '' }),
  })
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(show, function () { show(null); });
})();
</script>
</body>
</html>
`;
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
  // Provider redirect target. It answers at once with a small standalone
  // status page and does nothing else: no state is consumed and no code is
  // exchanged here.
  //
  // It used to do the whole exchange and then 302 to the form. That took
  // two provider calls, well past the service worker's 200ms navigation
  // deadline, so a returning visitor saw the cached SPA — the platform home
  // page — until the redirect finally won. A person who had just approved
  // an OAuth prompt was shown an unrelated screen with no word about what
  // was happening. The page below says what is happening, and the one that
  // follows says how it went.
  //
  // Doing no work on GET has a second benefit: a link scanner or a prefetch
  // that fetches this URL no longer spends the single-use code.
  router.get('/waitlist/connect/:provider/callback', (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.has(provider)) return res.status(404).end();
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The URL carries the code and the state nonce; nothing on this page
      // may hand them to another origin.
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': statusPageCsp(nonce),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    return res.send(statusPageHtml(provider, nonce));
  });

  // ── POST /waitlist/connect/:provider/complete ────────────────────────
  // Called by the status page with the `state` and `code` from its own
  // URL: exchange the code, store the verified handle on the signup, and
  // report the outcome plus where the form is. Always 200 with a JSON
  // outcome — the page renders every one of them, and none is an HTTP error
  // from the visitor's point of view.
  // Its own small parser: the body is two short strings, and the route should
  // not depend on a global parser having run first (a no-op when one has).
  router.post('/waitlist/connect/:provider/complete', json({ limit: '4kb' }), async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.has(provider)) return res.status(404).end();
    res.set('Cache-Control', 'no-store');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const state = typeof body.state === 'string' ? body.state : '';
    const reply = (status, token, handle) => res.json({
      status,
      provider,
      handle: handle || null,
      redirect: token ? formUrl(token, status) : null,
    });

    const entry = takeState(state);
    if (!entry || entry.provider !== provider) {
      // Already finished: a reload, the back button, or anything else that
      // re-requests this URL. The first pass knows how it ended; report that
      // again rather than an error for a round trip that worked.
      const done = peekOutcome(state, provider);
      if (done) return reply(done.status, done.token, done.handle);
      // Genuinely unknown: no state record means no token, so there is no
      // form to return to. The page says the link has expired — which also
      // covers a server restart while the person was at the provider, since
      // the state lives in memory. Logged, because this used to be the one
      // path through here that produced neither an explanation nor a line to
      // grep for.
      log.info('waitlist-connect', 'Callback with unknown or expired state', { provider });
      return reply('expired', null, null);
    }

    // Every exit below is terminal, so each one records how it ended before
    // answering.
    const land = (status, handle) => {
      rememberOutcome(state, provider, entry.token, status, handle);
      return reply(status, entry.token, handle);
    };

    const code = typeof body.code === 'string' ? body.code : '';
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
        // Nothing to write and no form to go back to — but say so, rather
        // than leaving a silent bounce.
        log.warn('waitlist-connect', 'Verified handle had no signup to write to', { provider });
        return reply('expired', null, null);
      }
      log.info('waitlist-connect', 'Social handle verified', { provider });
      return land('ok', handle);
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
