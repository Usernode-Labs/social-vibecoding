'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ClassicApiClient,
  ClassicApiClientError,
  buildPath,
  sanitizeForModel,
} = require('../src/services/global-chat/classic-api-client');

const SESSION = 'a'.repeat(64);
const ROUTE = {
  status: 'mapped',
  transport: 'server_loopback',
  capabilityId: 'issues.get.apps.item.issues.item.test1234',
  method: 'GET',
  path: '/api/apps/:slug/issues/:number',
};

function client(overrides = {}) {
  return new ClassicApiClient({
    baseUrl: 'http://127.0.0.1:3000',
    browserOrigin: 'https://my.onhomeroom.com',
    sessionToken: SESSION,
    routes: [ROUTE],
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    ...overrides,
  });
}

test('the Classic bridge derives method and path from its exact capability allowlist', async () => {
  let observed;
  const bridge = client({
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return new Response(JSON.stringify({ issue: { number: 17, title: 'Fix it' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    },
  });
  const result = await bridge.invoke(ROUTE.capabilityId, {
    pathParameters: { slug: 'demo/../../other', number: 17 },
    query: [{ name: 'include', value: 'comments' }],
  });
  assert.equal(
    observed.url,
    'http://127.0.0.1:3000/api/apps/demo%2F..%2F..%2Fother/issues/17?include=comments',
  );
  assert.equal(observed.init.method, 'GET');
  assert.equal(observed.init.redirect, 'manual');
  assert.equal(observed.init.headers.cookie, `session=${SESSION}`);
  assert.equal(observed.init.headers.origin, 'https://my.onhomeroom.com');
  assert.equal(observed.init.headers['sec-fetch-site'], 'same-origin');
  assert.deepEqual(result.authoritativeResult, { issue: { number: 17, title: 'Fix it' } });
});

test('a model cannot select arbitrary URLs, methods, headers, or non-loopback capabilities', async () => {
  const bridge = client();
  await assert.rejects(
    bridge.invoke('issues.get.not-registered', {}),
    (error) => error instanceof ClassicApiClientError && error.code === 'capability_not_callable',
  );
  await assert.rejects(
    bridge.invoke(ROUTE.capabilityId, {
      pathParameters: { slug: 'demo', number: 1 },
      method: 'DELETE',
    }),
    (error) => error.code === 'invalid_input',
  );
  const native = client({ routes: [{ ...ROUTE, transport: 'native_client' }] });
  await assert.rejects(
    native.invoke(ROUTE.capabilityId, {}),
    (error) => error.code === 'capability_not_callable',
  );
});

test('path and query inputs are encoded and bounded before a request is dispatched', async () => {
  assert.equal(buildPath('/api/apps/:slug', { slug: 'a?x=1#fragment' }), '/api/apps/a%3Fx%3D1%23fragment');
  assert.throws(
    () => buildPath('/api/apps/:slug', { slug: 'a', extra: 'no' }),
    (error) => error.code === 'invalid_input',
  );
  let called = 0;
  const bridge = client({ fetchImpl: async () => { called += 1; return new Response('{}'); } });
  await assert.rejects(
    bridge.invoke(ROUTE.capabilityId, {
      pathParameters: { slug: 'demo', number: 1 },
      query: [{ name: 'bad/name', value: 'x' }],
    }),
    (error) => error.code === 'invalid_input',
  );
  assert.equal(called, 0);
});

test('authoritative results stay intact while model results recursively remove credentials', async () => {
  const body = {
    token: 'top-level-secret',
    item: {
      title: 'Visible',
      access_token: 'nested-secret',
      accessToken: 'camel-secret',
      token_hint: 'also hidden',
      session: { id: 42, status: 'active' },
      description: 'x'.repeat(5_000),
    },
  };
  const bridge = client({
    fetchImpl: async () => new Response(JSON.stringify(body), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const result = await bridge.invoke(ROUTE.capabilityId, {
    pathParameters: { slug: 'demo', number: 1 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.authoritativeResult.token, 'top-level-secret');
  assert.equal(result.modelResult.data.token, undefined);
  assert.equal(result.modelResult.data.item.access_token, undefined);
  assert.equal(result.modelResult.data.item.accessToken, undefined);
  assert.equal(result.modelResult.data.item.token_hint, undefined);
  assert.deepEqual(result.modelResult.data.item.session, { id: 42, status: 'active' });
  assert.match(result.modelResult.data.item.description, /\[truncated\]$/);
  assert.doesNotMatch(JSON.stringify(result.modelResult), /nested-secret|camel-secret|top-level-secret/);
});

test('large or non-JSON Classic responses are refused without exposing their body', async () => {
  const oversized = client({
    maxResponseBytes: 1024,
    fetchImpl: async () => new Response(JSON.stringify({ value: 'x'.repeat(2_000) }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  await assert.rejects(
    oversized.invoke(ROUTE.capabilityId, { pathParameters: { slug: 'demo', number: 1 } }),
    (error) => error.code === 'response_too_large' && !error.message.includes('xxxx'),
  );

  const html = client({
    fetchImpl: async () => new Response('<script>private()</script>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  });
  await assert.rejects(
    html.invoke(ROUTE.capabilityId, { pathParameters: { slug: 'demo', number: 1 } }),
    (error) => error.code === 'unexpected_classic_response'
      && !error.message.includes('private'),
  );
});

test('standalone model sanitization is depth, item, and key bounded', () => {
  const value = { rows: Array.from({ length: 80 }, (_, index) => ({ index })) };
  let nested = value;
  for (let index = 0; index < 12; index += 1) {
    nested.next = {};
    nested = nested.next;
  }
  const clean = sanitizeForModel(value);
  assert.equal(clean.rows.length, 51);
  assert.match(clean.rows.at(-1), /more items/);
  let cursor = clean;
  for (let index = 0; index < 8; index += 1) cursor = cursor.next;
  assert.equal(cursor, '[nested data omitted]');
});
