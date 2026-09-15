// Tests for the versioned app-facing app directory (issue #1908):
// GET /api/app-platform/v1/apps and its permanent unversioned alias.
//
// The route is server-to-server, app-token authenticated, and backed by the
// same loader as GET /api/public/apps. These tests pin auth, privacy SQL,
// response parity, wallet opt-out, and the legacy alias.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.USERNODE_APPS_DOMAIN = 'onhomeroom.test';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

const APP_TOKEN = 'a'.repeat(64);

const APPS = [
  {
    id: 11, name: 'Open app', slug: 'open-app', status: 'running',
    collab_visibility: 'public', view_visibility: 'public',
    created_at: '2026-09-01T00:00:00.000Z', last_deploy_at: '2026-09-10T00:00:00.000Z',
    icon_emoji: '🧭', icon_image_id: null, anon_shell: 'public', active_users: '7',
  },
  {
    id: 12, name: 'Login app', slug: 'login-app', status: 'running',
    collab_visibility: 'private', view_visibility: 'public',
    created_at: '2026-09-02T00:00:00.000Z', last_deploy_at: '2026-09-09T00:00:00.000Z',
    icon_emoji: null, icon_image_id: 'deadbeef', anon_shell: 'gated', active_users: '0',
  },
];

const CONTRIBUTORS = {
  11: [
    { app_id: 11, user_id: 4, username: 'alice', wallet_address: 'ut1alice' },
    { app_id: 11, user_id: 5, username: 'bob', wallet_address: null },
  ],
  12: [{ app_id: 12, user_id: 4, username: 'alice', wallet_address: 'ut1alice' }],
};

const calls = [];
const pool = {
  async query(sql, params = []) {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/FROM apps WHERE llm_proxy_token/.test(text)) {
      return { rows: params[0] === APP_TOKEN
        ? [{ id: 99, slug: 'calling-app', llm_proxy_token: APP_TOKEN }]
        : [] };
    }
    if (/FROM apps a/.test(text) && /last_deploy_at DESC NULLS LAST/.test(text)) {
      return { rows: APPS.map((app) => ({ ...app })) };
    }
    if (/contributor_ids/.test(text)) {
      return { rows: (params[0] || []).flatMap((id) =>
        (CONTRIBUTORS[id] || []).map((row) => ({ ...row }))) };
    }
    throw new Error(`unhandled mock SQL: ${text.slice(0, 100)}`);
  },
};

const poolModule = require('../src/db/pool');
poolModule.getPool = () => pool;

const appPlatformApiRoutes = require('../src/routes/app-platform-api');
const { publicApiRoutes } = require('../src/routes/public-api');
const { trustedProxyClientIp } = require('../src/services/client-ip');
const { productionLlmEnv } = require('../src/services/app-llm-env');

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(trustedProxyClientIp({
    hostname: 'caddy.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  app.use(publicApiRoutes({}));
  app.use(appPlatformApiRoutes({}));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());
test.beforeEach(() => { calls.length = 0; });

async function get(path, { token = APP_TOKEN, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token != null) requestHeaders['x-usernode-app-token'] = token;
  const response = await fetch(`${baseUrl}${path}`, { headers: requestHeaders });
  return { status: response.status, body: await response.json() };
}

test('production injects a pinned v1 base alongside the legacy base', async () => {
  const env = await productionLlmEnv({
    async query(sql) {
      assert.match(String(sql), /SELECT llm_proxy_token FROM apps WHERE id/);
      return { rows: [{ llm_proxy_token: APP_TOKEN }] };
    },
  }, 99);
  assert.equal(env.USERNODE_PLATFORM_API_URL, 'http://usernode:3000/api/app-platform');
  assert.equal(env.USERNODE_PLATFORM_API_V1_URL, 'http://usernode:3000/api/app-platform/v1');
  assert.equal(env.USERNODE_LLM_PROXY_TOKEN, APP_TOKEN);
});

test('v1 app directory requires a valid app token', async () => {
  const missing = await get('/api/app-platform/v1/apps', { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'missing_app_token');

  const unknown = await get('/api/app-platform/v1/apps', { token: 'f'.repeat(64) });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.code, 'bad_app_token');
});

test('v1 app directory rejects a caller outside the private app network', async () => {
  const result = await get('/api/app-platform/v1/apps', {
    headers: { 'x-forwarded-for': '8.8.8.8' },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'forbidden_ip');
});

test('v1, legacy, and public routes return the same directory projection', async () => {
  const [versioned, legacy, publicResult] = await Promise.all([
    get('/api/app-platform/v1/apps'),
    get('/api/app-platform/apps'),
    get('/api/public/apps', { token: null }),
  ]);

  assert.equal(versioned.status, 200);
  assert.deepEqual(legacy.body, versioned.body);
  assert.deepEqual(publicResult.body, versioned.body);

  const open = versioned.body.apps.find((app) => app.slug === 'open-app');
  assert.equal(open.url, 'https://open-app.onhomeroom.test');
  assert.equal(open.active_users, 7);
  assert.equal(open.requires_login, false);
  assert.deepEqual(open.contributors.map((user) => user.username), ['alice', 'bob']);

  const listCall = calls.find((call) => /FROM apps a/.test(call.sql));
  assert.ok(listCall, 'the public-app query ran');
  assert.match(listCall.sql, /WHERE NOT a\.self_hosted/);
  assert.match(listCall.sql, /a\.view_visibility = 'public'/);
  assert.match(listCall.sql, /a\.status <> ALL/);
  assert.deepEqual(listCall.params[0], ['error', 'creating', 'awaiting_secrets']);
});

test('include_wallets=0 removes wallet addresses from every contributor', async () => {
  const result = await get('/api/app-platform/v1/apps?include_wallets=0');
  assert.equal(result.status, 200);
  for (const app of result.body.apps) {
    for (const contributor of app.contributors) {
      assert.equal('wallet_address' in contributor, false);
    }
  }
});
