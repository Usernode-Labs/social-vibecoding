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
const runtimeConfig = require('../src/config');

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

test('default-open managed provisioning does not require an identity and returns plaintext once', async (t) => {
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
  let identityQueries = 0;
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (/FROM user_social_identities/.test(text)) {
        identityQueries += 1;
        return { rows: [] };
      }
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
  agentModels.listOpenRouterModels = async () => ({ recommendedModelId: 'z-ai/glm-5.3-flash' });
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
      openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
      dataEncryptionKey: 'test-data-key',
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(identityQueries, 0, 'the default policy must not query or require an identity proof');
  assert.equal(stored.apiKey, 'sk-or-v1-issued-once');
  assert.equal(stored.metadata.source, 'usernode_managed');
  assert.equal(stored.metadata.managedKeyId, 17);
  assert.equal(defaultModel, 'z-ai/glm-5.3-flash');
  assert.equal(result.apiKey, 'sk-or-v1-issued-once');
  assert.equal(result.shownOnce, undefined, 'route, not persistence, adds the one-time response marker');
  assert.equal(result.managed.status, 'active');
  assert.equal(notificationsSent, 1);
});

test('the opt-in verification policy rejects an unverified account before provider creation', async (t) => {
  const originals = {
    withTransaction: credentialStore.withTransaction,
    createKey: managementClient.createKey,
  };
  t.after(() => {
    credentialStore.withTransaction = originals.withTransaction;
    managementClient.createKey = originals.createKey;
  });

  let createCalls = 0;
  let reservationCalls = 0;
  const client = {
    query: async (sql) => {
      const text = String(sql);
      if (/FROM user_social_identities/.test(text)) return { rows: [] };
      if (/INSERT INTO credentials\.managed_openrouter_keys/.test(text)) reservationCalls += 1;
      return { rows: [] };
    },
  };
  credentialStore.withTransaction = async (_pool, fn) => fn(client);
  managementClient.createKey = async () => { createCalls += 1; };

  await assert.rejects(
    managed.provision({
      pool: {},
      userId: 8,
      config: {
        openrouterManagementApiKey: 'sk-or-v1-management',
        openrouterManagedRequireVerifiedIdentity: true,
      },
    }),
    (err) => err instanceof managed.ManagedOpenRouterError
      && err.statusCode === 403
      && err.code === 'verification_required',
  );
  assert.equal(reservationCalls, 0, 'an ineligible user never consumes their one issuance');
  assert.equal(createCalls, 0, 'an ineligible user never reaches OpenRouter');
});

test('identity-loss review notifications follow the same opt-in policy', async (t) => {
  const originalNotify = notifications.notifyManagedOpenRouterAdmins;
  let notificationsSent = 0;
  notifications.notifyManagedOpenRouterAdmins = async () => {
    notificationsSent += 1;
    return [];
  };
  t.after(() => { notifications.notifyManagedOpenRouterAdmins = originalNotify; });

  let stateReads = 0;
  const pool = {
    query: async () => {
      stateReads += 1;
      return { rows: [{ verified: false, managed_key_id: 19, managed_status: 'active' }] };
    },
  };

  assert.equal(await managed.notifyIdentityReview({ pool, userId: 9, config: {} }), false);
  assert.equal(stateReads, 0, 'the default-open policy does not inspect identity state for review');
  assert.equal(notificationsSent, 0);

  assert.equal(await managed.notifyIdentityReview({
    pool,
    userId: 9,
    config: { openrouterManagedRequireVerifiedIdentity: true },
  }), true);
  assert.equal(stateReads, 1);
  assert.equal(notificationsSent, 1);
});

