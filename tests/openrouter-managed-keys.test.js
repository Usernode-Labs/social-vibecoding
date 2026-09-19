'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const managementClient = require('../src/services/openrouter-management-client');
const managed = require('../src/services/openrouter-managed-keys');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');
const notifications = require('../src/services/notifications');
const limits = require('../src/services/limits');
const runtimeConfig = require('../src/config');

const root = path.join(__dirname, '..');

// The included key's limit is the platform weekly allowance. Stub the two
// limits reads resolveAllowance makes, shaped the way the Claude gate sees
// them, and restore the real functions (captured once, so stacked stubs in
// one test cannot leak a stub past it).
const REAL_LIMITS = {
  weekly: limits.getEffectiveUserWeeklyLimitCents,
  entitlement: limits.getUserCreditEntitlement,
};
function stubAllowance(t, { weeklyCents = 17500, dailyCents = 2500, dailySource = 'default' } = {}) {
  t.after(() => {
    limits.getEffectiveUserWeeklyLimitCents = REAL_LIMITS.weekly;
    limits.getUserCreditEntitlement = REAL_LIMITS.entitlement;
  });
  const reads = [];
  limits.getEffectiveUserWeeklyLimitCents = async (_pool, userId) => { reads.push(userId); return weeklyCents; };
  // #2568: resolveAllowance no longer reads the entitlement at all — the
  // identity gate it used for is gone. The stub stays so a regression that
  // reintroduces the read is visible as an unexpected call rather than a
  // crash.
  limits.getUserCreditEntitlement = async () => ({
    limitCents: dailyCents, source: dailySource,
    weeklyLimitCents: weeklyCents, weeklySource: 'default',
  });
  return reads;
}

test('management client creates one weekly-limited child key in the configured workspace', async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      key: 'sk-or-v1-child-secret',
      data: {
        hash: '0123456789abcdef0123456789abcdef',
        label: 'usernode-user-7',
        limit: 10.5,
        limit_remaining: 10.5,
        limit_reset: 'weekly',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await managementClient.createKey({
    apiKey: 'sk-or-v1-management',
    baseUrl: 'https://openrouter.ai/api/v1',
    origin: 'https://usernode.dev',
    name: 'usernode-user-7',
    limit: 10.5,
    limitReset: 'weekly',
    workspaceId: 'workspace-123',
  });

  assert.equal(request.url, 'https://openrouter.ai/api/v1/keys');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer sk-or-v1-management');
  assert.deepEqual(JSON.parse(request.options.body), {
    name: 'usernode-user-7',
    limit: 10.5,
    limit_reset: 'weekly',
    workspace_id: 'workspace-123',
  });
  assert.equal(result.key, 'sk-or-v1-child-secret');
  assert.equal(result.hash, '0123456789abcdef0123456789abcdef');
  assert.equal(result.limitReset, 'weekly');
});

test('management client moves an issued key to a new allowance with one idempotent PATCH', async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      data: {
        hash: '0123456789abcdef0123456789abcdef',
        limit: 7,
        limit_remaining: 6.25,
        limit_reset: 'weekly',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await managementClient.setLimit({
    apiKey: 'sk-or-v1-management',
    baseUrl: 'https://openrouter.ai/api/v1',
    origin: 'https://usernode.dev',
    hash: '0123456789abcdef0123456789abcdef',
    limit: 7,
    limitReset: 'weekly',
  });

  assert.equal(request.url, 'https://openrouter.ai/api/v1/keys/0123456789abcdef0123456789abcdef');
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), { limit: 7, limit_reset: 'weekly' });
  assert.deepEqual(result, { limit: 7, limitRemaining: 6.25, limitReset: 'weekly' });
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

