// Verified GitHub account link.
//
// This link exists for exactly one privileged operation — forking an app's
// repo into the user's own account so their coding agent has somewhere it
// may push — and it is the basis of an ATTRIBUTION decision later (only
// work headed by the caller's own fork may be submitted under their name).
// So the properties worth pinning are the ones that would let someone bind
// the wrong GitHub identity to an account, or read the token back out:
//
//   1. the OAuth `state` is signed, single-use in effect, time-limited and
//      bound to the session that started the flow;
//   2. the token is stored encrypted and never returned to a browser; and
//   3. the pre-existing self-declared `users.github` profile string is left
//      alone — it is unverified display text and must never be used for an
//      authorization decision.
//
// Run with: node --test tests/github-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const githubLink = require('../src/services/github-link');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/github-link.js'), 'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8'
);
const SCHEMA_SRC = fs.readFileSync(
  path.join(__dirname, '../src/db/schema.sql'), 'utf8'
);

const config = { sessionSecret: 'test-session-secret-value', cliAuthOrigin: 'https://example.test' };

test('state round-trips for the session that created it', () => {
  const state = githubLink.makeState(config, 42);
  const verified = githubLink.verifyState(config, state, 42);
  assert.ok(verified, 'the originating session verifies it');
  assert.equal(verified.userId, 42);
});

test('state is bound to the user who started the flow', () => {
  const state = githubLink.makeState(config, 42);
  // The load-bearing case: another signed-in user presenting someone
  // else's callback must not bind that GitHub identity to their account.
  assert.equal(githubLink.verifyState(config, state, 43), null);
  assert.equal(githubLink.verifyState(config, state, 0), null);
  assert.equal(githubLink.verifyState(config, state, null), null);
});

test('state is signed — it cannot be forged or edited', () => {
  const state = githubLink.makeState(config, 42);
  const [userId, expiry, nonce, mac] = state.split('.');

  // Re-pointing it at another user invalidates the signature.
  assert.equal(githubLink.verifyState(config, `43.${expiry}.${nonce}.${mac}`, 43), null);
  // Extending its life invalidates it too.
  const later = Number(expiry) + 60_000;
  assert.equal(githubLink.verifyState(config, `${userId}.${later}.${nonce}.${mac}`, 42), null);
  // A different deployment secret cannot mint one that verifies here.
  const foreign = githubLink.makeState({ sessionSecret: 'someone-elses-secret' }, 42);
  assert.equal(githubLink.verifyState(config, foreign, 42), null);
  // Garbage in, null out — never a throw.
  for (const bad of ['', 'x', 'a.b.c.d', '42.notanumber.x.y', null, undefined, 'x'.repeat(400)]) {
    assert.equal(githubLink.verifyState(config, bad, 42), null);
  }
});

test('state expires', () => {
  const state = githubLink.makeState(config, 42);
  const [userId, , nonce] = state.split('.');
  const expired = Date.now() - 1000;
  // Even correctly signed for that expiry, a past deadline fails.
  const crypto = require('node:crypto');
  const mac = crypto.createHmac('sha256', config.sessionSecret)
    .update(`github-link\0${userId}\0${expired}\0${nonce}`, 'utf8')
    .digest('base64url');
  assert.equal(githubLink.verifyState(config, `${userId}.${expired}.${nonce}.${mac}`, 42), null);
  assert.ok(githubLink.STATE_TTL_MS <= 15 * 60 * 1000, 'the window is short');
});

test('the authorize URL asks for public_repo and nothing more', () => {
  const url = githubLink.authorizeUrl(
    { ...config, waitlistGithubClientId: 'cid', waitlistGithubClientSecret: 'secret' },
    { userId: 42, redirectUri: 'https://example.test/api/me/github/callback' }
  );
  assert.ok(url.startsWith('https://github.com/login/oauth/authorize?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('scope'), 'public_repo',
    'the smallest scope that can fork a public repo');
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.get('redirect_uri'), 'https://example.test/api/me/github/callback');
  assert.ok(params.get('state'), 'a state is always attached');
  // Never the broad `repo` scope, which would reach private repositories.
  assert.notEqual(params.get('scope'), 'repo');
  assert.equal(githubLink.SCOPE, 'public_repo');
});

test('the link surface is absent when no OAuth app is configured', () => {
  assert.equal(githubLink.isEnabled({}), false);
  assert.equal(githubLink.authorizeUrl({}, { userId: 1, redirectUri: 'https://x.test/cb' }), null);
  assert.equal(
    githubLink.isEnabled({ waitlistGithubClientId: 'a', waitlistGithubClientSecret: 'b' }),
    true
  );
  // The routes 404 rather than half-working.
  assert.match(
    ROUTE_SRC,
    /if \(!githubLink\.isEnabled\(config\)\) return res\.status\(404\)\.json\(\{ error: 'not_found' \}\)/
  );
  // And the Settings section says so instead of offering a dead button.
  const settingsSrc = fs.readFileSync(path.join(__dirname, '../public/js/settings.js'), 'utf8');
  assert.match(settingsSrc, /link\.available === false[\s\S]{0,300}not configured/);
});

