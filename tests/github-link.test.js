// Verified GitHub account link — IDENTITY ONLY.
//
// This link exists for exactly one thing: an ATTRIBUTION decision later
// (only work headed by the caller's own fork may be submitted under their
// name). It asks GitHub for NO scope, and it keeps NO credential — the fork
// it used to make on the user's behalf is now made by their own coding
// agent. So the properties worth pinning are the ones that would let someone
// bind the wrong GitHub identity to an account, or quietly reintroduce a
// repository grant:
//
//   1. the OAuth `state` is signed, single-use in effect, time-limited and
//      bound to the session that started the flow;
//   2. the authorize URL requests no scope at all, and the token that comes
//      back is revoked rather than stored; and
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

test('the authorize URL asks for NO scope at all', () => {
  const url = githubLink.authorizeUrl(
    { ...config, waitlistGithubClientId: 'cid', waitlistGithubClientSecret: 'secret' },
    { userId: 42, redirectUri: 'https://example.test/api/me/github/callback' }
  );
  assert.ok(url.startsWith('https://github.com/login/oauth/authorize?'));
  const params = new URL(url).searchParams;
  // The parameter is ABSENT, not empty: GitHub then issues a token with no
  // scopes and its consent screen says "public data only". `public_repo`
  // (the old value) reads on that screen as read/write access to code in
  // every public repository the user can reach.
  assert.equal(params.has('scope'), false, 'no scope parameter is sent');
  assert.equal(githubLink.SCOPE, '');
  assert.ok(!/[?&]scope=/.test(url), 'and none is smuggled in by hand');
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.get('redirect_uri'), 'https://example.test/api/me/github/callback');
  assert.ok(params.get('state'), 'a state is always attached');
  // The two scopes that could fork, neither of which may come back.
  assert.doesNotMatch(SRC, /'public_repo'|"public_repo"/);
  assert.doesNotMatch(SRC, /scope:\s*['"]repo['"]/);
});

test('the token is used once, revoked, and never persisted', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', init });
    if (String(url).includes('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_used_once' }), { status: 200 });
    }
    if (String(url) === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ login: 'octo-contributor' }), { status: 200 });
    }
    if (/\/applications\/cid\/token$/.test(String(url))) {
      return new Response('', { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const creds = { ...config, waitlistGithubClientId: 'cid', waitlistGithubClientSecret: 'secret' };
  try {
    const linked = await githubLink.exchangeCode(creds, {
      code: 'abc', redirectUri: 'https://example.test/api/me/github/callback',
    });
    // The login is the ONLY thing that comes back. A token in the return
    // value is a token something downstream can store.
    assert.deepEqual(linked, { login: 'octo-contributor' });

    const revoke = calls.find((c) => /\/applications\/cid\/token$/.test(c.url));
    assert.ok(revoke, 'the token is handed back to GitHub');
    assert.equal(revoke.method, 'DELETE');
    assert.match(revoke.init.headers.authorization, /^Basic /,
      'revocation authenticates as the OAuth app, not as the user');
    assert.deepEqual(JSON.parse(revoke.init.body), { access_token: 'gho_used_once' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('a failed revoke still links the account', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_x' }), { status: 200 });
    }
    if (String(url) === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ login: 'octo-contributor' }), { status: 200 });
    }
    // GitHub refuses the revocation: the token has no scopes and is dropped
    // on the floor either way, so the link must not fail over it.
    throw new Error('network down');
  };
  try {
    const linked = await githubLink.exchangeCode(
      { ...config, waitlistGithubClientId: 'cid', waitlistGithubClientSecret: 'secret' },
      { code: 'abc', redirectUri: 'https://example.test/api/me/github/callback' }
    );
    assert.deepEqual(linked, { login: 'octo-contributor' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('saveLink stores the login and NULLs the legacy token column', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  await githubLink.saveLink(pool, config, 7, { login: 'octo-contributor', token: 'gho_ignored' });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /github_oauth_token_enc = NULL/);
  assert.deepEqual(queries[0].params, [7, 'octo-contributor']);
  // Even when a caller passes one, no token reaches the database.
  assert.equal(queries[0].params.includes('gho_ignored'), false);
  // And the module cannot encrypt one: the secrets helper is gone from it.
  assert.doesNotMatch(SRC, /secrets\.encrypt/);
  assert.equal(typeof githubLink.loadUserToken, 'undefined',
    'nothing can load a user token back out — the loader no longer exists');
});

test('the link status is the login alone, and says no token is held', async () => {
  const pool = {
    query: async () => ({ rows: [{ github_login: 'octo-contributor', github_linked_at: new Date(0) }] }),
  };
  const status = await githubLink.linkStatus(pool, 7);
  assert.equal(status.linked, true, 'a login with no token IS a link now');
  assert.equal(status.login, 'octo-contributor');
  assert.equal(status.access, 'identity');
  // The read must not depend on the legacy column: requiring a token would
  // read every identity-only link as unlinked.
  const statusFn = SRC.slice(SRC.indexOf('async function linkStatus'), SRC.indexOf('function demoLinkStatus'));
  assert.doesNotMatch(statusFn, /github_oauth_token_enc/);
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
  const settingsSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8');
  assert.match(settingsSrc, /link\.available === false[\s\S]{0,300}not configured/);
});

test('no user credential is stored, and the legacy column is swept', () => {
  // The column stays in the schema (a rollback mid-deploy must not hit a
  // missing column) and stays staging:private, but it is never written.
  assert.match(SCHEMA_SRC, /COMMENT ON COLUMN users\.github_oauth_token_enc IS 'staging:private'/);
  assert.match(SCHEMA_SRC, /github_oauth_token_enc is LEGACY and always NULL/);

  // A boot-time sweep hands back any token an older release stored. Nulling
  // alone would not do: classic OAuth grants are cumulative, so the
  // previously-granted public_repo survives re-authorizing with no scope and
  // can only be handed back with the token itself.
  const MIGRATE_SRC = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.match(MIGRATE_SRC, /async function revokeLegacyGithubGrants\(pool, config\)/);
  assert.match(MIGRATE_SRC, /await revokeLegacyGithubGrants\(pool, config\)/);
  const sweep = MIGRATE_SRC.slice(
    MIGRATE_SRC.indexOf('async function revokeLegacyGithubGrants'),
    MIGRATE_SRC.indexOf('// One-shot, idempotent backfill that recovers chat_sessions.linked_issues')
  );
  assert.match(sweep, /revokeCredential\(config, token, 'grant'\)/);
  // The column is cleared whether or not GitHub answered — otherwise a
  // failing revoke means holding the credential forever.
  assert.match(sweep, /UPDATE users SET github_oauth_token_enc = NULL WHERE id = \$1/);
  assert.match(sweep, /LIMIT \$1/, 'the sweep is bounded');
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

test('the Settings copy describes the grant it actually asks for', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const section = html.slice(
    html.indexOf('id="github-link-section"'),
    html.indexOf('id="github-link-status"')
  );
  assert.ok(section, 'the GitHub section is still there');
  // The old copy promised "access to public repositories" — which is what
  // GitHub's consent screen used to say, and no longer does.
  assert.doesNotMatch(section, /access to public repositories/i);
  assert.match(section, /no access to your repositories/i);
  assert.match(section, /stores no GitHub token/i);

  // And the connected row states it too, driven by the server's `access`
  // field rather than a hardcoded claim.
  const settingsSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8');
  assert.match(settingsSrc, /link\.access === 'identity'/);
  assert.match(settingsSrc, /holds no GitHub access token/);
  assert.match(settingsSrc, /github\.com\/settings\/applications/);
});

test('staging gets a demo link so the connected layout is reviewable', () => {
  const demo = githubLink.demoLinkStatus();
  assert.equal(demo.linked, true);
  assert.equal(demo.login, 'octo-contributor');
  assert.equal(demo.demo, true);
  // Without `access` the staging preview renders the connected row in its
  // OLD shape and the "no token held" line — the whole point of the change —
  // is unreviewable.
  assert.equal(demo.access, 'identity');
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
