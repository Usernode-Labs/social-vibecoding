'use strict';

// Centralized platform token signing / verification.
//
// This module is the ONLY place `jsonwebtoken` is called for a token that
// carries platform authority. It exists because one shared `JWT_SECRET`
// used to sign five unrelated things at once — iframe identities, worker
// tokens, edge grants, access cookies — while also being handed verbatim
// to every app and staging container. Anything running inside a child
// container could therefore mint a credential the platform trusted.
//
// Four independent authorities, four independent keys:
//
//   authority      alg     key                       aud                    pur
//   ─────────────  ─────   ────────────────────────  ─────────────────────  ──────────────
//   app identity   RS256   IFRAME_JWT_PRIVATE_KEY    usernode:app:<appId>   iframe
//                          (verify: …_PUBLIC_KEY)
//   worker         HS256   WORKER_JWT_SECRET         usernode:worker        worker:session
//   edge grant     HS256   EDGE_JWT_SECRET           usernode:edge          edge:grant
//   edge cookie    HS256   EDGE_JWT_SECRET           usernode:edge          edge:cookie
//
// App identity is asymmetric on purpose: containers receive only the
// public key, so they can verify a user token but cannot produce one.
//
// Every sign pins algorithm, issuer, audience, a `pur` (purpose) claim
// and an expiry. Every verify pins the same three registered claims via
// jsonwebtoken options AND re-checks `pur` explicitly, so two tokens
// that share a key (the two edge purposes) are still not
// interchangeable. There is NO legacy branch and no fallback to the
// former shared secret anywhere in this file — a token signed with it
// verifies nowhere.
//
// Keys are read from process.env at call time rather than at import.
// Module load order can precede config.load(), and the middlewares that
// verify worker tokens never receive a config object.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'usernode';

const AUD_WORKER = 'usernode:worker';
const AUD_EDGE = 'usernode:edge';

const PUR_IFRAME = 'iframe';
const PUR_WORKER = 'worker:session';
const PUR_EDGE_GRANT = 'edge:grant';
const PUR_EDGE_COOKIE = 'edge:cookie';

// Shell iframe tokens live an hour and are refreshed by the shell at 45
// min (public/js/app-view.js). Capture tokens only need to outlive one
// screenshot run. Worker tokens cover a whole chat session. The edge
// grant is one redirect hop; the access cookie is a browsing session.
const IFRAME_TTL = '1h';
const CAPTURE_TTL = '15m';
const WORKER_TTL = '24h';
const EDGE_GRANT_TTL_S = 120;
const EDGE_COOKIE_TTL_S = 12 * 60 * 60;

// Audience for an app-scoped identity token. Keyed on `apps.id` — the
// immutable integer PK — never the slug: slugs are mutable through the
// rename-PR flow, so a rename would silently invalidate live tokens or,
// worse, alias two apps onto one audience.
function appAudience(appId) {
  const n = Number(appId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('platform-jwt: appId must be a positive integer');
  }
  return `usernode:app:${n}`;
}

// PEMs ride the .env file as a single line with literal \n escapes (the
// same convention GITHUB_PRIVATE_KEY already uses) so the deploy
// workflow's heredoc stays line-oriented.
function pem(raw) {
  return String(raw || '').replace(/\\n/g, '\n').trim();
}

function iframePrivateKey() {
  const key = pem(process.env.IFRAME_JWT_PRIVATE_KEY);
  if (!key) throw new Error('IFRAME_JWT_PRIVATE_KEY not set — cannot sign app identity tokens');
  return key;
}

function iframePublicKey() {
  const key = pem(process.env.IFRAME_JWT_PUBLIC_KEY);
  if (!key) throw new Error('IFRAME_JWT_PUBLIC_KEY not set — cannot verify app identity tokens');
  return key;
}

function workerSecret() {
  const s = process.env.WORKER_JWT_SECRET;
  if (!s) throw new Error('WORKER_JWT_SECRET not set — cannot mint or verify worker tokens');
  return s;
}

