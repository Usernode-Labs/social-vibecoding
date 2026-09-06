'use strict';

// The env-staleness half of the staging-preview lifecycle (#851).
//
// WHY THIS EXISTS
//
// A staging preview's environment is assembled by the platform build that is
// CURRENTLY DEPLOYED, and docker has no "set env on a live container"
// primitive. So a platform-side env change reaches a preview only when its
// container is stop+rm+run — and previews are long-lived (production carried
// 108 of them, up to four weeks old, when this landed). The RSA iframe
// cutover (#848) is the case that forced the issue: every preview built
// before it holds the old shared HS256 secret with no IFRAME_JWT_PUBLIC_KEY
// and no USERNODE_APP_ID, so a reviewer clicking Preview lands on the app's
// login screen.
//
// staging-recovery.stagingNeedsRebuild() could not see that — it only asked
// whether the container was still RUNNING. This module gives it something to
// compare against: a digest of the platform-owned env, stamped into a
// container label at build time (`usernode.env.fp`). A container whose label
// does not match the digest the platform would build TODAY was built by an
// older platform, so it needs rebuilding. That turns #850's one-off admin
// sweep into an automatic sweeper pass (services/staging-reap.js).
//
// WHAT GOES INTO THE DIGEST — and what deliberately does not.
//
//   IN: the platform-owned half of the staging container env, i.e. exactly
//       what platformStagingEnv() below returns. That is the identity trio
//       from services/app-identity-env.js (which is the thing that actually
//       broke), PORT, USERNODE_ENV, and the display-only locators forwarded
//       to a self-hosted fork. Names AND value digests, so both a changed
//       value and a changed SHAPE (a new var, a dropped var) move the
//       fingerprint with no code change here.
//
//   OUT: DATABASE_URL. It carries a per-clone random password, so it differs
//       for every single build — including two builds of the same commit.
//       Including it would make every preview permanently "stale".
//
//   OUT: the app's own secrets (appSecrets.mergeForDeploy). Their values
//       resolve from the BRANCH's cloned dapp.json, so a sweeper would have
//       to clone a repo per preview to recompute the expected digest. Secret
//       drift therefore still reaches a preview on its next build only,
//       exactly as before this module existed.
//
//   VALUE-EXEMPT: USERNODE_APP_ID contributes its NAME but not its value.
//       Every app has a different one, and a preview's app never changes, so
//       hashing the value would only make the digest per-app — which would
//       force the sweeper to load an app row per preview for nothing. Should
//       the key ever disappear from the env, its NAME leaving the input still
//       moves the fingerprint.
//
// SECURITY. A docker label is readable by anything that can run `docker
// inspect`, so the label carries a truncated SHA-256 of each value and never
// a value itself. The one non-public thing in scope would be a private PEM,
// and no builder injects one (tests/key-separation-env.test.js pins that);
// the public PEM's digest leaks nothing either way.

const crypto = require('crypto');
const { appIdentityEnv } = require('./app-identity-env');
const { platformApiBaseUrl } = require('./app-llm-env');

// Bump to force every preview to be treated as stale on the next sweep —
// the deliberate "rebuild the fleet" lever for a change that the injected
// values themselves do not express (e.g. a new *meaning* for an existing
// var, or a container flag that isn't env at all).
const FINGERPRINT_VERSION = 'v1';

// The label `docker run --label` writes and `docker ps --format
// '{{.Label "…"}}'` / `docker inspect` read back.
const LABEL_ENV_FP = 'usernode.env.fp';

