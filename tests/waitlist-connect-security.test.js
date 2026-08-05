// Security and privacy boundaries for the anonymous waitlist OAuth flow.
// This flow verifies survey handles only: it does not create a signed-in
// social identity and must never be used as a credit entitlement.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER_TIMEOUT_MS,
  STATE_TTL_MS,
  _testing: { fetchJson, putState, resetPendingForTests, takeState },
} = require('../src/routes/waitlist-connect');

test.beforeEach(() => resetPendingForTests());
test.afterEach(() => resetPendingForTests());

test('OAuth state is one-time and a retry replaces the same capability/provider flow', () => {
  const entry = { token: 'a'.repeat(48), provider: 'github' };
  const first = putState(entry, 1_000);
  const second = putState(entry, 2_000);

  assert.notEqual(first, second);
  assert.equal(takeState(first, 2_001), null, 'superseded state is invalid');
  assert.deepEqual(takeState(second, 2_001), {
    ...entry,
    expiresAt: 2_000 + STATE_TTL_MS,
  });
  assert.equal(takeState(second, 2_001), null, 'state cannot be replayed');
});

test('OAuth state stays provider-bound and expires at its deadline', () => {
  const github = putState({ token: 'b'.repeat(48), provider: 'github' }, 10);
  const x = putState({ token: 'b'.repeat(48), provider: 'x', verifier: 'pkce' }, 10);

  assert.equal(takeState(github, 11).provider, 'github');
  assert.equal(takeState(x, 11).provider, 'x');

  const expiring = putState({ token: 'c'.repeat(48), provider: 'x' }, 20);
  assert.equal(takeState(expiring, 20 + STATE_TTL_MS), null);
});

test('provider requests carry a fixed deadline signal', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, opts) => {
      assert.ok(opts.signal instanceof AbortSignal);
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    assert.equal(PROVIDER_TIMEOUT_MS, 10_000);
    assert.deepEqual(await fetchJson('https://provider.invalid/profile', {}), { ok: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider HTTP errors omit the untrusted response body', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'access_token=must-not-reach-logs',
    });
    await assert.rejects(
      fetchJson('https://provider.invalid/token', {}),
      (err) => err.message === 'HTTP 401' && !err.message.includes('must-not-reach-logs')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('caller-supplied abort signals are preserved', async () => {
  const originalFetch = global.fetch;
  const signal = AbortSignal.abort();
  try {
    global.fetch = async (_url, opts) => {
      assert.equal(opts.signal, signal);
      return { ok: true, status: 200, text: async () => '{}' };
    };
    await fetchJson('https://provider.invalid/profile', { signal });
  } finally {
    global.fetch = originalFetch;
  }
});
