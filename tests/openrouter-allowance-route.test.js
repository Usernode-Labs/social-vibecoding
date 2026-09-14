'use strict';

// #2118: GET /api/me/credentials/openrouter/allowance — the live figure the
// dev-chat composer's meter shows for an OpenRouter session. The route asks
// OpenRouter with the stored key and returns only allowlisted figures (never
// key material); without a usable credential it says so instead of asking;
// and a provider failure is a 502, never a guessed figure.
//
// Run with: node --test tests/openrouter-allowance-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolModule = require('../src/db/pool');
const credentialStore = require('../src/services/credential-store');
const openrouterClient = require('../src/services/openrouter-client');

async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Stub the credential store and the OpenRouter client around one mounted
// copy of the routes; the pool must never be read directly.
async function mount(t, { metadata, secret, validateKey }) {
  const originals = {
    getPool: poolModule.getPool,
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    validateKey: openrouterClient.validateKey,
  };
  poolModule.getPool = () => ({ async query() { throw new Error('no direct pool read expected'); } });
  credentialStore.readMetadata = async () => metadata;
  credentialStore.readSecret = async () => secret;
  openrouterClient.validateKey = validateKey;
  const routePath = require.resolve('../src/routes/credentials');
  delete require.cache[routePath];
  const { credentialRoutes } = require(routePath);
  const { server, base } = await listen(credentialRoutes({
    codexOpenrouterEnabled: true,
    openrouterBetaUserIds: [],
    openrouterApiBase: 'https://openrouter.ai/api/v1',
    openrouterOrigin: 'https://usernode.dev',
    dataEncryptionKey: 'k'.repeat(64),
  }));
  t.after(() => {
    server.close();
    poolModule.getPool = originals.getPool;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    openrouterClient.validateKey = originals.validateKey;
    delete require.cache[routePath];
  });
  return base;
}

test('the allowance route reports what OpenRouter says is left now, and nothing secret', async (t) => {
  const calls = [];
  const base = await mount(t, {
    metadata: {
      status: 'valid',
      revision: 2,
      secret_last4: '7f2c',
      // The snapshot stored when the key was issued still says the whole
      // limit is left; the route must not answer from it.
      metadata: { source: 'usernode_managed', keyInfo: { limit: 1, limitRemaining: 1, limitReset: 'daily' } },
    },
    secret: 'sk-or-v1-child-secret',
    validateKey: async (apiKey, opts) => {
      calls.push({ apiKey, opts });
      return { label: 'usernode-user-7', limit: 1, limitRemaining: 0.86, limitReset: 'daily', usage: 0.14 };
    },
  });
  const res = await fetch(`${base}/api/me/credentials/openrouter/allowance`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body, {
    configured: true,
    source: 'usernode_managed',
    last4: '7f2c',
    limit: 1,
    limitRemaining: 0.86,
    limitReset: 'daily',
  });
  assert.equal(calls.length, 1, 'one live read per request');
  assert.equal(calls[0].apiKey, 'sk-or-v1-child-secret');
  assert.equal(calls[0].opts.baseUrl, 'https://openrouter.ai/api/v1');
  assert.doesNotMatch(JSON.stringify(body), /sk-or/, 'no key material leaves the server');
});

test('a personal key without a limit comes back with null figures rather than a guess', async (t) => {
  const base = await mount(t, {
    metadata: { status: 'valid', revision: 1, secret_last4: 'abcd', metadata: { source: 'personal' } },
    secret: 'sk-or-v1-personal',
    validateKey: async () => ({ label: 'mine', limit: null, limitRemaining: null, limitReset: null, usage: 3.2 }),
  });
  const body = await (await fetch(`${base}/api/me/credentials/openrouter/allowance`)).json();
  assert.deepEqual(body, {
    configured: true, source: 'personal', last4: 'abcd',
    limit: null, limitRemaining: null, limitReset: null,
  });
});

test('without a usable credential the route says so instead of asking OpenRouter', async (t) => {
  let asked = 0;
  const base = await mount(t, {
    metadata: { status: 'invalid', revision: 1 },
    secret: 'sk-or-v1-stale',
    validateKey: async () => { asked += 1; return {}; },
  });
  const res = await fetch(`${base}/api/me/credentials/openrouter/allowance`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { configured: false });
  assert.equal(asked, 0);
});

test('a provider failure is a 502, never a figure', async (t) => {
  const base = await mount(t, {
    metadata: { status: 'valid', revision: 1, secret_last4: '7f2c', metadata: { source: 'usernode_managed' } },
    secret: 'sk-or-v1-child-secret',
    validateKey: async () => { throw new Error('OpenRouter key check failed: fetch failed'); },
  });
  const res = await fetch(`${base}/api/me/credentials/openrouter/allowance`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /OpenRouter did not report/);
  assert.equal('limitRemaining' in body, false);
});