// The COMMIT half of the same idea. `usernode.env.fp` answers "which platform
// assembled this preview"; this answers "which commit of the app is inside
// it" — the full SHA `git rev-parse HEAD` returned in the clone that was
// built, stamped by staging.buildAndDeployStagingInner.
//
// It exists because a preview's commit moves UNDER a live proposal. A clean
// platform sync (services/sync-main.js) merges main into the branch, pushes,
// advances the reviewed revision and carries the green verdict forward
// WITHOUT rebuilding — "a clean merge is pure git", so nothing the author
// wrote changed. But the tree did: it now holds everything main added,
// including whatever `dapp.json` checks main added. visuals.captureForSession
// reads the declared suite from the BRANCH TIP (services/visuals.js
// sessionGitRef) and runs it against whatever container is up, so the next
// re-run — a sweeper pass, a manual "Re-run checks", a promote kick — judged
// a fresh manifest against pre-sync code and failed every check main had
// introduced since. Every open proposal on this platform's own board went red
// that way, and re-running could not clear it: the re-check reused the same
// stale container.
//
// A commit label makes that visible to stagingNeedsRebuild() exactly as the
// env digest made stale env visible, so the preview is rebuilt at the head
// the checks are about to stamp. It also fixes the reviewer-facing half of
// the same gap: Preview opened pre-sync code while claiming to show the
// revision under review.
//
// A public SHA, so nothing about the label's readability matters here.
const LABEL_BUILD_COMMIT = 'usernode.build.commit';

// Keys whose NAME is part of the fingerprint but whose VALUE is not. See the
// header: this is what keeps one digest valid for every app.
const VALUE_EXEMPT = new Set(['USERNODE_APP_ID']);

// Display-only locators forwarded into a preview so a self-hosted fork sees
// its own domain / GitHub org instead of the canonical Usernode-Labs
// defaults. Lives here (rather than inline in staging.js) so the fingerprint
// is computed from the same list that is injected.
const INHERITED_KEYS = ['USERNODE_DOMAIN', 'USERNODE_PLATFORM_REPO'];

/**
 * The platform-owned half of a staging container's environment: everything
 * the PLATFORM decides, with nothing per-build (DATABASE_URL) and nothing
 * app-declared (dapp.json secrets).
 *
 * staging.buildAndDeployStagingInner spreads this into the container env AND
 * fingerprints this exact object, so the label can never describe an env
 * different from the one that was injected.
 */
function platformStagingEnv(app, config = null) {
  const env = {
    ...appIdentityEnv(app, config),
    PORT: '3000',
    USERNODE_ENV: 'staging',
    // #1213: the app-facing platform API's base URL — the URL ONLY, never
    // a token. A preview's server can reach the user-directory endpoints
    // with just the caller's forwarded iframe token (the middleware's
    // allowUserTokenOnly path); everything token-gated (governance feed,
    // LLM proxy, storage) stays production-only because the credential
    // env vars are still absent here. Adding this key moves the env
    // fingerprint below, so pre-existing previews are swept as stale and
    // rebuilt with it — no FINGERPRINT_VERSION bump needed.
    USERNODE_PLATFORM_API_URL: platformApiBaseUrl(),
  };
  for (const key of INHERITED_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/**
 * Canonical digest of an env object. Sorted `KEY=<sha256 of value>` lines
 * (value-exempt keys contribute a bare `KEY`), prefixed by
 * FINGERPRINT_VERSION, hashed, truncated to 16 hex chars — short enough to
 * read in `docker ps` output, wide enough that a collision is not a concern
 * for a fleet of a few hundred containers.
 */
function envFingerprint(env) {
  const lines = Object.keys(env || {})
    .sort()
    .map((key) => (VALUE_EXEMPT.has(key) ? key : `${key}=${sha256(env[key])}`));
  return sha256([`fpv=${FINGERPRINT_VERSION}`, ...lines].join('\n')).slice(0, 16);
}

// Memoised: the digest is identical for every app (USERNODE_APP_ID is
// value-exempt) and the platform's own env cannot change without a restart,
// so the sweeper's per-preview comparison costs nothing after the first call.
// `app.id` of 1 is a placeholder — appIdentityEnv only requires a positive
// integer, and the value is not hashed.
let _expected = null;

function expectedStagingFingerprint(config = null) {
  if (_expected) return _expected;
  _expected = envFingerprint(platformStagingEnv({ id: 1 }, config));
  return _expected;
}

// Test seam only — drops the memo so a case can vary process.env / config.
function _resetExpected() {
  _expected = null;
}

module.exports = {
  platformStagingEnv,
  envFingerprint,
  expectedStagingFingerprint,
  FINGERPRINT_VERSION,
  LABEL_ENV_FP,
  LABEL_BUILD_COMMIT,
  VALUE_EXEMPT,
  INHERITED_KEYS,
  _resetExpected,
};