test('default-open managed provisioning stores the key internally and returns only safe metadata', async (t) => {
  const originals = {
    withTransaction: credentialStore.withTransaction,
    readMetadata: credentialStore.readMetadata,
    write: credentialStore.writeOpenRouterCodingAgentOnClient,
    createKey: managementClient.createKey,
    listModels: agentModels.listOpenRouterModels,
    notify: notifications.notifyManagedOpenRouterReviewAdmins,
  };
  t.after(() => {
    credentialStore.withTransaction = originals.withTransaction;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.writeOpenRouterCodingAgentOnClient = originals.write;
    managementClient.createKey = originals.createKey;
    agentModels.listOpenRouterModels = originals.listModels;
    notifications.notifyManagedOpenRouterReviewAdmins = originals.notify;
  });
  const allowanceReads = stubAllowance(t, { weeklyCents: 17500 });

  let createCalls = 0;
  let createArgs;
  let reservation;
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
      if (/INSERT INTO credentials\.managed_openrouter_keys/.test(text)) {
        reservation = params;
        return { rows: [{ id: 17 }] };
      }
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
  managementClient.createKey = async (args) => {
    createCalls += 1;
    createArgs = args;
    return {
      key: 'sk-or-v1-issued-once',
      hash: 'abcdef0123456789abcdef0123456789',
      label: 'usernode-user-7',
      limit: 175,
      limitRemaining: 175,
      limitReset: 'weekly',
    };
  };
  agentModels.listOpenRouterModels = async () => ({ recommendedModelId: 'z-ai/glm-5.3-flash' });
  notifications.notifyManagedOpenRouterReviewAdmins = async () => {
    notificationsSent += 1;
    return [];
  };
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
      openrouterManagedWorkspaceId: 'workspace-123',
      openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
      dataEncryptionKey: 'test-data-key',
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(identityQueries, 0, 'the default policy must not query or require an identity proof');
  assert.deepEqual(allowanceReads, [7], 'the allowance is resolved for the claimant');
  assert.deepEqual(reservation.slice(2), [175, 'weekly'],
    'the reservation records the platform weekly allowance it is about to request');
  assert.equal(createArgs.limit, 175);
  assert.equal(createArgs.limitReset, 'weekly');
  assert.equal(stored.metadata.keyInfo.limitReset, 'weekly');
  assert.equal(result.keyInfo.limitReset, 'weekly');
  assert.equal(stored.apiKey, 'sk-or-v1-issued-once');
  assert.equal(stored.metadata.source, 'usernode_managed');
  assert.equal(stored.metadata.managedKeyId, 17);
  assert.equal(defaultModel, 'z-ai/glm-5.3-flash');
  assert.equal(result.apiKey, undefined, 'the provisioning result must not expose the credential');
  assert.equal(result.last4, undefined, 'the claim response does not need credential-shaped data');
  assert.equal(JSON.stringify(result).includes('sk-or-v1-issued-once'), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'defaultModel', 'keyInfo', 'managed', 'revision',
  ]);
  assert.equal(result.managed.status, 'active');
  assert.equal(notificationsSent, 0,
    'successful issuance is an admin record, not an actionable notification');
});

test('an account whose platform weekly allowance is zero gets no company key', async (t) => {
  const originals = {
    withTransaction: credentialStore.withTransaction,
    createKey: managementClient.createKey,
  };
  t.after(() => {
    credentialStore.withTransaction = originals.withTransaction;
    managementClient.createKey = originals.createKey;
  });
  let reservations = 0;
  let createCalls = 0;
  credentialStore.withTransaction = async () => { reservations += 1; };
  managementClient.createKey = async () => { createCalls += 1; };
  const config = { openrouterManagementApiKey: 'sk-or-v1-management' };
  const refused = (pattern) => (err) => err instanceof managed.ManagedOpenRouterError
    && err.statusCode === 403 && err.code === 'no_allowance' && pattern.test(err.message);

  // An admin switched the weekly cap off. This is the ONLY reason left for
  // a zero: #2568 removed the identity gate, so an unverified account is no
  // longer refused a key.
  stubAllowance(t, { weeklyCents: 0 });
  await assert.rejects(managed.provision({ pool: {}, userId: 21, config }),
    refused(/no included weekly allowance/));
  assert.deepEqual(await managed.resolveAllowance({}, 21),
    { cents: 0, limitUsd: 0, limitReset: 'weekly' });

  // An identity-derived zero on the DAILY axis is not a gate any more: the
  // account's weekly allowance is what the key carries.
  stubAllowance(t, { weeklyCents: 17500, dailyCents: 0, dailySource: 'identity' });
  assert.deepEqual(await managed.resolveAllowance({}, 22),
    { cents: 17500, limitUsd: 175, limitReset: 'weekly' });

  // An admin-set daily 0 is a weekly-only account, not a gate — which is
  // now every account, since #2571 switched the daily cap off platform-wide.
  stubAllowance(t, { weeklyCents: 5000, dailyCents: 0, dailySource: 'admin_override' });
  assert.deepEqual(await managed.resolveAllowance({}, 23),
    { cents: 5000, limitUsd: 50, limitReset: 'weekly' });

  assert.equal(reservations, 0, 'a refused claim never consumes the one lifetime issuance');
  assert.equal(createCalls, 0, 'a refused claim never reaches OpenRouter');
});

