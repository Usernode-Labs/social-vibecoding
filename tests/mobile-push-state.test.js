'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  disableDeploymentStates,
  initialize,
  resetForTests,
  synchronizeDeploymentState,
  validateConfiguration,
} = require('../src/services/mobile-push');

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

function config(overrides = {}) {
  return {
    mobilePushEnabled: true,
    mobilePushEnvironment: 'production',
    firebaseProjectId: 'social-prod',
    firebaseServiceAccountJsonB64: '',
    ...overrides,
  };
}

function harness() {
  const timestamps = [
    new Date('2026-08-01T00:00:00.000Z'),
    new Date('2026-08-02T00:00:00.000Z'),
    new Date('2026-08-03T00:00:00.000Z'),
  ];
  const state = {
    deployments: [],
    registrations: [{
      id: 1,
      user_id: 7,
      environment: 'production',
      installation_id: '123e4567-e89b-12d3-a456-426614174000',
      platform: 'ios',
      permission_status: 'authorized',
    }],
    registrationEvents: [],
    deliveries: [
      { id: 1, environment: 'production', status: 'pending' },
      { id: 2, environment: 'production', status: 'sending' },
    ],
    queries: [],
    released: false,
  };

  const client = {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      state.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM mobile_push_deployment_state')
          && sql.endsWith('FOR UPDATE')) {
        return { rows: state.deployments.map((row) => ({ ...row })) };
      }
      if (sql.startsWith('INSERT INTO mobile_push_deployment_state')) {
        const row = {
          environment: params[0],
          firebase_project_id: params[1],
          send_enabled: params[2],
          send_not_before: params[2] ? timestamps.shift() : null,
        };
        state.deployments.push(row);
        return { rows: [{ ...row }] };
      }
      if (sql.startsWith('UPDATE mobile_push_deployment_state')
          && sql.includes('WHERE environment = $1')) {
        const row = state.deployments.find(({ environment }) => environment === params[0]);
        row.firebase_project_id = params[1];
        row.send_enabled = params[2];
        row.send_not_before = params[2]
          ? (params[3] ? row.send_not_before : timestamps.shift())
          : null;
        return { rows: [{ ...row }] };
      }
      if (sql.startsWith('UPDATE mobile_push_deployment_state')
          && sql.includes('WHERE environment <> $1')) {
        for (const row of state.deployments) {
          if (row.environment !== params[0]) {
            row.send_enabled = false;
            row.send_not_before = null;
          }
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE mobile_push_deployment_state')) {
        for (const row of state.deployments) {
          row.send_enabled = false;
          row.send_not_before = null;
        }
        return { rows: [] };
      }
      if (sql.startsWith('WITH removed AS')
          && sql.includes("'firebase_project_reset'")) {
        const removed = state.registrations.filter((row) => (
          row.environment === params[0]
        ));
        state.registrations = state.registrations.filter((row) => (
          row.environment !== params[0]
        ));
        state.registrationEvents.push(...removed.map((row) => ({
          ...row,
          event_kind: 'firebase_project_reset',
          reason_code: 'firebase_project_changed',
        })));
        return { rows: [], rowCount: removed.length };
      }
      if (sql.startsWith('UPDATE mobile_push_deliveries')) {
        for (const delivery of state.deliveries) {
          const active = ['pending', 'sending'].includes(delivery.status);
          const selected = params.length === 0
            || (sql.includes('environment <> $1')
              ? delivery.environment !== params[0]
              : delivery.environment === params[0]);
          if (active && selected) {
            delivery.status = 'cancelled';
            delivery.last_error_code = params[1]
              || (sql.includes('deployment_environment_changed')
                ? 'deployment_environment_changed'
                : 'sender_disabled');
          }
        }
        return { rows: [] };
      }
      throw new Error(`Unhandled query: ${sql}`);
    },
    release() { state.released = true; },
  };
  return {
    state,
    pool: { connect: async () => client },
  };
}

test('enabled startup records active sender state', async () => {
  const { pool, state } = harness();
  const deployment = await synchronizeDeploymentState(pool, config());
  assert.equal(deployment.environment, 'production');
  assert.equal(deployment.firebase_project_id, 'social-prod');
  assert.equal(deployment.send_enabled, true);
  assert.ok(deployment.send_not_before);
  assert.ok(state.deliveries.every((delivery) => delivery.status === 'cancelled'));
  assert.equal(state.released, true);
});

