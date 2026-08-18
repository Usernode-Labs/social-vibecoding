'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const xLink = require('../src/services/x-link');

const dedicated = { xLinkClientId: 'x-client', xLinkClientSecret: 'x-secret' };
const fallback = { waitlistXClientId: 'waitlist-x', waitlistXClientSecret: 'waitlist-secret' };
const state = 's'.repeat(43);
const challenge = 'c'.repeat(43);
const verifier = 'v'.repeat(64);

test('X supports a dedicated client or the complete waitlist-client fallback', () => {
  assert.equal(xLink.isEnabled(dedicated), true);
  assert.equal(xLink.isEnabled(fallback), true);
  assert.equal(xLink.isEnabled({ waitlistXClientId: 'id-only' }), false);
  assert.equal(xLink.isEnabled({ ...fallback, xLinkClientId: 'partial-dedicated' }), false);
  assert.equal(xLink.isEnabled({ ...fallback, xLinkClientSecret: 'partial-dedicated' }), false);
  assert.deepEqual(xLink.oauthCredentials({ ...fallback, ...dedicated }), {
    clientId: 'x-client', clientSecret: 'x-secret',
  });
});

test('authorize URL uses OAuth 2.0 PKCE and only the /users/me scopes', () => {
  const redirectUri = 'https://example.test/api/me/x/callback';
  const parsed = new URL(xLink.authorizeUrl(dedicated, {
    redirectUri, state, challenge,
  }));
  assert.equal(parsed.origin + parsed.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), challenge);
  assert.equal(parsed.searchParams.get('state'), state);
  assert.deepEqual(parsed.searchParams.get('scope').split(' ').sort(), [
    'tweet.read', 'users.read',
  ]);
});

function xFetch({ scope = 'tweet.read users.read', user = { id: '98765', username: 'x_user' } } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (url, init = {}) => {
      const call = { url: String(url), init, method: init.method || 'GET' };
      calls.push(call);
      if (call.url.endsWith('/2/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'x-once', scope }), { status: 200 });
      }
      if (call.url.endsWith('/2/users/me')) {
        return new Response(JSON.stringify({ data: user }), { status: 200 });
      }
      if (call.url.endsWith('/2/oauth2/revoke')) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    },
  };
}

