'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const managementClient = require('../src/services/openrouter-management-client');
const managed = require('../src/services/openrouter-managed-keys');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');
const notifications = require('../src/services/notifications');

const root = path.join(__dirname, '..');

test('management client creates one daily-limited child key in the configured workspace', async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      key: 'sk-or-v1-child-secret',
      data: {
        hash: '0123456789abcdef0123456789abcdef',
        label: 'usernode-user-7',
        limit: 1.5,
        limit_remaining: 1.5,
        limit_reset: 'daily',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await managementClient.createKey({
    apiKey: 'sk-or-v1-management',
    baseUrl: 'https://openrouter.ai/api/v1',
    origin: 'https://usernode.dev',
    name: 'usernode-user-7',
    limit: 1.5,
    workspaceId: 'workspace-123',
  });

  assert.equal(request.url, 'https://openrouter.ai/api/v1/keys');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer sk-or-v1-management');
  assert.deepEqual(JSON.parse(request.options.body), {
    name: 'usernode-user-7',
    limit: 1.5,
    limit_reset: 'daily',
    workspace_id: 'workspace-123',
  });
  assert.equal(result.key, 'sk-or-v1-child-secret');
  assert.equal(result.hash, '0123456789abcdef0123456789abcdef');
});

test('an ambiguous create failure is surfaced after exactly one attempt', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('connection reset after upload');
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    managementClient.createKey({
      apiKey: 'sk-or-v1-management',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'usernode-user-7',
      limit: 1,
    }),
    (err) => err instanceof managementClient.OpenRouterManagementError
      && err.ambiguous === true,
  );
  assert.equal(calls, 1, 'POST /keys must never be blindly retried');
});