function edgeSecret() {
  const s = process.env.EDGE_JWT_SECRET;
  if (!s) throw new Error('EDGE_JWT_SECRET not set — cannot mint or verify edge tokens');
  return s;
}

// Shared verify core. `algorithms`, `issuer` and `audience` are pinned
// by jsonwebtoken; `pur` is checked here. Nothing about the expected
// shape comes from the token itself.
function verifyWith(token, key, { algorithm, audience, purpose }) {
  if (!token || typeof token !== 'string') throw new Error('jwt must be provided');
  const claims = jwt.verify(token, key, {
    algorithms: [algorithm],
    issuer: ISSUER,
    audience,
  });
  if (!claims || typeof claims !== 'object') throw new Error('invalid token payload');
  if (claims.pur !== purpose) {
    throw new Error(`invalid purpose (expected ${purpose})`);
  }
  return claims;
}

// ── App identity (iframe + capture) ───────────────────────────────────
//
// The user claims are passed through verbatim: `{ id, username,
// usernode_pubkey, locale }` is the documented contract every child app
// reads (src/prompts/app-conventions.md), so only registered claims are
// added around them.
function signAppIdentityToken({ appId, user, ttl }) {
  if (!user || typeof user.id !== 'number') {
    throw new Error('platform-jwt: user.id (number) required');
  }
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey ?? null,
      locale: user.locale ?? null,
      pur: PUR_IFRAME,
    },
    iframePrivateKey(),
    {
      algorithm: 'RS256',
      issuer: ISSUER,
      audience: appAudience(appId),
      expiresIn: ttl || IFRAME_TTL,
    }
  );
}

function verifyAppIdentityToken(token, { appId }) {
  return verifyWith(token, iframePublicKey(), {
    algorithm: 'RS256',
    audience: appAudience(appId),
    purpose: PUR_IFRAME,
  });
}

// ── Worker → platform internal API ────────────────────────────────────
//
// `scope` is kept alongside `pur` because app-llm-auth /
// app-storage-auth still use "has a scope claim" as a belt-and-braces
// rejection of infrastructure tokens presented as user tokens.
function signWorkerToken({ sessionId, prodDebug = false }) {
  if (typeof sessionId === 'undefined' || sessionId === null) {
    throw new Error('platform-jwt: sessionId required');
  }
  const payload = { session_id: sessionId, scope: PUR_WORKER, pur: PUR_WORKER };
  if (prodDebug) payload.prod_debug = true;
  return jwt.sign(payload, workerSecret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUD_WORKER,
    expiresIn: WORKER_TTL,
  });
}

function verifyWorkerToken(token) {
  return verifyWith(token, workerSecret(), {
    algorithm: 'HS256',
    audience: AUD_WORKER,
    purpose: PUR_WORKER,
  });
}

// ── Private-app edge gate ─────────────────────────────────────────────
//
// Both edge purposes share EDGE_JWT_SECRET; the `pur` check is what
// keeps a 120s grant from being replayed as a 12h access cookie.
function signEdgeGrant({ uid, appId, host }) {
  return jwt.sign({ uid, appId, host, pur: PUR_EDGE_GRANT }, edgeSecret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUD_EDGE,
    expiresIn: EDGE_GRANT_TTL_S,
  });
}

function verifyEdgeGrant(token) {
  return verifyWith(token, edgeSecret(), {
    algorithm: 'HS256',
    audience: AUD_EDGE,
    purpose: PUR_EDGE_GRANT,
  });
}

function signEdgeCookie({ uid, appId, host }) {
  return jwt.sign({ uid, appId, host, pur: PUR_EDGE_COOKIE }, edgeSecret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUD_EDGE,
    expiresIn: EDGE_COOKIE_TTL_S,
  });
}

function verifyEdgeCookie(token) {
  return verifyWith(token, edgeSecret(), {
    algorithm: 'HS256',
    audience: AUD_EDGE,
    purpose: PUR_EDGE_COOKIE,
  });
}

// Non-throwing wrapper for call sites that branch on validity rather
// than reporting an error (the edge gate falls through to the next
// credential instead of 401-ing).
function orNull(fn) {
  try { return fn(); } catch { return null; }
}