// ── #2568: the included key is created WITH the account ─────────────────
//
// ensureIncludedKey is the one entry point every account-creation path and
// the lazy new-change read share. What matters is that it is idempotent and
// that it never throws: signing up must not fail because a third-party key
// could not be minted.

test('ensureIncludedKey is idempotent and never throws', async (t) => {
  const originalProvision = managed.provision;
  t.after(() => { managed.provision = originalProvision; });
  const config = {
    openrouterManagementApiKey: 'sk-or-v1-management',
    codexOpenrouterEnabled: true,
  };

  // An account that already holds a valid credential never reaches the
  // provider at all.
  const validPool = {
    query: async () => ({ rows: [{ id: 1, status: 'valid', revision: 3 }] }),
  };
  assert.deepEqual(
    await managed.ensureIncludedKey({ pool: validPool, userId: 5, config }),
    { created: false, skipped: 'already_configured' },
  );

  // A deployment with no management key, and one with the backend switched
  // off, are named skips rather than failures.
  const emptyPool = { query: async () => ({ rows: [] }) };
  assert.deepEqual(
    await managed.ensureIncludedKey({ pool: emptyPool, userId: 5, config: {} }),
    { created: false, skipped: 'not_configured' },
  );
  assert.deepEqual(
    await managed.ensureIncludedKey({
      pool: emptyPool, userId: 5,
      config: { ...config, codexOpenrouterEnabled: false },
    }),
    { created: false, skipped: 'backend_disabled' },
  );

  // A provider failure is swallowed: the caller's own success stands, and
  // the next lazy call tries again.
  const boom = new managed.ManagedOpenRouterError(502, 'provisioning_needs_review', 'nope');
  const failing = {
    query: async (sql) => {
      if (/user_ai_credentials/.test(String(sql))) return { rows: [] };
      throw boom;
    },
  };
  const result = await managed.ensureIncludedKey({ pool: failing, userId: 6, config });
  assert.equal(result.created, false);
  assert.ok(result.skipped, 'a failure is a named skip, never a throw');

  // And a credential read that itself fails is a skip too.
  const unreadable = { query: async () => { throw new Error('db down'); } };
  assert.deepEqual(
    await managed.ensureIncludedKey({ pool: unreadable, userId: 7, config }),
    { created: false, skipped: 'precheck_failed' },
  );
});