test('same-identity sender restarts preserve their cutoff and queued work', async () => {
  const { pool, state } = harness();
  const first = await synchronizeDeploymentState(pool, config());
  assert.equal(first.send_not_before.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.ok(state.deliveries.every((delivery) => (
    delivery.last_error_code === 'sender_restarted'
  )));

  state.deliveries.push({ id: 3, environment: 'production', status: 'pending' });
  state.deliveries.push({ id: 4, environment: 'production', status: 'sending' });
  const restarted = await synchronizeDeploymentState(pool, config());
  assert.equal(restarted.send_not_before.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(state.deliveries[2].status, 'pending');
  assert.equal(state.deliveries[3].status, 'sending');
  const mutations = state.queries.filter(({ sql }) => (
    sql.startsWith('UPDATE mobile_push_deployment_state')
    && sql.includes('WHERE environment = $1')
  ));
  assert.match(mutations[0].sql, /WHEN \$4 THEN send_not_before/);
  assert.equal(mutations[0].params[3], true);
  assert.doesNotMatch(mutations[0].sql, /transaction_timestamp\(\)/);
});

test('re-enabling a sender establishes a fresh cutoff and drops disabled work', async () => {
  const { pool, state } = harness();
  await synchronizeDeploymentState(pool, config());
  await synchronizeDeploymentState(pool, config({ mobilePushEnabled: false }));
  state.deliveries.push({ id: 3, environment: 'production', status: 'pending' });

  const reenabled = await synchronizeDeploymentState(pool, config());

  assert.equal(reenabled.send_not_before.toISOString(), '2026-08-02T00:00:00.000Z');
  assert.equal(state.deliveries[2].status, 'cancelled');
  assert.equal(state.deliveries[2].last_error_code, 'sender_restarted');
});

test('Firebase project changes remove old-project registrations', async () => {
  const { pool, state } = harness();
  await synchronizeDeploymentState(pool, config());
  state.deliveries.push({ id: 3, environment: 'production', status: 'pending' });
  const changed = await synchronizeDeploymentState(pool, config({
    firebaseProjectId: 'social-prod-v2',
  }));
  assert.equal(changed.firebase_project_id, 'social-prod-v2');
  assert.deepEqual(state.registrations, []);
  assert.deepEqual(state.registrationEvents.map((event) => [
    event.event_kind, event.reason_code, event.installation_id,
  ]), [[
    'firebase_project_reset',
    'firebase_project_changed',
    '123e4567-e89b-12d3-a456-426614174000',
  ]]);
  assert.equal(state.deliveries[2].last_error_code, 'firebase_project_changed');
});

test('removing push identity disables all existing sender state', async () => {
  const { pool, state } = harness();
  await synchronizeDeploymentState(pool, config());
  state.deliveries.push({ id: 3, environment: 'production', status: 'pending' });
  await disableDeploymentStates(pool);
  assert.equal(state.deployments[0].send_enabled, false);
  assert.equal(state.deployments[0].send_not_before, null);
  assert.ok(state.deliveries.every((delivery) => delivery.status === 'cancelled'));
});

test('fully disabled initialization uses the database kill switch', async () => {
  const { pool, state } = harness();
  await synchronizeDeploymentState(pool, config());
  state.deliveries.push({ id: 3, environment: 'production', status: 'pending' });
  resetForTests();
  await initialize(config({
    mobilePushEnabled: false,
    mobilePushEnvironment: '',
    firebaseProjectId: '',
  }), { pool });
  assert.equal(state.deployments[0].send_enabled, false);
  assert.ok(state.deliveries.every((delivery) => delivery.status === 'cancelled'));
  resetForTests();
});

test('changing the sole deployment environment disables old-environment work', async () => {
  const { pool, state } = harness();
  await synchronizeDeploymentState(pool, config());
  state.deliveries.push({ id: 3, environment: 'production', status: 'pending' });
  await synchronizeDeploymentState(pool, config({
    mobilePushEnvironment: 'staging',
  }));
  const production = state.deployments.find((row) => row.environment === 'production');
  assert.equal(production.send_enabled, false);
  assert.equal(state.deliveries[2].last_error_code, 'deployment_environment_changed');
});

test('enabled configuration requires a complete sender identity', () => {
  assert.throws(() => validateConfiguration(config({ firebaseProjectId: '' })),
    /FIREBASE_PROJECT_ID/);
  assert.doesNotThrow(() => validateConfiguration(config({
    mobilePushEnabled: false,
    mobilePushEnvironment: '',
    firebaseProjectId: '',
  })));
});