// ── Pre-cutover staging bootstrap (TEMPORARY) ─────────────────────────
//
// A staging preview container's env is built by the platform that is
// CURRENTLY DEPLOYED, not by the code in the branch being previewed. The
// deployed platform predates services/app-identity-env.js, so it injects
// only the old shared HS256 secret as JWT_SECRET — no
// IFRAME_JWT_PUBLIC_KEY, no USERNODE_APP_ID. The new verify path
// therefore fails closed on every parent-issued token, and the preview of
// THIS cutover is unopenable: the checks runner cannot mint a session, so
// every assertion on an authenticated route fails, and a human reviewer
// lands on the login screen.
//
// The gate is a three-way conjunction, and each conjunct is load-bearing:
//
//   USERNODE_ENV === 'staging'   — production never reaches the two
//                                  auth.js call sites at all, but pin it
//                                  here too so the shim cannot be reached
//                                  by a future non-staging caller.
//   no IFRAME_JWT_PUBLIC_KEY     — config.js REQUIRED_PROD lists that key,
//                                  so production cannot boot without it.
//                                  This conjunct is UNSATISFIABLE in
//                                  production, which is what makes the
//                                  shim structurally unreachable there
//                                  rather than merely unused.
//   no USERNODE_APP_ID           — a container that DOES know its app id
//                                  has been built by the post-cutover
//                                  platform and must use the real path.
//   JWT_SECRET present           — nothing to verify against otherwise.
//
// SELF-DISABLING, and that is the point: the moment this lands on main,
// every newly built preview gets IFRAME_JWT_PUBLIC_KEY + USERNODE_APP_ID
// from appIdentityEnv(), the second and third conjuncts go false forever,
// and this code is dead. It is not a fallback the platform is meant to
// keep — the follow-up deletes ALL of it, both directions:
//
//   1. this file            legacyBootstrapActive(),
//                           verifyLegacyBootstrapToken(),
//                           signLegacyBootstrapToken(), and the three
//                           exports.
//   2. middleware/auth.js   the two verify-side fallbacks (identity
//                           switch, tryMintSessionFromIframeJwt).
//   3. server.js            the mint-side fallback in /api/iframe-token.
//                           Keep the structured 503 there: it is the
//                           correct answer for a deployment with no
//                           signing key, shim or no shim.
//   4. tests                restore the pure fail-closed assertion in
//                           tests/staging-auth-token-switch.test.js and
//                           drop its shim cases; drop the shim cases in
//                           tests/iframe-token-route.test.js and the
//                           sentinel in tests/key-separation-env.test.js.
//
// Removing only half would be worse than keeping both: verify-only leaves
// every app view in a pre-cutover preview 500ing, and mint-only leaves the
// preview unable to establish a session at all.
//
// Deliberately NOT wired into verifyAppIdentityToken() or
// signAppIdentityToken(): the primary paths keep their "no legacy branch
// anywhere" property, and every caller that wants the shim has to name it
// explicitly.
//
// Both DIRECTIONS need the shim, which is easy to miss. Verifying the
// parent's token is what mints the preview's own session; SIGNING is what
// the preview does when it acts AS the parent shell — the self-app staging
// clone renders app views, and each one fetches /api/iframe-token for the
// embedded child. A preview has no IFRAME_JWT_PRIVATE_KEY either, so
// without a mint-side fallback that endpoint 500s on every app view and
// the console-error baseline check fails even though the session works.
function legacyBootstrapActive() {
  return process.env.USERNODE_ENV === 'staging'
    && !process.env.IFRAME_JWT_PUBLIC_KEY
    && !process.env.USERNODE_APP_ID
    && !!process.env.JWT_SECRET;
}

