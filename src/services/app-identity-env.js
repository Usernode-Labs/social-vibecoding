'use strict';

// The container-env half of the RSA iframe cutover.
//
// Every app container needs exactly three things to verify a platform
// user identity, and there are FIVE places that build a container env
// (app-creator, staging ×2, app-respawn, sessions). They drifted before:
// the LLM-proxy pair had to be retrofitted into app-respawn after a
// respawn silently dropped it. So the mapping lives here once and every
// builder spreads the result.
//
//   USERNODE_JWT_PUBLIC_KEY  the RSA PUBLIC half. A container can verify
//                            a user token with it and cannot mint one —
//                            that asymmetry is the whole point of the
//                            cutover. The private half never leaves the
//                            platform process.
//   JWT_SECRET               the SAME public PEM, under the legacy name.
//                            A deprecated source-compat shim, nothing
//                            more: apps generated before this cutover
//                            read `process.env.JWT_SECRET` and pass it
//                            to `jwt.verify`, which accepts a PEM as the
//                            key argument and — because the token's own
//                            header says RS256 — verifies asymmetrically.
//                            So the legacy scaffold keeps working
//                            verbatim, while a container that tries to
//                            SIGN with it produces an RS256 token it has
//                            no private key for (throws) or an HS256
//                            token the platform rejects on algorithm.
//                            See tests/scaffold-token-compat.test.js.
//   USERNODE_APP_ID          `apps.id`, the immutable integer PK. The
//                            scaffold builds its expected audience from
//                            it (`usernode:app:<id>`), which is what
//                            scopes a token to ONE app: app A's token
//                            presented to app B fails the audience
//                            check. Never the slug — slugs are mutable
//                            through the rename-PR flow.
//   IFRAME_JWT_PUBLIC_KEY    the SAME public PEM again, under the
//                            platform's own env-var name. Ordinary child
//                            containers never read this name and USERNODE_
//                            JWT_PUBLIC_KEY already covers them — this
//                            copy exists for the platform's self-staging
//                            clone, which runs platform code
//                            (middleware/auth.js, app-llm-auth.js,
//                            app-storage-auth.js) that calls
//                            platform-jwt.js's iframePublicKey(), and that
//                            reads process.env.IFRAME_JWT_PUBLIC_KEY
//                            specifically. Harmless for every other
//                            container: it's a public key, it only lets a
//                            holder verify a signature, never produce one.
//
// What is deliberately NOT here: DATA_ENCRYPTION_KEY,
// IFRAME_JWT_PRIVATE_KEY, WORKER_JWT_SECRET, EDGE_JWT_SECRET. No child
// container gets any of them, by name or by value —
// tests/key-separation-env.test.js asserts that across every builder.

const log = require('./logger');

// Same normalization platform-jwt.js uses: PEMs ride .env as a single
// line with literal \n escapes so the deploy workflow's heredoc stays
// line-oriented.
function normalizePem(raw) {
  return String(raw || '').replace(/\\n/g, '\n').trim();
}

// `config` is optional: all five call sites have one, but falling back to
// process.env keeps this usable from a boot path that runs before
// config.load() and keeps the two sources provably identical (config's
// own `iframeJwtPublicKey` is this exact expression).
function appIdentityEnv(app, config = null) {
  const appId = Number(app && app.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    // A wrong audience is a silent total auth failure inside the
    // container, so refuse to build an env we know is broken. Every
    // caller passes a real `apps` row.
    throw new Error('app-identity-env: app.id must be a positive integer');
  }

  const publicPem = normalizePem(
    (config && config.iframeJwtPublicKey) || process.env.IFRAME_JWT_PUBLIC_KEY
  );
  if (!publicPem) {
    // NOT a throw: IFRAME_JWT_PUBLIC_KEY is in config.js's REQUIRED_PROD,
    // so production already hard-exits at boot without it. The one place
    // this is legitimately absent is the platform's OWN staging clone,
    // which is injected no platform keys — and there, failing the deploy
    // is worse than shipping a container whose auth is visibly closed.
    log.warn('app-identity-env', 'IFRAME_JWT_PUBLIC_KEY unset — container will reject every user token', { appId });
  }

  return {
    USERNODE_JWT_PUBLIC_KEY: publicPem,
    JWT_SECRET: publicPem,
    USERNODE_APP_ID: String(appId),
    IFRAME_JWT_PUBLIC_KEY: publicPem,
  };
}

module.exports = { appIdentityEnv, normalizePem };
