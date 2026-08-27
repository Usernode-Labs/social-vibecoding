'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  validatePut, validateDelete, validateGet, putRegistration, deleteRegistration,
  readRegistrationState, isDeliveryActive, withDeploymentIdentity,
  noStore, requireEnabled, requireConfigured,
} = require('../src/routes/topochain/mobile-push-registration');

const INSTALLATION = '123e4567-e89b-12d3-a456-426614174000';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

function input(revision, overrides = {}) {
  return {
    installationId: INSTALLATION,
    mutationRevision: String(revision),
    provider: 'fcm',
    platform: 'android',
    permissionStatus: 'authorized',
    registration: 'token-one',
    ...overrides,
  };
}

function fakeClient() {
  const state = {
    tokens: new Map([
      ['10', { id: 10, userId: 1, active: true, expiresAt: new Date(Date.now() + 60_000) }],
      ['11', { id: 11, userId: 1, active: true, expiresAt: new Date(Date.now() + 120_000) }],
      ['20', { id: 20, userId: 2, active: true, expiresAt: new Date(Date.now() + 60_000) }],
    ]),
    fence: null,
    deployment: {
      environment: 'production',
      firebase_project_id: 'social-prod',
      send_enabled: true,
      send_not_before: new Date(Date.now() - 1000),
    },
    registrations: [],
    events: [],
    nextId: 1,
    queries: [],
  };

  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);
    state.queries.push(sql);
    if (sql.includes('FROM mobile_push_deployment_state')
        && sql.includes('FOR KEY SHARE')) {
      return { rows: state.deployment?.environment === params[0]
        ? [{ ...state.deployment }] : [] };
    }
    if (sql.startsWith('SELECT state.environment, state.firebase_project_id')) {
      const registration = state.registrations.find((row) => (
        row.environment === params[0]
        && String(row.user_id) === String(params[1])
        && row.installation_id === params[2]
      ));
      if (!state.deployment || state.deployment.environment !== params[0]) {
        return { rows: [] };
      }
      return { rows: [{
        ...state.deployment,
        registration_id: registration?.id || null,
        permission_status: registration?.permission_status || null,
        session_expires_at: registration?.session_expires_at || null,
      }] };
    }
    if (sql.startsWith('SELECT t.id, t.expires_at FROM mobile_auth_tokens t')) {
      const token = state.tokens.get(String(params[0]));
      return { rows: token && token.active && String(token.userId) === String(params[1])
        ? [{ id: token.id, expires_at: token.expiresAt }] : [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (sql.includes('FROM mobile_push_installation_mutations')) {
      return { rows: state.fence ? [{ ...state.fence }] : [] };
    }
    if (sql.startsWith('SELECT id, user_id, environment')
        && sql.includes('registration_hash = $3')) {
      const [environment, installationId, registrationHash] = params;
      return { rows: state.registrations.filter((row) => (
        (row.environment === environment && row.installation_id === installationId)
        || (row.environment === environment && row.registration_hash === registrationHash)
      )).map((row) => ({ ...row })) };
    }
    if (sql.startsWith('SELECT id, user_id, environment, installation_id')) {
      return { rows: state.registrations.filter((row) => (
        row.environment === params[0] && row.installation_id === params[1]
      )).map((row) => ({ ...row })) };
    }
    if (sql.startsWith('DELETE FROM mobile_push_registrations WHERE id = ANY')) {
      const ids = new Set(params[0].map(String));
      state.registrations = state.registrations.filter((row) => !ids.has(String(row.id)));
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM mobile_push_registrations WHERE id = $1')) {
      state.registrations = state.registrations.filter((row) => String(row.id) !== String(params[0]));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO mobile_push_installation_mutations')) {
      state.fence = {
        latest_mutation_revision: String(params[2]),
        latest_mutation_kind: params[3],
      };
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO mobile_push_registration_events')) {
      state.events.push({
        user_id: params[0],
        registration_id: params[1],
        environment: params[2],
        installation_id: params[3],
        platform: params[4],
        permission_status: params[5],
        event_kind: params[6],
        reason_code: params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO mobile_push_registrations')) {
      const id = state.nextId++;
      state.registrations.push({
        id,
        user_id: params[0],
        environment: params[1],
        installation_id: params[2],
        provider: params[3],
        registration_hash: params[4],
        platform: params[6],
        permission_status: params[7],
        session_expires_at: params[8],
      });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('UPDATE mobile_push_registrations')) {
      const row = state.registrations.find((candidate) => (
        String(candidate.id) === String(params[0])
      ));
      if (row) {
        if (sql.includes('GREATEST(session_expires_at')) {
          if (new Date(params[1]) > new Date(row.session_expires_at)) {
            row.session_expires_at = params[1];
          }
        } else {
          row.provider = params[1];
          row.registration_hash = params[2];
          row.platform = params[4];
          row.permission_status = params[5];
          row.session_expires_at = params[6];
        }
      }
      return { rows: [] };
    }
    throw new Error(`Unhandled query: ${sql}`);
  }
  return { state, query };
}

function put(client, tokenId, userId, value) {
  return putRegistration(client, {
    userId,
    tokenId,
    environment: 'production',
    firebaseProjectId: 'social-prod',
    input: value,
    registrationHash: hash(value.registration),
    registrationEnc: 'v1:encrypted',
  });
}

function del(client, tokenId, userId, value) {
  return deleteRegistration(client, {
    userId, tokenId, environment: 'production', input: value,
  });
}

test('registration validation accepts the Flutter wire contract and rejects loose revisions', () => {
  const valid = validatePut({
    installation_id: INSTALLATION.toUpperCase(),
    mutation_revision: '1',
    provider: 'fcm',
    registration: 'opaque-token',
    platform: 'ios',
    permission_status: 'provisional',
  });
  assert.deepEqual(valid.details, {});
  assert.equal(valid.value.installationId, INSTALLATION);
  assert.equal(valid.value.mutationRevision, '1');

  const legacyDelete = validateDelete({
    installation_id: INSTALLATION,
    mutation_revision: '2',
  });
  assert.deepEqual(legacyDelete.details, {});
  assert.equal(legacyDelete.value.unregistrationReason, 'client_request');
  for (const reason of [
    'notifications_disabled', 'permission_denied', 'signed_out',
    'account_changed', 'identity_boundary', 'terminal_reset',
    'configuration_unavailable',
  ]) {
    assert.equal(validateDelete({
      installation_id: INSTALLATION,
      mutation_revision: '2',
      reason,
    }).value.unregistrationReason, reason);
  }
  assert.ok(validateDelete({
    installation_id: INSTALLATION,
    mutation_revision: '2',
    reason: 'device said anything',
  }).details.reason);

  for (const bad of [1, '0', '01', '-1', '9223372036854775808']) {
    assert.ok(validateDelete({
      installation_id: INSTALLATION, mutation_revision: bad,
    }).details.mutation_revision);
  }
  assert.ok(validatePut({
    installation_id: INSTALLATION,
    mutation_revision: '1',
    provider: 'fcm', registration: 'has whitespace', platform: 'ios',
    permission_status: 'authorized',
  }).details.registration);
  assert.deepEqual(validateGet({ installation_id: INSTALLATION }).details, {});
  assert.ok(validateGet({ installation_id: 'not-a-uuid' }).details.installation_id);
});

test('registration responses are never cacheable', () => {
  const headers = {};
  let next = false;
  noStore({}, { set: (key, value) => { headers[key] = value; } }, () => { next = true; });
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(next, true);
});

test('success contracts include the authoritative deployment identity', () => {
  assert.deepEqual(withDeploymentIdentity({
    environment: 'production', firebase_project_id: 'social-prod',
  }, {
    registered: true, delivery_active: false, mutation_revision: '7',
  }), {
    registered: true,
    delivery_active: false,
    mutation_revision: '7',
    environment: 'production',
    firebase_project_id: 'social-prod',
  });
});

test('registration kill switch blocks PUT but keeps configured DELETE cleanup available', () => {
  const config = {
    mobilePushEnabled: false,
    mobilePushEnvironment: 'production',
    firebaseProjectId: 'social-prod',
  };
  let configuredNext = false;
  requireConfigured(config)(
    {}, {}, () => { configuredNext = true; }
  );
  assert.equal(configuredNext, true);

  let statusCode = null;
  let body = null;
  const response = {
    status(value) { statusCode = value; return this; },
    json(value) { body = value; return this; },
  };
  requireEnabled(config)({}, response, () => assert.fail('PUT must stay disabled'));
  assert.equal(statusCode, 503);
  assert.equal(body.code, 'push_registration_disabled');

  requireConfigured(
    { ...config, firebaseProjectId: '' }
  )({}, response, () => assert.fail('project identity is required'));
  assert.equal(statusCode, 503);
  assert.equal(body.code, 'push_registration_not_configured');
});

test('registration mutations lock deployment identity before session and registration rows', async () => {
  const client = fakeClient();
  await put(client, 10, 1, input(1));
  const deploymentLock = client.state.queries.findIndex((sql) => (
    sql.includes('FROM mobile_push_deployment_state') && sql.includes('FOR KEY SHARE')
  ));
  const sessionLock = client.state.queries.findIndex((sql) => (
    sql.startsWith('SELECT t.id, t.expires_at FROM mobile_auth_tokens t')
      && sql.includes('JOIN native_session_credentials c')
      && sql.includes("c.state = 'valid'")
      && sql.includes('FOR SHARE OF c')
  ));
  const registrationLock = client.state.queries.findIndex((sql) => (
    sql.startsWith('SELECT id, user_id, environment')
  ));
  assert.ok(deploymentLock >= 0);
  assert.ok(deploymentLock < sessionLock);
  assert.ok(sessionLock < registrationLock);
});

test('a mismatched Firebase project cannot create a registration', async () => {
  const client = fakeClient();
  client.state.deployment.firebase_project_id = 'social-prod-v2';
  await assert.rejects(
    put(client, 10, 1, input(1)),
    { name: 'DeploymentUnavailable' }
  );
  assert.equal(client.state.registrations.length, 0);
  assert.equal(client.state.queries.some((sql) => (
    sql.startsWith('SELECT t.id, t.expires_at FROM mobile_auth_tokens t')
  )), false, 'deployment mismatch fails before session/registration locks');
});

test('registration status is scoped to the user and installation', async () => {
  const client = fakeClient();
  await put(client, 10, 1, input(1));
  const active = await readRegistrationState(client, {
    userId: 1,
    environment: 'production',
    installationId: INSTALLATION,
  });
  assert.equal(active.firebase_project_id, 'social-prod');
  assert.equal(active.registration_id, 1);
  assert.equal(isDeliveryActive(active), true);

  const sameUser = await readRegistrationState(client, {
    userId: 1,
    environment: 'production',
    installationId: INSTALLATION,
  });
  assert.equal(sameUser.registration_id, 1);

  const otherUser = await readRegistrationState(client, {
    userId: 2,
    environment: 'production',
    installationId: INSTALLATION,
  });
  assert.equal(otherUser.registration_id, null);
  assert.equal(isDeliveryActive(otherUser), false);
  assert.equal(isDeliveryActive({ ...active, send_enabled: false }), false);
  assert.equal(isDeliveryActive({
    ...active, session_expires_at: new Date(Date.now() - 1000),
  }), false);
});

test('PUT is monotonic, exact-replay idempotent, and payload-conflicting at one revision', async () => {
  const client = fakeClient();
  const created = await put(client, 10, 1, input(1));
  assert.equal(client.state.registrations.length, 1);
  assert.equal(client.state.fence.latest_mutation_revision, '1');
  assert.equal(created.session_expires_at, client.state.tokens.get('10').expiresAt);
  assert.equal(isDeliveryActive({
    ...created,
    registration_id: 1,
    permission_status: 'authorized',
  }), true);
  const incumbentId = client.state.registrations[0].id;
  assert.deepEqual(client.state.events.map((event) => event.event_kind), [
    'registration_created',
  ]);

  await put(client, 11, 1, input(1));
  assert.equal(client.state.registrations.length, 1, 'exact replay does not rotate the row');
  assert.equal(client.state.registrations[0].session_expires_at,
    client.state.tokens.get('11').expiresAt,
    'exact replay can extend the same user registration lifetime');
  assert.equal(client.state.events.length, 1, 'exact replay emits no duplicate event');

  await assert.rejects(
    put(client, 10, 1, input(1, { permissionStatus: 'provisional' })),
    (err) => err.code === 'push_mutation_conflict' && err.latestRevision === '1'
  );

  await put(client, 11, 1, input(2, { permissionStatus: 'provisional' }));
  assert.equal(client.state.registrations[0].id, incumbentId,
    'same-user bearer renewal preserves pending delivery foreign keys');
  assert.equal(
    client.state.registrations[0].session_expires_at,
    client.state.tokens.get('11').expiresAt,
    'registration adopts the renewed bearer expiry bound'
  );
  assert.equal(client.state.registrations[0].permission_status, 'provisional');
  assert.equal(client.state.events.at(-1).event_kind, 'registration_updated');
  assert.equal(client.state.events.at(-1).permission_status, 'provisional');
  await put(client, 11, 1, input(3, { registration: 'token-two' }));
  assert.equal(client.state.registrations[0].id, incumbentId,
    'same-user FCM token refresh updates the incumbent row');
  assert.equal(client.state.registrations[0].registration_hash, hash('token-two'));
  assert.equal(client.state.events.at(-1).event_kind, 'token_replaced');
  await assert.rejects(
    put(client, 10, 1, input(1)),
    (err) => err.code === 'stale_mutation_revision' && err.latestRevision === '3'
  );
});

test('DELETE retains its tombstone and cannot remove another user registration', async () => {
  const client = fakeClient();
  await put(client, 10, 1, input(1));
  await del(client, 10, 1, {
    installationId: INSTALLATION, mutationRevision: '2',
    unregistrationReason: 'notifications_disabled',
  });
  assert.equal(client.state.registrations.length, 0);
  assert.equal(client.state.events.at(-1).event_kind, 'client_unregistered');
  assert.equal(client.state.events.at(-1).reason_code, 'notifications_disabled');
  assert.deepEqual(client.state.fence, {
    latest_mutation_revision: '2', latest_mutation_kind: 'delete',
  });
  await del(client, 10, 1, {
    installationId: INSTALLATION, mutationRevision: '2',
    unregistrationReason: 'notifications_disabled',
  });
  assert.equal(client.state.events.filter((event) => (
    event.event_kind === 'client_unregistered'
  )).length, 1, 'exact DELETE replay emits no duplicate event');

  await put(client, 20, 2, input(3, { registration: 'token-two' }));
  await assert.rejects(
    del(client, 10, 1, { installationId: INSTALLATION, mutationRevision: '4' }),
    (err) => err.code === 'push_mutation_session_conflict'
  );
  assert.equal(String(client.state.registrations[0].user_id), '2');
  assert.equal(client.state.fence.latest_mutation_revision, '3');
});

test('reassigning an installation records why the previous registration disappeared', async () => {
  const client = fakeClient();
  await put(client, 10, 1, input(1));
  await put(client, 20, 2, input(2, { registration: 'token-two' }));

  assert.equal(client.state.registrations.length, 1);
  assert.equal(String(client.state.registrations[0].user_id), '2');
  const reassigned = client.state.events.find((event) => (
    event.event_kind === 'registration_reassigned'
  ));
  assert.ok(reassigned);
  assert.equal(String(reassigned.user_id), '1');
  assert.equal(reassigned.reason_code, 'installation_reassigned');
  assert.deepEqual(client.state.events.map((event) => event.event_kind), [
    'registration_created',
    'registration_reassigned',
    'registration_created',
  ]);
});

test('a bearer revoked between middleware and mutation cannot commit', async () => {
  const client = fakeClient();
  client.state.tokens.get('10').active = false;
  await assert.rejects(put(client, 10, 1, input(1)), { name: 'SessionInactive' });
  assert.equal(client.state.registrations.length, 0);
});