test('exchange reads immutable id + username once and revokes the token', async () => {
  const originalFetch = global.fetch;
  const mock = xFetch();
  global.fetch = mock.fn;
  try {
    const result = await xLink.exchangeCode(dedicated, {
      code: 'one-time', redirectUri: 'https://example.test/api/me/x/callback', verifier,
    });
    assert.deepEqual(result, { provider: 'x', subject: '98765', handle: 'x_user' });
    const token = mock.calls.find((call) => call.url.endsWith('/2/oauth2/token'));
    const form = new URLSearchParams(token.init.body);
    assert.equal(form.get('code_verifier'), verifier);
    assert.match(token.init.headers.authorization, /^Basic /);
    const me = mock.calls.find((call) => call.url.endsWith('/2/users/me'));
    assert.equal(me.init.headers.authorization, 'Bearer x-once');
    const revoke = mock.calls.find((call) => call.url.endsWith('/2/oauth2/revoke'));
    assert.ok(revoke);
    assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'x-once');
    assert.equal(JSON.stringify(result).includes('x-once'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('credentialSource mirrors oauthCredentials precedence exactly (#1291)', () => {
  assert.equal(xLink.credentialSource({ ...fallback, ...dedicated }), 'dedicated');
  assert.equal(xLink.credentialSource(dedicated), 'dedicated');
  assert.equal(xLink.credentialSource(fallback), 'waitlist');
  // A partial dedicated pair disables the whole flow rather than splicing in
  // half of the waitlist pair — the source must report that as null too.
  assert.equal(xLink.credentialSource({ ...fallback, xLinkClientId: 'partial' }), null);
  assert.equal(xLink.credentialSource({ ...fallback, xLinkClientSecret: 'partial' }), null);
  assert.equal(xLink.credentialSource({}), null);
});

test('a dedicated pair sharing the waitlist client id is flagged as the same X app', () => {
  assert.equal(xLink.sameAppAsWaitlist({ ...dedicated, waitlistXClientId: 'x-client' }), true);
  assert.equal(xLink.sameAppAsWaitlist({ ...dedicated, ...fallback }), false);
  assert.equal(xLink.sameAppAsWaitlist(dedicated), false);
  assert.equal(xLink.sameAppAsWaitlist(fallback), false);
  assert.equal(xLink.sameAppAsWaitlist({}), false);
});

test('the credential probe classifies X token-endpoint responses (#1291)', async () => {
  const originalFetch = global.fetch;
  try {
    for (const [status, body, expected] of [
      [401, { error: 'invalid_client' }, 'rejected'],
      [403, { error: 'invalid_client' }, 'rejected'],
      [400, { error: 'invalid_grant' }, 'ok'],
      [400, { error: 'invalid_request' }, 'ok'],
      [500, {}, 'indeterminate'],
    ]) {
      const calls = [];
      global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(body), { status });
      };
      assert.equal(await xLink.checkClientCredentials(dedicated), expected);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith('/2/oauth2/token'));
      assert.equal(calls[0].init.method, 'POST');
      assert.match(calls[0].init.headers.authorization, /^Basic /);
      // The probe is deliberately bogus: no real code or verifier exists,
      // and the secret travels only in the Basic header, never the form.
      const form = new URLSearchParams(calls[0].init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'diagnostic-probe-invalid-code');
      assert.equal(String(calls[0].init.body).includes('x-secret'), false);
    }

    global.fetch = async () => { throw new Error('network down'); };
    assert.equal(await xLink.checkClientCredentials(dedicated), 'indeterminate');

    // No configured pair: indeterminate without touching the network.
    global.fetch = async () => { throw new Error('must not be called'); };
    assert.equal(await xLink.checkClientCredentials({}), 'indeterminate');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a refused token exchange logs X\'s error strings, never code/verifier/secret', async () => {
  const originalFetch = global.fetch;
  const logger = require('../src/services/logger');
  const originalWarn = logger.warn;
  const entries = [];
  logger.warn = (cat, msg, data) => entries.push({ cat, msg, data });
  global.fetch = async () => new Response(JSON.stringify({
    error: 'invalid_request',
    error_description: 'Value passed for the authorization code was invalid.',
  }), { status: 400 });
  try {
    const result = await xLink.exchangeCode(dedicated, {
      code: 'one-time-code-value',
      redirectUri: 'https://example.test/api/me/x/callback',
      verifier,
    });
    assert.equal(result, null);
    const entry = entries.find((e) => e.msg === 'token exchange refused');
    assert.ok(entry, 'exchange failure must leave a log entry');
    assert.equal(entry.data.status, 400);
    assert.equal(entry.data.error, 'invalid_request');
    assert.match(entry.data.description, /authorization code/);
    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes('one-time-code-value'), false);
    assert.equal(serialized.includes(verifier), false);
    assert.equal(serialized.includes('x-secret'), false);
  } finally {
    global.fetch = originalFetch;
    logger.warn = originalWarn;
  }
});

test('scope inflation and malformed X identities fail closed but still revoke', async () => {
  const originalFetch = global.fetch;
  for (const options of [
    { scope: 'tweet.read users.read offline.access' },
    { scope: 'users.read' },
    { user: { id: '0', username: 'valid' } },
    { user: { id: '44', username: 'not-valid-because-too-long' } },
  ]) {
    const mock = xFetch(options);
    global.fetch = mock.fn;
    assert.equal(await xLink.exchangeCode(dedicated, {
      code: 'code', redirectUri: 'https://example.test/api/me/x/callback', verifier,
    }), null);
    assert.ok(mock.calls.some((call) => call.url.endsWith('/2/oauth2/revoke')));
  }
  global.fetch = originalFetch;
});