test('every account-creation path creates the included key, and the read is the safety net', () => {
  const authSource = fs.readFileSync(path.join(root, 'src/routes/auth.js'), 'utf8');
  const credentialsSource = fs.readFileSync(path.join(root, 'src/routes/credentials.js'), 'utf8');
  const adminUsersSource = fs.readFileSync(
    path.join(root, 'src/routes/topochain/admin/users.js'), 'utf8',
  );
  for (const reason of ['signup_email', 'signup_activation_code', 'signup_wallet']) {
    assert.match(authSource, new RegExp(`ensureIncludedKey\\([\\s\\S]{0,200}?reason: '${reason}'`),
      `the ${reason} path creates the included key`);
  }
  assert.match(adminUsersSource, /ensureIncludedKey\([\s\S]{0,200}?reason: 'admin_created'/);
  assert.match(credentialsSource, /ensureIncludedKey\([\s\S]{0,200}?reason: 'coding_agent_read'/,
    'and the new-change screen\'s preference read retries for anyone without one');
  // The gates this issue removed must not come back by another name.
  assert.doesNotMatch(credentialsSource, /betaAllowed/);
  assert.doesNotMatch(authSource, /openrouterBetaUserIds/);
});

test('a key whose limit differs from the platform weekly allowance is re-limited on the next status read', async (t) => {
  const originals = {
    withTransaction: credentialStore.withTransaction,
    mergeKeyInfo: credentialStore.mergeKeyInfoOnClient,
    setLimit: managementClient.setLimit,
  };
  t.after(() => {
    credentialStore.withTransaction = originals.withTransaction;
    credentialStore.mergeKeyInfoOnClient = originals.mergeKeyInfo;
    managementClient.setLimit = originals.setLimit;
  });

  const patches = [];
  const updates = [];
  const merges = [];
  managementClient.setLimit = async (args) => {
    patches.push(args);
    return { limit: args.limit, limitRemaining: args.limit - 0.75, limitReset: 'weekly' };
  };
  const client = {
    query: async (sql, params) => {
      if (/UPDATE credentials\.managed_openrouter_keys/.test(String(sql))) updates.push(params);
      return { rows: [] };
    },
  };
  credentialStore.withTransaction = async (_pool, fn) => fn(client);
  credentialStore.mergeKeyInfoOnClient = async (args) => { merges.push(args); return true; };
  const config = {
    openrouterManagementApiKey: 'sk-or-v1-management',
    openrouterApiBase: 'https://openrouter.ai/api/v1',
    openrouterOrigin: 'https://usernode.dev',
  };
  const weekly = (cents) => ({ cents, limitUsd: cents / 100, limitReset: 'weekly', identityGated: false });
  const legacy = {
    verified: true, managed_key_id: 2119, managed_status: 'active',
    remote_key_hash: 'abcdef0123456789abcdef0123456789',
    daily_limit_usd: '1.00000000', limit_reset: 'daily',
  };

  // A key issued before the weekly policy, resolved through the limits reads.
  const reads = stubAllowance(t, { weeklyCents: 17500 });
  const synced = await managed.syncAllowance({ pool: {}, userId: 7, state: legacy, config });
  assert.deepEqual(reads, [7]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].apiKey, 'sk-or-v1-management');
  assert.equal(patches[0].hash, legacy.remote_key_hash);
  assert.equal(patches[0].limit, 175);
  assert.equal(patches[0].limitReset, 'weekly');
  assert.deepEqual(updates, [[2119, 175, 'weekly']]);
  assert.equal(merges[0].userId, 7);
  assert.equal(merges[0].provider, 'openrouter');
  assert.equal(merges[0].purpose, 'coding_agent');
  assert.deepEqual(merges[0].keyInfo, { limit: 175, limitReset: 'weekly', limitRemaining: 174.25 });
  assert.equal(synced.limit_reset, 'weekly');
  assert.equal(synced.daily_limit_usd, 175);
  const shown = managed.publicState(synced);
  assert.equal(shown.limitUsd, 175);
  assert.equal(shown.limitReset, 'weekly');
  assert.equal('dailyLimitUsd' in shown, false, 'the public field no longer claims a cadence');

  // Equal: nothing to do, the provider is not asked.
  const current = { ...synced, daily_limit_usd: '175.00000000' };
  assert.equal(await managed.syncAllowance({
    pool: {}, userId: 7, state: current, config, allowance: weekly(17500),
  }), current);
  assert.equal(patches.length, 1);

  // An admin changed this user's weekly cap: the key follows.
  const lowered = await managed.syncAllowance({
    pool: {}, userId: 7, state: current, config, allowance: weekly(5000),
  });
  assert.equal(patches.length, 2);
  assert.equal(patches[1].limit, 50);
  assert.deepEqual(updates[1], [2119, 50, 'weekly']);
  assert.equal(lowered.daily_limit_usd, 50);

  // A zero allowance is never written to an issued key.
  assert.equal(await managed.syncAllowance({
    pool: {}, userId: 7, state: lowered, config, allowance: weekly(0),
  }), lowered);
  assert.equal(patches.length, 2);

  // Nothing that can be synced: no confirmed hash, deleted, unconfigured, no row.
  const unconfirmed = { ...legacy, managed_key_id: 2120, remote_key_hash: null };
  assert.equal(await managed.syncAllowance({
    pool: {}, userId: 8, state: unconfirmed, config, allowance: weekly(17500),
  }), unconfirmed);
  const deleted = { ...legacy, managed_key_id: 2121, managed_status: 'deleted' };
  assert.equal(await managed.syncAllowance({
    pool: {}, userId: 9, state: deleted, config, allowance: weekly(17500),
  }), deleted);
  const unmanaged = { ...legacy, managed_key_id: 2122 };
  assert.equal(await managed.syncAllowance({
    pool: {}, userId: 10, state: unmanaged, allowance: weekly(17500),
    config: { ...config, openrouterManagementApiKey: '' },
  }), unmanaged);
  const none = { verified: false };
  assert.equal(await managed.syncAllowance({
    pool: {}, userId: 11, state: none, config, allowance: weekly(17500),
  }), none);
  assert.equal(patches.length, 2);
  assert.equal(reads.length, 1, 'a caller that already resolved the allowance is not made to resolve it again');
});

test('a failed allowance sync keeps the key truthful and is not retried for the same target in this process', async (t) => {
  const originals = {
    withTransaction: credentialStore.withTransaction,
    setLimit: managementClient.setLimit,
  };
  t.after(() => {
    credentialStore.withTransaction = originals.withTransaction;
    managementClient.setLimit = originals.setLimit;
  });

  const attempts = [];
  let writes = 0;
  managementClient.setLimit = async (args) => { attempts.push(args.limit); throw new Error('HTTP 502'); };
  credentialStore.withTransaction = async () => { writes += 1; };
  const config = {
    openrouterManagementApiKey: 'sk-or-v1-management',
    openrouterApiBase: 'https://openrouter.ai/api/v1',
  };
  const weekly = (cents) => ({ cents, limitUsd: cents / 100, limitReset: 'weekly', identityGated: false });
  const legacy = {
    managed_key_id: 2123, managed_status: 'disabled',
    remote_key_hash: 'fedcba9876543210fedcba9876543210',
    daily_limit_usd: '1.00000000', limit_reset: 'daily',
  };

  const first = await managed.syncAllowance({
    pool: {}, userId: 12, state: legacy, config, allowance: weekly(17500),
  });
  assert.equal(first, legacy, 'the status read still succeeds with the stored state');
  assert.deepEqual(attempts, [175]);
  assert.equal(writes, 0, 'nothing is recorded locally that OpenRouter did not confirm');
  const second = await managed.syncAllowance({
    pool: {}, userId: 12, state: legacy, config, allowance: weekly(17500),
  });
  assert.equal(second, legacy);
  assert.deepEqual(attempts, [175], 'a later status read never waits on a provider call that just failed');
  // A different target value (an admin changed the cap) is a new attempt.
  await managed.syncAllowance({ pool: {}, userId: 12, state: legacy, config, allowance: weekly(5000) });
  assert.deepEqual(attempts, [175, 50]);
});

// #2568 retired OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY and
// CODEX_OPENROUTER_BETA_USER_IDS. `value` is still passed so the cases below
// can prove the retired variable is INERT: setting it changes nothing.
function loadManagedVerificationConfig(value, recommendedModels, allowance = {}) {
  const keys = [
    'DATABASE_URL', 'SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
    'USERNODE_ENV', 'OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY',
    'CODEX_OPENROUTER_BETA_USER_IDS',
    'OPENROUTER_DEFAULT_CODEX_MODEL', 'OPENROUTER_RECOMMENDED_MODELS',
    'OPENROUTER_MANAGED_WEEKLY_LIMIT_USD', 'OPENROUTER_MANAGED_DAILY_LIMIT_USD',
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
  delete process.env.CODEX_OPENROUTER_BETA_USER_IDS;
  delete process.env.OPENROUTER_DEFAULT_CODEX_MODEL;
  if (recommendedModels === undefined) delete process.env.OPENROUTER_RECOMMENDED_MODELS;
  else process.env.OPENROUTER_RECOMMENDED_MODELS = recommendedModels;
  if (allowance.weekly === undefined) delete process.env.OPENROUTER_MANAGED_WEEKLY_LIMIT_USD;
  else process.env.OPENROUTER_MANAGED_WEEKLY_LIMIT_USD = allowance.weekly;
  if (allowance.daily === undefined) delete process.env.OPENROUTER_MANAGED_DAILY_LIMIT_USD;
  else process.env.OPENROUTER_MANAGED_DAILY_LIMIT_USD = allowance.daily;

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

test('the retired eligibility gates are gone from config, and setting them changes nothing', () => {
  const defaults = loadManagedVerificationConfig(undefined);
  // #2568: neither gate survives. The deploy workflow still writes the
  // verified-identity variable, exactly as it still writes the old daily
  // limit — inert either way.
  assert.equal('openrouterManagedRequireVerifiedIdentity' in defaults, false);
  assert.equal('openrouterBetaUserIds' in defaults, false);
  for (const value of ['true', 'false']) {
    const loaded = loadManagedVerificationConfig(value);
    assert.equal('openrouterManagedRequireVerifiedIdentity' in loaded, false,
      'the retired variable is read by nothing, so it cannot change the config');
    assert.equal('openrouterBetaUserIds' in loaded, false);
  }
  const configSource = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  assert.doesNotMatch(configSource, /process\.env\.CODEX_OPENROUTER_BETA_USER_IDS/);
  assert.doesNotMatch(configSource, /process\.env\.OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY/);
  assert.equal(defaults.openrouterDefaultCodexModel, 'z-ai/glm-5.3-flash');
  assert.deepEqual(defaults.openrouterRecommendedModels, [
    'deepseek/deepseek-v4.1-flash',
    'z-ai/glm-5.3-flash',
    'openai/gpt-6-astra',
    'moonshotai/kimi-k3',
    'anthropic/claude-opus-5',
  ]);
  assert.deepEqual(loadManagedVerificationConfig(undefined, 'none').openrouterRecommendedModels, []);
  assert.deepEqual(
    loadManagedVerificationConfig(undefined, ' vendor/one, vendor/two ').openrouterRecommendedModels,
    ['vendor/one', 'vendor/two'],
  );
  assert.equal(managed.requiresVerifiedIdentity, undefined,
    'the service exposes no verified-identity gate any more');
});

test('the managed allowance is not a config value: it is the platform weekly allowance', () => {
  const load = (allowance) => loadManagedVerificationConfig(undefined, undefined, allowance);
  for (const config of [load({}), load({ daily: '1' }), load({ daily: 'not-a-number', weekly: '5' })]) {
    assert.equal('openrouterManagedWeeklyLimitUsd' in config, false);
    assert.equal('openrouterManagedDailyLimitUsd' in config, false);
  }
  const source = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  assert.doesNotMatch(source, /process\.env\.OPENROUTER_MANAGED_(?:DAILY|WEEKLY)_LIMIT_USD/,
    'the deploy still writes the old daily variable; nothing reads it');
  assert.equal(managed.LIMIT_RESET, 'weekly');
});

// Evaluate settings.js the way tests/settings-mobile-push.test.js does, with
// just enough DOM for _refreshOpenRouter to paint the OpenRouter section.
function settingsHarness(credentialStatus) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        id, textContent: '', placeholder: '', value: '', disabled: false,
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          toggle: (name, force) => {
            const on = force === undefined ? !classes.has(name) : !!force;
            if (on) classes.add(name); else classes.delete(name);
            return on;
          },
          contains: (name) => classes.has(name),
        },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    window: {},
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      // No model select, so _loadOpenRouterModels returns before it fetches.
      getElementById: (id) => (id === 'settings-openrouter-model' ? null : el(id)),
    },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).startsWith('/api/me/coding-agent')
        ? { codexAvailable: true }
        : credentialStatus),
    }),
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/src/features/settings/settings.js'), 'utf8'), context);
  return { Settings: context.window.Settings, el };
}

