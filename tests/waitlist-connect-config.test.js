// #880: the waitlist social-connect CONFIGURATION contract — what the
// five WAITLIST_* variables declare, and how a deployment behaves when a
// provider's credentials are not set.
//
// Modelled on tests/connector-config-unset.test.js, which pins the same
// contract for the chat connector's three variables. Three failure modes
// this guards, all of which would otherwise be discovered late:
//
//   1. A `required: true` platform_env declaration with no value set
//      BLOCKS THE MERGE — src/services/platform-env-check.js diffs the
//      block against the merge base and fails the proposal check. The X
//      credentials cannot be supplied by any pull request (they come out
//      of developer.x.com, from a human with the owning account), and the
//      code degrades cleanly without them, so they MUST be mergeable
//      while unset. The two GitHub entries shipped `required: true` by
//      mistake, which made the Platform variables panel print "missing —
//      deploys are blocked" for a state that blocks nothing.
//   2. A read with no declaration is invisible to an admin. Every
//      process.env.WAITLIST_* the platform reads has to appear in the
//      panel, or nobody can discover that a provider is unconfigured.
//   3. An UNSET provider must degrade, not half-work: no connect button
//      is rendered for it, and a stale link bounces back to the stage-2
//      form with ?connect=unavailable rather than erroring or sending the
//      user to a provider that would reject the request.
//
// Run with: node --test tests/waitlist-connect-config.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const appManifest = require('../src/services/app-manifest');
const { PRODUCTION_ORIGIN } = require('../src/services/cli-auth-constants');

const ROOT = path.join(__dirname, '..');
const MANIFEST_SRC = fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8');
const MANIFEST = JSON.parse(MANIFEST_SRC);
const ENTRIES = appManifest.readPlatformEnv(MANIFEST);
const BY_KEY = new Map(ENTRIES.map((e) => [e.key, e]));

// Every WAITLIST_* variable src/config.js reads.
const KEYS = [
  'WAITLIST_GITHUB_CLIENT_ID',
  'WAITLIST_GITHUB_CLIENT_SECRET',
  'WAITLIST_X_CLIENT_ID',
  'WAITLIST_X_CLIENT_SECRET',
  'WAITLIST_OAUTH_ORIGIN',
];
const SECRETS = ['WAITLIST_GITHUB_CLIENT_SECRET', 'WAITLIST_X_CLIENT_SECRET'];

// ── the declaration side ───────────────────────────────────────────────

test('every waitlist OAuth variable is declared in platform_env', () => {
  for (const key of KEYS) {
    assert.ok(BY_KEY.has(key), `${key} is read by the platform but not declared in dapp.json`);
    assert.ok(BY_KEY.get(key).description.length > 40,
      `${key}'s description has to tell an admin what setting it does`);
    assert.equal(BY_KEY.get(key).group, 'Waitlist',
      'all five belong to one panel heading so they are read together');
  }
});

test('none of them can block a proposal from merging', () => {
  // The whole point: platform-env-check fails a proposal that ADDS a
  // required variable with no value, and nobody can supply an X client id
  // from a pull request. Rather than assert `required` and hope that is
  // what the check reads, run the check's own predicate over the real
  // manifest — the same source-parse it performs on a branch, and the
  // same filter it applies to the result.
  const check = require('../src/services/platform-env-check');
  const parsed = check.platformEnvFromManifestSource(MANIFEST_SRC);
  assert.ok(Array.isArray(parsed), 'the check can parse this manifest at all');
  const overlay = check.unwritableOverlayFromSource(
    fs.readFileSync(path.join(ROOT, check.MANIFEST_MODULE_PATH), 'utf8')
  );
  const wouldBlock = new Set(
    parsed
      .filter((e) => e.required && !check.isUnwritableWithOverlay(e, overlay))
      .map((e) => e.key)
  );
  for (const key of KEYS) {
    assert.ok(parsed.some((e) => e.key === key), `${key} survives the check's own parse`);
    assert.equal(BY_KEY.get(key).required, false, `${key} must be required:false`);
    assert.ok(!wouldBlock.has(key),
      `${key} would be reported as a missing required value and block the merge`);
  }
});

test('exactly the two client secrets are declared private', () => {
  // private:true means encrypted at rest and never returned by any API —
  // right for a value that can complete OAuth authorizations for this
  // deployment. A client id travels in the authorize URL's query string in
  // plain sight, so marking it private would only stop an admin reading
  // back what they pasted, with no security gain.
  for (const key of KEYS) {
    assert.equal(BY_KEY.get(key).private, SECRETS.includes(key),
      `${key} has the wrong private flag`);
  }
  // No committed default for any credential: there is no sane real value
  // to commit, and unset is a supported state.
  for (const key of KEYS.filter((k) => k !== 'WAITLIST_OAUTH_ORIGIN')) {
    assert.equal(BY_KEY.get(key).default, null, `${key} must not carry a committed default`);
  }
  // All five are settable from the panel — they are NOT deploy-owned
  // credentials, and an operator has no other way to turn connect on.
  for (const key of KEYS) {
    assert.equal(BY_KEY.get(key).unwritable, false, `${key} must be writable from the panel`);
  }
});

test('no waitlist module reads an undeclared WAITLIST_* variable', () => {
  // Drift guard. A sixth waitlist variable has to be declared in the same
  // commit that starts reading it, or this fails.
  const MODULES = ['src/config.js', 'src/routes/waitlist-connect.js'];
  const seen = new Set();
  for (const rel of MODULES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (m[1].startsWith('WAITLIST_')) seen.add(m[1]);
    }
  }
  assert.equal(seen.size, KEYS.length, 'sanity: the scrape found every read');
  for (const key of seen) {
    assert.ok(BY_KEY.has(key),
      `${key} is read by the platform but is not declared in dapp.json platform_env`);
  }
});