test('successful managed provisioning reserves once, stores encrypted credential metadata, and returns plaintext once', async (t) => {
  const originals = {
    withTransaction: credentialStore.withTransaction,
    readMetadata: credentialStore.readMetadata,
    write: credentialStore.writeOpenRouterCodingAgentOnClient,
    createKey: managementClient.createKey,
    listModels: agentModels.listOpenRouterModels,
    notify: notifications.notifyManagedOpenRouterAdmins,
  };
  t.after(() => {
    credentialStore.withTransaction = originals.withTransaction;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.writeOpenRouterCodingAgentOnClient = originals.write;
    managementClient.createKey = originals.createKey;
    agentModels.listOpenRouterModels = originals.listModels;
    notifications.notifyManagedOpenRouterAdmins = originals.notify;
  });

  let createCalls = 0;
  let stored;
  let defaultModel;
  let notificationsSent = 0;
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (/FROM user_social_identities/.test(text)) return { rows: [{ id: 4 }] };
      if (/INSERT INTO credentials\.managed_openrouter_keys/.test(text)) return { rows: [{ id: 17 }] };
      if (/SELECT id FROM credentials\.managed_openrouter_keys/.test(text)) return { rows: [{ id: 17 }] };
      if (/INSERT INTO user_agent_preferences/.test(text)) defaultModel = params[2];
      return { rows: [] };
    },
  };
  credentialStore.withTransaction = async (_pool, fn) => fn(client);
  credentialStore.readMetadata = async () => null;
  credentialStore.writeOpenRouterCodingAgentOnClient = async (args) => {
    stored = args;
    return { id: 91, revision: 1 };
  };
  managementClient.createKey = async () => {
    createCalls += 1;
    return {
      key: 'sk-or-v1-issued-once',
      hash: 'abcdef0123456789abcdef0123456789',
      label: 'usernode-user-7',
      limit: 1,
      limitRemaining: 1,
      limitReset: 'daily',
    };
  };
  agentModels.listOpenRouterModels = async () => ({ recommendedModelId: 'z-ai/glm-5.3' });
  notifications.notifyManagedOpenRouterAdmins = async () => { notificationsSent += 1; return []; };
  const pool = {
    query: async (sql) => ({
      rows: /RETURNING id/.test(String(sql)) ? [{ id: 17 }] : [],
    }),
  };

  const result = await managed.provision({
    pool,
    userId: 7,
    config: {
      openrouterManagementApiKey: 'sk-or-v1-management',
      openrouterApiBase: 'https://openrouter.ai/api/v1',
      openrouterOrigin: 'https://usernode.dev',
      openrouterManagedDailyLimitUsd: 1,
      openrouterManagedWorkspaceId: 'workspace-123',
      openrouterDefaultCodexModel: 'z-ai/glm-5.3',
      dataEncryptionKey: 'test-data-key',
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(stored.apiKey, 'sk-or-v1-issued-once');
  assert.equal(stored.metadata.source, 'usernode_managed');
  assert.equal(stored.metadata.managedKeyId, 17);
  assert.equal(defaultModel, 'z-ai/glm-5.3');
  assert.equal(result.apiKey, 'sk-or-v1-issued-once');
  assert.equal(result.shownOnce, undefined, 'route, not persistence, adds the one-time response marker');
  assert.equal(result.managed.status, 'active');
  assert.equal(notificationsSent, 1);
});

test('schema and surfaces pin one issuance, admin-only lifecycle, and deploy-owned management credentials', () => {
  const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/credentials.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'frontend/src/features/settings/settings.js'), 'utf8');
  const settingsSection = fs.readFileSync(path.join(root, 'frontend/src/features/settings/sections/openrouter.tsx'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
  const appManifest = require('../src/services/app-manifest');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS credentials\.managed_openrouter_keys/);
  assert.match(schema, /user_id\s+BIGINT NOT NULL UNIQUE/);
  assert.match(routes, /post\('\/api\/me\/credentials\/openrouter\/managed'/);
  assert.match(routes, /Cache-Control', 'no-store'/);
  assert.match(admin, /patch\('\/api\/admin\/openrouter-keys\/:id'/);
  assert.match(admin, /delete\('\/api\/admin\/openrouter-keys\/:id'/);
  assert.match(settingsSection, /Save this key now/);
  assert.ok(
    settings.indexOf("{ key: 'openrouter'") < settings.indexOf("{ key: 'api-key'"),
    'OpenRouter precedes the Anthropic key in the AI settings group',
  );
  assert.match(deploy, /secrets\.USERNODE_OPENROUTER_MANAGEMENT_API_KEY/);
  assert.ok(appManifest.PLATFORM_ENV_UNWRITABLE.has('OPENROUTER_MANAGEMENT_API_KEY'));
  const declaration = manifest.platform_env.find((item) => item.key === 'OPENROUTER_MANAGEMENT_API_KEY');
  assert.equal(declaration.private, true);
});

test('configured GLM is preferred without filtering the remaining model catalog', async (t) => {
  const original = require('../src/services/openrouter-client').fetchUserModels;
  require('../src/services/openrouter-client').fetchUserModels = async () => [
    { id: 'vendor/cheap', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 64000 },
    { id: 'z-ai/glm-5.3', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'], context_length: 64000 },
    { id: 'vendor/other', pricing: { prompt: '0.000003', completion: '0.000004' }, supported_parameters: ['tools'], context_length: 64000 },
  ];
  t.after(() => {
    require('../src/services/openrouter-client').fetchUserModels = original;
    agentModels.invalidateAll();
  });
  agentModels.invalidateAll();
  const catalog = await agentModels.listOpenRouterModels({
    pool: { query: async () => ({ rows: [] }) },
    userId: 'managed-default-test', credentialRevision: 1,
    apiKey: 'sk-or-v1-test',
    config: {
      openrouterApiBase: 'https://openrouter.ai/api/v1',
      openrouterOrigin: 'https://usernode.dev',
      openrouterDefaultCodexModel: 'z-ai/glm-5.3',
    },
  });
  assert.equal(catalog.recommendedModelId, 'z-ai/glm-5.3');
  assert.deepEqual(catalog.models.map((model) => model.id), [
    'vendor/cheap', 'z-ai/glm-5.3', 'vendor/other',
  ]);
});
