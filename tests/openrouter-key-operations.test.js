'use strict';

// The OpenRouter management key is used on a conductor only: on a web
// process a company-funded key's creation, allowance sync, disabling and
// deletion are platform operations (services/openrouter-key-operation.js),
// with the same results and refusals; a workflow process makes them itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const operations = require('../src/services/platform-operations');
const keys = require('../src/services/openrouter-managed-keys');
const op = require('../src/services/openrouter-key-operation');
const { none } = require('../src/services/durable-steps');

function asWeb(t) {
  const role = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = 'web';
  t.after(() => { if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role; });
}
function capture(t, answer) {
  const asked = [];
  const prior = operations._setTransportForTests(async (p) => { asked.push(p); return { status: 'done', requestId: 'r', result: answer(p) }; });
  t.after(() => operations._setTransportForTests(prior));
  return asked;
}

test('a web process asks a conductor for a key, and its refusals read as the service\'s own', async (t) => {
  asWeb(t);
  const mgmt = require('../src/services/openrouter-management-client');
  t.mock.method(mgmt, 'createKey', () => { throw new Error('web used the management key'); });
  let answer = { ok: true, value: { managed: { id: 5, status: 'active' }, defaultModel: 'm' } };
  const asked = capture(t, () => answer);
  assert.deepEqual(await keys.provision({ pool: {}, userId: 7, config: {} }), answer.value);
  assert.deepEqual(asked, [{ appId: null, op: 'openrouter.provision', userId: 7, input: {} }]);
  answer = { ok: false, status: 409, code: 'already_issued', error: 'already' };
  await assert.rejects(keys.provision({ pool: {}, userId: 7, config: {} }),
    (err) => err instanceof keys.ManagedOpenRouterError && err.statusCode === 409 && err.code === 'already_issued');
});

test('an admin\'s disable and delete are asked for that admin', async (t) => {
  asWeb(t);
  const asked = capture(t, () => ({ ok: true, value: { id: 3, status: 'disabled' } }));
  await keys.setDisabled({ pool: {}, id: '3', disabled: true, config: {}, actorId: 1 });
  await keys.remove({ pool: {}, id: 3, config: {}, actorId: 1 });
  assert.deepEqual(asked.map((p) => [p.op, p.userId, p.input]), [
    ['openrouter.disable', 1, { id: 3, disabled: true }], ['openrouter.remove', 1, { id: 3 }],
  ]);
});

test('a web read asks for a sync only when the key is out of line, and keeps its state when it cannot', async (t) => {
  asWeb(t);
  let answer = { ok: true, value: { managed_key_id: 2, daily_limit_usd: 25, limit_reset: 'weekly' } };
  const asked = capture(t, () => answer);
  const config = { openrouterManagementApiKey: 'set' };
  const state = { managed_key_id: 2, managed_status: 'active', remote_key_hash: 'h', daily_limit_usd: 10, limit_reset: 'daily' };
  const inLine = { ...state, daily_limit_usd: 25, limit_reset: 'weekly' };
  const allowance = { cents: 2500, limitUsd: 25 };
  assert.equal(await keys.syncAllowance({ pool: {}, userId: 7, state: inLine, config, allowance }), inLine);
  assert.equal(asked.length, 0, 'in line: nothing asked');
  assert.deepEqual(await keys.syncAllowance({ pool: {}, userId: 7, state, config, allowance, actorId: 1 }), answer.value);
  assert.deepEqual(asked.at(-1), { appId: null, op: 'openrouter.sync', userId: 1, input: { userId: 7 } });
  answer = { ok: false, status: 503, error: 'down' };
  assert.equal(await keys.syncAllowance({ pool: {}, userId: 7, state, config, allowance }), state);
});

test('an account asks for its own key and sync; only a full admin acts on another\'s', async () => {
  const ask = (o, input, user) => op.authorize({}, { op: o, input }, user);
  assert.equal(await ask('openrouter.provision', {}, { id: 7 }), null);
  assert.equal(await ask('openrouter.sync', { userId: 7 }, { id: 7 }), null);
  assert.equal((await ask('openrouter.sync', { userId: 8 }, { id: 7 })).status, 403);
  assert.equal(await ask('openrouter.sync', { userId: 8 }, { id: 1, canAdminWrite: true }), null);
  for (const o of ['openrouter.disable', 'openrouter.remove']) {
    assert.equal((await ask(o, { id: 3 }, { id: 7 })).status, 403, o);
    assert.equal(await ask(o, { id: 3 }, { id: 1, canAdminWrite: true }), null, o);
  }
  assert.equal(op.anyAccount({ op: 'openrouter.provision' }), true);
  assert.equal(op.anyAccount({ op: 'openrouter.disable' }), false);
});