// ── the unset deployment ───────────────────────────────────────────────

// The routes take their pool from getPool(config) at construction time and
// resolve the capability token through the waitlist service. Swap both
// before requiring the route modules, so these exercise the REAL routing
// and redirect logic against a stubbed data layer.
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [] }) });

const waitlist = require('../src/services/waitlist');
const TOKEN = 'more-token-fixture';
waitlist.getSignupByMoreToken = async (_pool, token) => (
  token === TOKEN ? { id: 1, email: 'x@example.com', answers: { handles: {} } } : null
);

const { waitlistConnectRoutes } = require('../src/routes/waitlist-connect');
const { publicApiRoutes } = require('../src/routes/public-api');

// Nothing set: the state this deployment is in for X today.
const UNSET = {
  env: 'production',
  port: 3000,
  waitlistGithubClientId: '',
  waitlistGithubClientSecret: '',
  waitlistXClientId: '',
  waitlistXClientSecret: '',
  waitlistOauthOrigin: '',
};
// Both providers configured — used only to mint a real state nonce, and to
// pin the callback URL the developer-portal runbooks tell operators to
// register.
const CONFIGURED = {
  ...UNSET,
  waitlistGithubClientId: 'gh-id',
  waitlistGithubClientSecret: 'gh-secret',
  waitlistXClientId: 'x-id',
  waitlistXClientSecret: 'x-secret',
};

async function serve(router) {
  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const get = (base, p) => fetch(`${base}${p}`, { redirect: 'manual' });

let unset;
let configured;

test.before(async () => {
  unset = await serve(waitlistConnectRoutes(UNSET));
  configured = await serve(waitlistConnectRoutes(CONFIGURED));
});

test.after(() => {
  if (unset) unset.server.close();
  if (configured) configured.server.close();
});

test('an unconfigured provider bounces the start route back to the form', async () => {
  for (const provider of ['github', 'x']) {
    const res = await get(unset.base, `/waitlist/connect/${provider}?token=${TOKEN}`);
    assert.equal(res.status, 302, `${provider} must redirect, not error`);
    assert.equal(res.headers.get('location'), `/#more/${TOKEN}?connect=unavailable`,
      `${provider} must land back on the stage-2 form with the "not available yet" status`);
  }
});

test('the callback refuses the same way when the provider is unconfigured', async () => {
  // Mint a genuine state nonce on the configured router (the pending-state
  // map is module-level, so the unset router sees it), then complete the
  // round trip against the unset one: valid state, real code, no
  // credentials. It must degrade rather than attempt a token exchange it
  // cannot authenticate.
  const start = await get(configured.base, `/waitlist/connect/x?token=${TOKEN}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.ok(state, 'the configured start route parked a state nonce');

  const res = await get(unset.base, `/waitlist/connect/x/callback?state=${state}&code=abc123`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/#more/${TOKEN}?connect=unavailable`);
});

test('the callback URLs are exactly the ones the runbooks tell operators to register', async () => {
  // A mismatch fails at the provider's own redirect check, before any
  // platform code runs — so SELF-HOSTING.md's two URLs are pinned here
  // against what the routes actually build.
  const x = await get(configured.base, `/waitlist/connect/x?token=${TOKEN}`);
  const xUrl = new URL(x.headers.get('location'));
  assert.equal(xUrl.origin + xUrl.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(xUrl.searchParams.get('redirect_uri'),
    `${PRODUCTION_ORIGIN}/waitlist/connect/x/callback`);
  assert.equal(xUrl.searchParams.get('scope'), 'users.read tweet.read');
  assert.equal(xUrl.searchParams.get('code_challenge_method'), 'S256',
    'PKCE is mandatory for X, which is why the app must be a confidential Web App');

  const gh = await get(configured.base, `/waitlist/connect/github?token=${TOKEN}`);
  const ghUrl = new URL(gh.headers.get('location'));
  assert.equal(ghUrl.origin + ghUrl.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(ghUrl.searchParams.get('redirect_uri'),
    `${PRODUCTION_ORIGIN}/waitlist/connect/github/callback`);
  assert.equal(ghUrl.searchParams.get('scope'), null, 'no scope is requested');
});

test('the stage-2 payload reports each provider unavailable on its own', async () => {
  // This is what decides whether a connect BUTTON is rendered at all
  // (frontend/src/features/auth/more.tsx): an unavailable provider gets no
  // button, not a dead one.
  const none = await serve(publicApiRoutes(UNSET));
  try {
    const res = await fetch(`${none.base}/api/public/waitlist/more/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).oauth, { github: false, x: false });
  } finally {
    none.server.close();
  }

  // The asymmetric case this deployment is actually in: GitHub live, X
  // still waiting on a human to create the app.
  const half = await serve(publicApiRoutes({
    ...UNSET,
    waitlistGithubClientId: 'gh-id',
    waitlistGithubClientSecret: 'gh-secret',
  }));
  try {
    const res = await fetch(`${half.base}/api/public/waitlist/more/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).oauth, { github: true, x: false },
      'each provider is judged on its own pair of credentials');
  } finally {
    half.server.close();
  }
});

test('an id without a secret counts as unconfigured', async () => {
  // Half-configured is the easiest way to ship a button that dead-ends at
  // the provider. Both halves or neither.
  const half = await serve(waitlistConnectRoutes({ ...UNSET, waitlistXClientId: 'x-id' }));
  try {
    const res = await get(half.base, `/waitlist/connect/x?token=${TOKEN}`);
    assert.equal(res.headers.get('location'), `/#more/${TOKEN}?connect=unavailable`);
  } finally {
    half.server.close();
  }
});