function loadManagedVerificationConfig(value) {
  const keys = [
    'DATABASE_URL', 'SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
    'USERNODE_ENV', 'OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY',
    'OPENROUTER_DEFAULT_CODEX_MODEL',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://localhost/test',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
    USERNODE_ENV: 'staging',
  });
  if (value === undefined) delete process.env.OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY;
  else process.env.OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY = value;
  delete process.env.OPENROUTER_DEFAULT_CODEX_MODEL;

  const realLog = console.log;
  console.log = () => {};
  try {
    return runtimeConfig.load();
  } finally {
    console.log = realLog;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('managed-key verification defaults off and can be enabled explicitly', () => {
  const defaults = loadManagedVerificationConfig(undefined);
  assert.equal(defaults.openrouterManagedRequireVerifiedIdentity, false);
  assert.equal(defaults.openrouterDefaultCodexModel, 'z-ai/glm-5.3-flash');
  assert.equal(loadManagedVerificationConfig('false').openrouterManagedRequireVerifiedIdentity, false);
  assert.equal(loadManagedVerificationConfig('true').openrouterManagedRequireVerifiedIdentity, true);
  assert.equal(managed.requiresVerifiedIdentity({}), false);
  assert.equal(managed.requiresVerifiedIdentity({ openrouterManagedRequireVerifiedIdentity: true }), true);
});

test('schema and surfaces pin one issuance, admin-only lifecycle, and deploy-owned management credentials', () => {
  const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/credentials.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'frontend/src/features/settings/settings.js'), 'utf8');
  const settingsSection = fs.readFileSync(path.join(root, 'frontend/src/features/settings/sections/openrouter.tsx'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
  const appManifest = require('../src/services/app-manifest');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS credentials\.managed_openrouter_keys/);
  assert.match(schema, /user_id\s+BIGINT NOT NULL UNIQUE/);
  assert.match(routes, /post\('\/api\/me\/credentials\/openrouter\/managed'/);
  assert.match(routes, /Cache-Control', 'no-store'/);
  assert.match(admin, /patch\('\/api\/admin\/openrouter-keys\/:id'/);
  assert.match(admin, /delete\('\/api\/admin\/openrouter-keys\/:id'/);
  assert.match(settingsSection, /Save this key now/);
  assert.match(settingsSection, /GLM 5\.3 Flash/);
  assert.match(settings, /GLM 5\.3 Flash/);
  assert.ok(
    settings.indexOf("{ key: 'openrouter'") < settings.indexOf("{ key: 'api-key'"),
    'OpenRouter precedes the Anthropic key in the AI settings group',
  );
  assert.match(deploy, /secrets\.USERNODE_OPENROUTER_MANAGEMENT_API_KEY/);
  assert.match(deploy, /OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY=\$\{\{ vars\.OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY \|\| 'false' \}\}/);
  assert.match(envExample, /OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY=false/);
  assert.match(deploy, /OPENROUTER_DEFAULT_CODEX_MODEL=\$\{\{ vars\.OPENROUTER_DEFAULT_CODEX_MODEL \|\| 'z-ai\/glm-5\.3-flash' \}\}/);
  assert.match(envExample, /OPENROUTER_DEFAULT_CODEX_MODEL=z-ai\/glm-5\.3-flash/);
  assert.ok(appManifest.PLATFORM_ENV_UNWRITABLE.has('OPENROUTER_MANAGEMENT_API_KEY'));
  const declaration = manifest.platform_env.find((item) => item.key === 'OPENROUTER_MANAGEMENT_API_KEY');
  assert.equal(declaration.private, true);
  const verificationDeclaration = manifest.platform_env.find(
    (item) => item.key === 'OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY',
  );
  assert.equal(verificationDeclaration.default, 'false');
  const modelDeclaration = manifest.platform_env.find(
    (item) => item.key === 'OPENROUTER_DEFAULT_CODEX_MODEL',
  );
  assert.equal(modelDeclaration.default, 'z-ai/glm-5.3-flash');
  assert.match(routes, /verificationRequired/);
  assert.match(settings, /provisioning\.verificationRequired && !provisioning\.verified/);
});

test('configured GLM 5.3 Flash is preferred without filtering the remaining model catalog', async (t) => {
  const original = require('../src/services/openrouter-client').fetchUserModels;
  require('../src/services/openrouter-client').fetchUserModels = async () => [
    { id: 'vendor/cheap', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 64000 },
    { id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.000000075', completion: '0.00000025' }, supported_parameters: ['tools'], context_length: 1310720 },
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
      openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
    },
  });
  assert.equal(catalog.recommendedModelId, 'z-ai/glm-5.3-flash');
  assert.deepEqual(catalog.models.map((model) => model.id), [
    'vendor/cheap', 'z-ai/glm-5.3-flash', 'vendor/other',
  ]);
});