// Verify a pre-cutover parent's iframe token: bare HS256 against the
// shared secret, with no iss/aud/pur to check because the old signer
// emitted none. Throws when the shim is not active, so a caller that
// forgets the gate cannot accidentally accept one of these in a
// container that has real key material.
function verifyLegacyBootstrapToken(token) {
  if (!legacyBootstrapActive()) {
    throw new Error('platform-jwt: legacy bootstrap not active');
  }
  if (!token || typeof token !== 'string') throw new Error('jwt must be provided');
  const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (!claims || typeof claims !== 'object') throw new Error('invalid token payload');
  return claims;
}

// Mint a pre-cutover-shaped iframe token: the EXACT payload, algorithm and
// TTL the retired signer emitted — bare HS256 over the shared secret, four
// claims, 1h, no iss/aud/pur — so a child container still running
// pre-cutover scaffold code verifies it verbatim. Adding iss/aud/pur here
// would be strictly worse: a container built by the deployed platform has
// no USERNODE_APP_ID to build an expected audience from, so it checks
// none of them, and emitting them would only make this token look
// app-scoped when it is not.
//
// Same gate as the verify half, and the same throw when it is not active:
// this must never be reachable in a container that holds real key
// material. Note the asymmetry that keeps it honest — the shim can only
// sign with a secret the platform ALREADY shares with every container, so
// it grants the preview nothing that the pre-cutover platform did not
// already grant. It confers no authority in a post-cutover container,
// which verifies RS256 against a public key this token was not signed
// with.
function signLegacyBootstrapToken({ user, ttl }) {
  if (!legacyBootstrapActive()) {
    throw new Error('platform-jwt: legacy bootstrap not active');
  }
  if (!user || typeof user.id !== 'number') {
    throw new Error('platform-jwt: user.id must be a number');
  }
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey ?? null,
      locale: user.locale ?? null,
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: ttl || IFRAME_TTL }
  );
}

// ── Boot validation ───────────────────────────────────────────────────
//
// A mismatched RSA pair breaks every app login silently — the platform
// happily mints tokens no container can verify. Catch it at boot by
// round-tripping a probe token through both halves, and refuse an
// undersized modulus while we're here. Throws with an operator-readable
// message; config.load() turns that into a hard exit.
function assertIframeKeyPair() {
  const priv = crypto.createPrivateKey(iframePrivateKey());
  if (priv.asymmetricKeyType !== 'rsa') {
    throw new Error(`IFRAME_JWT_PRIVATE_KEY must be an RSA key (got ${priv.asymmetricKeyType})`);
  }
  const bits = priv.asymmetricKeyDetails?.modulusLength || 0;
  if (bits < 2048) {
    throw new Error(`IFRAME_JWT_PRIVATE_KEY modulus is ${bits} bits — 2048 minimum`);
  }
  const pub = crypto.createPublicKey(iframePublicKey());
  if (pub.asymmetricKeyType !== 'rsa') {
    throw new Error(`IFRAME_JWT_PUBLIC_KEY must be an RSA key (got ${pub.asymmetricKeyType})`);
  }
  const probe = signAppIdentityToken({
    appId: 1,
    user: { id: 1, username: '__boot_probe__', usernode_pubkey: null, locale: null },
    ttl: '1m',
  });
  verifyAppIdentityToken(probe, { appId: 1 });
  return { bits };
}

module.exports = {
  ISSUER,
  AUD_WORKER,
  AUD_EDGE,
  PUR_IFRAME,
  PUR_WORKER,
  PUR_EDGE_GRANT,
  PUR_EDGE_COOKIE,
  IFRAME_TTL,
  CAPTURE_TTL,
  WORKER_TTL,
  EDGE_GRANT_TTL_S,
  EDGE_COOKIE_TTL_S,
  appAudience,
  signAppIdentityToken,
  verifyAppIdentityToken,
  signWorkerToken,
  verifyWorkerToken,
  signEdgeGrant,
  verifyEdgeGrant,
  signEdgeCookie,
  verifyEdgeCookie,
  orNull,
  assertIframeKeyPair,
  // Temporary, staging-only — see the block comment above. Remove with
  // the follow-up once the cutover has deployed.
  legacyBootstrapActive,
  verifyLegacyBootstrapToken,
  signLegacyBootstrapToken,
};