test('a new account without platform access may ask for its own key, nothing else', async (t) => {
  const row = { id: 9, username: 'new', is_admin: false, admin_readonly: false, has_platform_access: false, private_member_since: null, anonymised_at: null };
  const pool = { query: async () => ({ rows: [row] }) };
  t.mock.method(keys, 'provisionHere', async ({ userId }) => ({ managed: { id: 1, status: 'active' }, for: userId }));
  const out = await operations.run({ pool, config: {} }, { op: 'openrouter.provision', userId: 9, appId: null, input: {} }, none());
  assert.deepEqual(out, { ok: true, value: { managed: { id: 1, status: 'active' }, for: 9 } });
  const refused = await operations.run({ pool, config: {} }, { op: 'openrouter.disable', userId: 9, appId: null, input: { id: 1 } }, none());
  assert.equal(refused.status, 403);
});

test('the service\'s refusals are answers on the conductor, never a second provider call', async (t) => {
  let calls = 0;
  t.mock.method(keys, 'provisionHere', async () => {
    calls += 1;
    throw new keys.ManagedOpenRouterError(502, 'provisioning_needs_review', 'needs review');
  });
  const out = await op.run({ pool: {}, config: {} }, { op: 'openrouter.provision', input: {} }, { id: 7 }, none());
  assert.deepEqual(out, { ok: false, status: 502, code: 'provisioning_needs_review', error: 'needs review' });
  assert.equal(calls, 1);
});

test('a provisioning retried after its key was issued and saved answers with that key', async (t) => {
  const kernelSteps = require('../src/workflow/kernel/steps.ts');
  const resumed = kernelSteps.steps({ resumeFrom: { started: true, provisioning: true }, checkpoint: async () => {} });
  t.mock.method(keys, 'issuedKey', async (_pool, userId) => ({ revision: 3, defaultModel: null, keyInfo: null, managed: { id: 5, status: 'active' }, userId }));
  t.mock.method(keys, 'provisionHere', async () => { throw new keys.ManagedOpenRouterError(409, 'byok_configured', 'already has a key'); });
  const out = await op.run({ pool: {}, config: {} }, { op: 'openrouter.provision', input: {} }, { id: 7 }, resumed);
  assert.deepEqual(out, { value: { revision: 3, defaultModel: null, keyInfo: null, managed: { id: 5, status: 'active' }, userId: 7 } });
  assert.equal(keys.provisionHere.mock.callCount(), 0, 'no second provider call');
  // A first attempt never takes another request's key for its own result.
  const fresh = kernelSteps.steps({ resumeFrom: null, checkpoint: async () => {} });
  const refused = await op.run({ pool: {}, config: {} }, { op: 'openrouter.provision', input: {} }, { id: 7 }, fresh);
  assert.equal(refused.code, 'byok_configured');
});

test('whether included keys are offered is said without the key on a process that does not hold it', () => {
  assert.equal(keys.managedKeysEnabled({ openrouterManagementApiKey: 'k' }), true);
  assert.equal(keys.managedKeysEnabled({}), false);
  assert.equal(keys.managedKeysEnabled({ openrouterManagedKeysEnabled: true }), true);
  assert.equal(keys.managedKeysEnabled({ openrouterManagedKeysEnabled: false, openrouterManagementApiKey: 'k' }), false);
});

test('a web process without the key still offers keys and asks a conductor for them', async (t) => {
  asWeb(t);
  const asked = capture(t, () => ({ ok: true, value: { managed: { id: 8, status: 'active' } } }));
  const credentialStore = require('../src/services/credential-store');
  t.mock.method(credentialStore, 'readMetadata', async () => null);
  const config = { openrouterManagedKeysEnabled: true, codexOpenrouterEnabled: true };
  const out = await keys.ensureIncludedKey({ pool: {}, userId: 9, config, reason: 'signup_email' });
  assert.equal(out.created, true);
  assert.equal(asked[0].op, 'openrouter.provision');
  const state = { managed_key_id: 2, managed_status: 'active', remote_key_hash: 'h', daily_limit_usd: 10, limit_reset: 'daily' };
  await keys.syncAllowance({ pool: {}, userId: 9, state, config, allowance: { cents: 2500, limitUsd: 25 } });
  assert.equal(asked[1].op, 'openrouter.sync');
});
