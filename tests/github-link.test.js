'use strict';

// GitHub adapter for the provider-neutral social identity proof. The
// database/state contract is covered in social-identity.test.js; this file
// pins the provider boundary: dedicated app, PKCE, no scope, immutable id,
// and no retained token.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const githubLink = require('../src/services/github-link');

const SRC = fs.readFileSync(path.join(__dirname, '../src/services/github-link.js'), 'utf8');
const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/social-identities.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8'
);

const config = {
  cliAuthOrigin: 'https://example.test',
  githubLinkClientId: 'cid',
  githubLinkClientSecret: 'secret',
};
const state = 's'.repeat(43);
const challenge = 'c'.repeat(43);
const verifier = 'v'.repeat(64);

test('GitHub account proof requires its dedicated OAuth app', () => {
  assert.equal(githubLink.isEnabled({}), false);
  assert.equal(githubLink.isEnabled(config), true);
  assert.equal(githubLink.isEnabled({
    waitlistGithubClientId: 'waitlist',
    waitlistGithubClientSecret: 'waitlist-secret',
  }), false, 'GitHub OAuth apps have one callback; waitlist fallback would dead-end');
});

test('authorize URL uses PKCE S256 and omits scope entirely', () => {
  const redirectUri = 'https://example.test/api/me/github/callback';
  const url = githubLink.authorizeUrl(config, { redirectUri, state, challenge });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'cid');
  assert.equal(parsed.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(parsed.searchParams.get('code_challenge'), challenge);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.has('scope'), false);
  assert.equal(githubLink.SCOPE, '');
  assert.equal(githubLink.authorizeUrl(config, {
    redirectUri, state: 'short', challenge,
  }), null);
  assert.doesNotMatch(SRC, /['"]public_repo['"]/);
});

function githubFetch({ scope = '', user = { id: 12345, login: 'octo-contributor' }, revokeOk = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), init, method: init.method || 'GET' };
    calls.push(call);
    if (call.url.includes('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_once', scope }), { status: 200 });
    }
    if (call.url === 'https://api.github.com/user') {
      return new Response(JSON.stringify(user), { status: 200 });
    }
    if (/\/applications\/cid\/(?:token|grant)$/.test(call.url)) {
      return new Response(revokeOk ? null : 'unavailable', { status: revokeOk ? 204 : 503 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fn, calls };
}

test('exchange reads immutable id + login once, then revokes and returns no token', async () => {
  const originalFetch = global.fetch;
  const mock = githubFetch();
  global.fetch = mock.fn;
  try {
    const identity = await githubLink.exchangeCode(config, {
      code: 'one-time-code',
      redirectUri: 'https://example.test/api/me/github/callback',
      verifier,
    });
    assert.deepEqual(identity, {
      provider: 'github', subject: '12345', handle: 'octo-contributor',
    });
    const tokenCall = mock.calls.find((c) => c.url.includes('/login/oauth/access_token'));
    assert.equal(JSON.parse(tokenCall.init.body).code_verifier, verifier);
    const userCall = mock.calls.find((c) => c.url === 'https://api.github.com/user');
    assert.equal(userCall.init.headers.authorization, 'Bearer gho_once');
    const revoke = mock.calls.find((c) => /\/applications\/cid\/token$/.test(c.url));
    assert.ok(revoke);
    assert.equal(revoke.method, 'DELETE');
    assert.deepEqual(JSON.parse(revoke.init.body), { access_token: 'gho_once' });
    assert.equal(JSON.stringify(identity).includes('gho_once'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unexpected or missing cumulative scope is rejected and the whole grant is revoked', async () => {
  const originalFetch = global.fetch;
  const mock = githubFetch({ scope: 'repo' });
  global.fetch = mock.fn;
  try {
    const identity = await githubLink.exchangeCode(config, {
      code: 'code', redirectUri: 'https://example.test/api/me/github/callback', verifier,
    });
    assert.equal(identity, null);
    assert.equal(mock.calls.some((c) => c.url === 'https://api.github.com/user'), false);
    assert.ok(mock.calls.some((c) => /\/applications\/cid\/grant$/.test(c.url)));
  } finally {
    global.fetch = originalFetch;
  }

  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_missing_scope' }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  try {
    assert.equal(await githubLink.exchangeCode(config, {
      code: 'code', redirectUri: 'https://example.test/api/me/github/callback', verifier,
    }), null);
    assert.ok(calls.some((url) => /\/grant$/.test(url)));
  } finally {
    global.fetch = originalFetch;
  }
});

test('invalid provider identities are refused, while revoke failure cannot leak a token locally', async () => {
  const originalFetch = global.fetch;
  for (const user of [
    { id: 0, login: 'valid' },
    { id: 12, login: '-invalid' },
    { id: '12', login: 'valid' },
  ]) {
    const mock = githubFetch({ user });
    global.fetch = mock.fn;
    assert.equal(await githubLink.exchangeCode(config, {
      code: 'code', redirectUri: 'https://example.test/api/me/github/callback', verifier,
    }), null);
    assert.ok(mock.calls.some((c) => /\/token$/.test(c.url)));
  }
  const mock = githubFetch({ revokeOk: false });
  global.fetch = mock.fn;
  try {
    assert.deepEqual(await githubLink.exchangeCode(config, {
      code: 'code', redirectUri: 'https://example.test/api/me/github/callback', verifier,
    }), { provider: 'github', subject: '12345', handle: 'octo-contributor' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy GitHub attribution remains readable but no credential API exists', async () => {
  const pool = {
    query: async () => ({
      rows: [{ github_login: 'octo-contributor', github_linked_at: new Date(0) }],
    }),
  };
  const status = await githubLink.linkStatus(pool, 7);
  assert.equal(status.linked, true);
  assert.equal(status.login, 'octo-contributor');
  assert.equal(status.access, 'identity');
  assert.equal(typeof githubLink.loadUserToken, 'undefined');
  assert.doesNotMatch(SRC, /secrets\.encrypt/);
  assert.match(SCHEMA_SRC, /github_oauth_token_enc is LEGACY and always NULL/);
});

test('social identity routes own GitHub independently of MCP and preserve reviewable copy', () => {
  assert.match(ROUTE_SRC, /router\.get\('\/api\/me\/github\/callback'/);
  assert.match(ROUTE_SRC, /consumeOauthState\(pool/);
  assert.match(ROUTE_SRC, /saveIdentity\(pool, req\.user\.id, identity\)/);
  assert.match(ROUTE_SRC, /router\.delete\('\/api\/me\/social-identities\/:provider'/);
  assert.match(SETTINGS_SRC, /holds no GitHub access token/);
  assert.match(SETTINGS_SRC, /github\.com\/settings\/applications/);

  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const section = html.slice(
    html.indexOf('id="github-link-section"'),
    html.indexOf('id="github-link-status"')
  );
  assert.match(section, /no access to your repositories/i);
  assert.match(section, /stores no provider token/i);
  assert.match(section, /not proof of unique humanity/i);
});