test('the settings screen states the included key rather than offering to create one', async () => {
  const issued = (limitReset, limit, limitRemaining) => ({
    configured: true, status: 'valid', last4: 'ab12', revision: 1, source: 'usernode_managed',
    keyInfo: { label: 'usernode-user-7', limit, limitRemaining, limitReset },
    managed: { id: 17, status: 'active', label: 'usernode-user-7', limitUsd: limit, limitReset },
    managedProvisioning: {
      available: true, alreadyIssued: true,
      canClaim: false, limitUsd: 175, limitReset: 'weekly', reason: 'already_issued',
    },
  });

  const weekly = settingsHarness(issued('weekly', 175, 174.25));
  await weekly.Settings._refreshOpenRouter();
  assert.equal(weekly.el('settings-openrouter-key-info').textContent,
    'Homeroom-managed · Weekly limit: $175 · Remaining: $174.25');
  // #2568: a status line. It names the key, its last four and the allowance
  // it carries — and there is no button beside it, because the key was
  // created with the account.
  assert.match(weekly.el('settings-openrouter-included-status').textContent,
    /^Active \(sk-or-…ab12\)\. It carries the platform's \$175\.00 weekly allowance, and you may choose any available model\.$/);
  assert.equal(weekly.el('settings-openrouter-included').classList.contains('hidden'), false);

  // A key issued before the weekly policy and not yet re-limited reads truthfully.
  const legacy = settingsHarness(issued('daily', 1, 1));
  await legacy.Settings._refreshOpenRouter();
  assert.equal(legacy.el('settings-openrouter-key-info').textContent,
    'Homeroom-managed · Daily limit: $1 · Remaining: $1');
  assert.match(legacy.el('settings-openrouter-included-status').textContent,
    /carries a \$1\.00 daily limit until it is moved to the platform's weekly allowance/);

  const provisioning = (extra) => ({
    available: true, alreadyIssued: false,
    canClaim: false, limitUsd: 175, limitReset: 'weekly', reason: null, ...extra,
  });
  const unissued = (managedProvisioning) => ({
    configured: false, status: null, last4: null, keyInfo: null, source: null, managed: null,
    managedProvisioning,
  });

  // An account whose key has not landed yet is told it is on its way, not
  // asked to press anything.
  const pending = settingsHarness(unissued(provisioning({ canClaim: true })));
  await pending.Settings._refreshOpenRouter();
  assert.equal(pending.el('settings-openrouter-included-status').textContent,
    "Your included key is being set up. It carries the platform's $175.00 weekly allowance; reopen this screen in a moment.");

  // No allowance: there is no included key, and the personal one is the way on.
  const nothing = settingsHarness(unissued(provisioning({ limitUsd: 0, reason: 'no_allowance' })));
  await nothing.Settings._refreshOpenRouter();
  assert.equal(nothing.el('settings-openrouter-included-status').textContent,
    'Your account has no included weekly allowance right now, so there is no included key. You can add a personal OpenRouter key below.');

  // A personal key's cadence is whatever OpenRouter reports, which may be none.
  const personal = settingsHarness({
    configured: true, status: 'valid', last4: 'zz99', source: 'personal', managed: null,
    keyInfo: { label: 'my key', limit: 10, limitRemaining: 4, limitReset: null },
    managedProvisioning: provisioning({ reason: 'personal_key_configured' }),
  });
  await personal.Settings._refreshOpenRouter();
  assert.equal(personal.el('settings-openrouter-key-info').textContent,
    'Personal key · Limit: $10 · Remaining: $4');
  assert.equal(personal.el('settings-openrouter-included-status').textContent,
    'You are using your own OpenRouter key. Remove it to fall back to the included one.');
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
  assert.match(schema, /CREATE TABLE IF NOT EXISTS user_agent_model_favorites/);
  assert.match(schema, /user_id\s+BIGINT NOT NULL UNIQUE/);
  assert.match(routes, /post\('\/api\/me\/credentials\/openrouter\/managed'/);
  assert.match(routes, /patch\('\/api\/me\/coding-agent\/models\/favorite'/);
  assert.match(routes, /Cache-Control', 'no-store'/);
  assert.match(admin, /patch\('\/api\/admin\/openrouter-keys\/:id'/);
  assert.match(admin, /delete\('\/api\/admin\/openrouter-keys\/:id'/);
  assert.doesNotMatch(routes, /\.\.\.claimed|shownOnce/);
  assert.doesNotMatch(settingsSection, /settings-openrouter-(?:reveal|revealed-key|copy|dismiss-reveal)/);
  assert.doesNotMatch(settingsSection, /Save this key now|Copy it if you also want your own backup/);
  assert.doesNotMatch(settings, /j\.apiKey|_copyManagedOpenRouterKey|_dismissManagedOpenRouterReveal/);
  // #2568: nothing on this screen CLAIMS a key any more, so the claim
  // action and its success copy are gone with the button.
  assert.doesNotMatch(settings, /_claimManagedOpenRouterKey/);
  assert.doesNotMatch(settingsSection, /Create my included key/);
  assert.match(settingsSection, /GLM 5\.3 Flash/);
  assert.match(settings, /GLM 5\.3 Flash/);
  assert.ok(
    settings.indexOf("{ key: 'openrouter'") < settings.indexOf("{ key: 'api-key'"),
    'OpenRouter precedes the Anthropic key in the AI settings group',
  );
  assert.match(deploy, /secrets\.USERNODE_OPENROUTER_MANAGEMENT_API_KEY/);
  // #2568 retired the gate. The deploy workflow still writes the variable
  // (workflow files are not this change's to edit) and nothing reads it —
  // the same inert state OPENROUTER_MANAGED_DAILY_LIMIT_USD is in.
  assert.match(deploy, /OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY=\$\{\{ vars\.OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY \|\| 'false' \}\}/);
  assert.doesNotMatch(envExample, /OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY/);
  assert.doesNotMatch(envExample, /CODEX_OPENROUTER_BETA_USER_IDS/);
  assert.match(deploy, /OPENROUTER_DEFAULT_CODEX_MODEL=\$\{\{ vars\.OPENROUTER_DEFAULT_CODEX_MODEL \|\| 'z-ai\/glm-5\.3-flash' \}\}/);
  assert.match(envExample, /OPENROUTER_DEFAULT_CODEX_MODEL=z-ai\/glm-5\.3-flash/);
  assert.match(deploy, /OPENROUTER_RECOMMENDED_MODELS=/);
  assert.match(envExample, /OPENROUTER_RECOMMENDED_MODELS=deepseek\/deepseek-v4\.1-flash/);
  assert.ok(appManifest.PLATFORM_ENV_UNWRITABLE.has('OPENROUTER_MANAGEMENT_API_KEY'));
  const declaration = manifest.platform_env.find((item) => item.key === 'OPENROUTER_MANAGEMENT_API_KEY');
  assert.equal(declaration.private, true);
  // #2568: the allowlist is gone outright. The verified-identity variable
  // keeps its declaration only because the deploy workflow still writes it
  // (tests/platform-env-manifest.test.js pins that correspondence), and its
  // description says so — the same inert state the old daily limit is in.
  assert.equal(
    manifest.platform_env.some((item) => item.key === 'CODEX_OPENROUTER_BETA_USER_IDS'),
    false,
    'the gradual-rollout allowlist is no longer a tunable of this platform',
  );
  const verificationDeclaration = manifest.platform_env.find(
    (item) => item.key === 'OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY',
  );
  assert.match(verificationDeclaration.description, /^No longer used\./);
  const modelDeclaration = manifest.platform_env.find(
    (item) => item.key === 'OPENROUTER_DEFAULT_CODEX_MODEL',
  );
  assert.equal(modelDeclaration.default, 'z-ai/glm-5.3-flash');
  const recommendedDeclaration = manifest.platform_env.find(
    (item) => item.key === 'OPENROUTER_RECOMMENDED_MODELS',
  );
  assert.match(recommendedDeclaration.default, /deepseek\/deepseek-v4\.1-flash/);
  assert.doesNotMatch(routes, /verificationRequired/);
  assert.doesNotMatch(settings, /provisioning\.verificationRequired/);

  // #2119: the key carries the platform weekly allowance, and every label
  // derives from the stored cadence.
  const adminUsers = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-users.tsx'), 'utf8');
  const managementSource = fs.readFileSync(path.join(root, 'src/services/openrouter-management-client.js'), 'utf8');
  const managedSource = fs.readFileSync(path.join(root, 'src/services/openrouter-managed-keys.js'), 'utf8');
  assert.match(schema, /managed_openrouter_keys_limit_reset_check\n\s+CHECK \(limit_reset IN \('daily', 'weekly'\)\)/);
  assert.doesNotMatch(managementSource, /limit_reset: 'daily'/,
    'the cadence is policy the service owns, not a client default');
  assert.match(managedSource, /limits\.getEffectiveUserWeeklyLimitCents\(pool, userId\)/,
    'the amount is the same weekly allowance the Claude gate resolves');
  assert.doesNotMatch(managedSource, /identityGated/,
    '#2568: a zero allowance is an admin decision now, never an identity gate');
  assert.match(routes, /resolveAllowance\(pool, req\.user\.id\)/);
  assert.match(routes, /syncAllowance\(\{/);
  assert.match(admin, /users\/:id\/weekly-limit'[\s\S]*?syncAllowance\(\{/,
    'setting a user\'s weekly cap re-limits their included key');
  assert.match(settings, /limitNoun\(managed\.limitReset\)/);
  assert.match(settings, /limitNoun\(provisioning\.limitReset, 'allowance'\)/);
  assert.match(settingsSection, /settings-openrouter-included-status/,
    'the claim card is a status line now (#2568)');
  assert.match(settings, /provisioning\.reason === 'no_allowance'/);
  assert.match(adminUsers, /RESET_PERIOD\[reset\]/);
  assert.doesNotMatch(adminUsers, /toFixed\(2\)\}\/day/);
  // No per-key amount from the environment: the deploy workflow is untouched
  // (the old daily variable it still writes is inert), and nothing declares
  // or documents a weekly one.
  assert.doesNotMatch(deploy, /OPENROUTER_MANAGED_WEEKLY_LIMIT_USD/);
  assert.match(deploy, /OPENROUTER_MANAGED_DAILY_LIMIT_USD=\$\{\{ vars\.OPENROUTER_MANAGED_DAILY_LIMIT_USD \|\| '1' \}\}/);
  assert.doesNotMatch(envExample, /OPENROUTER_MANAGED_WEEKLY_LIMIT_USD/);
  assert.equal(manifest.platform_env.some((item) => item.key === 'OPENROUTER_MANAGED_WEEKLY_LIMIT_USD'), false);
  const dailyDeclaration = manifest.platform_env.find(
    (item) => item.key === 'OPENROUTER_MANAGED_DAILY_LIMIT_USD',
  );
  assert.match(dailyDeclaration.description, /^No longer used\./);
  for (const file of ['public/js/app-view.js', 'public/js/build-venues.js', 'frontend/src/features/dev-chat/dev-chat.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /included daily credits/,
      `${file} must not promise a cadence it cannot read from the key`);
  }
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