test('the token is stored encrypted and never leaves the server', () => {
  assert.match(SRC, /secrets\.encrypt\(token, config\.dataEncryptionKey\)/);
  // The status shape returned to the browser carries presence, not value.
  assert.match(SRC, /\(github_oauth_token_enc IS NOT NULL\) AS has_token/);
  const statusFn = SRC.slice(SRC.indexOf('async function linkStatus'), SRC.indexOf('async function loadUserToken'));
  assert.doesNotMatch(statusFn, /token_enc[^)]*\bAS\b(?! has_token)/);
  assert.doesNotMatch(statusFn, /token:/);
  // A decrypt failure reads as "not linked", matching how the BYOK key
  // path tolerates the same case, rather than throwing mid-request.
  assert.match(SRC, /token decryption failed; treating as unlinked/);
  // The column is staging:private, so a staging clone carries no token.
  assert.match(SCHEMA_SRC, /COMMENT ON COLUMN users\.github_oauth_token_enc IS 'staging:private'/);
});

test('unlink clears every part of the link', () => {
  const clearFn = SRC.slice(SRC.indexOf('async function clearLink'), SRC.indexOf('// Non-secret status'));
  for (const column of ['github_login', 'github_oauth_token_enc', 'github_linked_at']) {
    assert.match(clearFn, new RegExp(`${column} = NULL`), `${column} is cleared`);
  }
});

test('the unverified profile field is left alone', () => {
  // users.github is a self-declared display string. Writing the verified
  // login into it — or reading it here — would turn display text into an
  // authorization input.
  assert.doesNotMatch(SRC, /\bSET github\s*=/);
  assert.doesNotMatch(SRC, /SELECT github\b(?!_)/);
  // The verified columns are additive; the old one is untouched.
  assert.match(SCHEMA_SRC, /ADD COLUMN IF NOT EXISTS github_login/);
  assert.match(SCHEMA_SRC, /ADD COLUMN IF NOT EXISTS github_oauth_token_enc/);
});

test('a returned login is validated before it is trusted', () => {
  // The login becomes an ownership comparison later, so a malformed one
  // must never be stored.
  assert.match(SRC, /LOGIN_RE\.test\(login\)/);
  assert.equal(githubLink.LOGIN_RE.test('octo-contributor'), true);
  assert.equal(githubLink.LOGIN_RE.test('a'), true);
  assert.equal(githubLink.LOGIN_RE.test(''), false);
  assert.equal(githubLink.LOGIN_RE.test('-leading'), false);
  assert.equal(githubLink.LOGIN_RE.test('trailing-'), false);
  assert.equal(githubLink.LOGIN_RE.test('has space'), false);
  assert.equal(githubLink.LOGIN_RE.test('a/../b'), false);
  assert.equal(githubLink.LOGIN_RE.test('x'.repeat(40)), false);
});

test('the callback fails to Settings, never reflecting GitHub’s error', () => {
  const callback = ROUTE_SRC.slice(ROUTE_SRC.indexOf("router.get('/api/me/github/callback'"));
  assert.match(callback, /githubLink\.verifyState\(config, req\.query\.state, req\.user\.id\)/,
    'the state is verified against the session, not the request');
  assert.match(callback, /\?github=error/);
  assert.match(callback, /\?github=linked/);
  // Nothing from GitHub's response body is echoed into the redirect.
  assert.doesNotMatch(callback.slice(0, 1500), /req\.query\.error/);
});

test('staging gets a demo link so the connected layout is reviewable', () => {
  const demo = githubLink.demoLinkStatus();
  assert.equal(demo.linked, true);
  assert.equal(demo.login, 'octo-contributor');
  assert.equal(demo.demo, true);
  assert.ok(Number.isFinite(Date.parse(demo.linkedAt)));
  // Honoured only in staging, only with ?demo=1 — a no-op in production,
  // which never takes this branch and always reads the real link state.
  const handler = ROUTE_SRC.slice(
    ROUTE_SRC.indexOf("router.get('/api/me/github', userRate"),
    ROUTE_SRC.indexOf("router.get('/api/me/github/connect'")
  );
  assert.match(handler, /process\.env\.USERNODE_ENV === 'staging'/);
  assert.match(handler, /req\.query\.demo === '1'[\s\S]{0,120}demoLinkStatus\(\)/);
  // Without the flag, staging reports "not linked" rather than reading the
  // (staging:private, therefore empty) column.
  assert.match(handler, /linked: false, login: null, linkedAt: null/);
  // The real read is only reachable outside staging.
  const stagingIdx = handler.indexOf("USERNODE_ENV === 'staging'");
  const realReadIdx = handler.indexOf('githubLink.linkStatus(pool');
  assert.ok(stagingIdx > 0 && realReadIdx > stagingIdx,
    'the staging branch returns before the real credential read');
});
