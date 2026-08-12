'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt } = require('../src/services/secrets');
const {
  MobilePushWorker,
  retryDelayMs,
} = require('../src/services/mobile-push-worker');

const DATA_KEY = 'mobile-push-worker-test-key';
const JOB = { id: 9, attempts: 1 };

function delivery(overrides = {}) {
  return {
    id: 9,
    attempts: 1,
    expires_at: new Date(Date.now() + 60_000),
    delivery_created_at: new Date(Date.now() - 1000),
    notification_id: 42,
    notification_user_id: 7,
    kind: 'session_done',
    read_at: null,
    push_category: 'developer_sessions',
    push_enabled: true,
    registration_id: 3,
    delivery_environment: 'production',
    delivery_installation_id: '123e4567-e89b-12d3-a456-426614174000',
    deployment_send_enabled: true,
    deployment_send_not_before: new Date(Date.now() - 2000),
    deployment_firebase_project_id: 'social-prod',
    installation_id: '123e4567-e89b-12d3-a456-426614174000',
    registration_environment: 'production',
    registration_hash: 'a'.repeat(64),
    registration_enc: encrypt('opaque-fcm-token', DATA_KEY),
    permission_status: 'authorized',
    registration_user_id: 7,
    registration_session_expires_at: new Date(Date.now() + 60_000),
    app_name: 'MyPage',
    source_username: null,
    message_content: null,
    session_title: 'Fix login redirect loop',
    pr_title: null,
    branch_name: null,
    detail: null,
    ...overrides,
  };
}

function harness({
  row = delivery(),
  send = async () => 'provider-id',
  deleteRowCount = 1,
} = {}) {
  const calls = { sent: [], finished: [], deleted: [] };
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('DELETE FROM mobile_push_registrations')) {
        calls.deleted.push({
          id: params[0],
          registrationHash: params[1],
          registrationEnc: params[2],
        });
        return { rows: [], rowCount: deleteRowCount };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: {
      mobilePushEnabled: true,
      mobilePushEnvironment: 'production',
      firebaseProjectId: 'social-prod',
      dataEncryptionKey: DATA_KEY,
    },
    provider: { send: async (message) => { calls.sent.push(message); return send(message); } },
    options: { sendTimeoutMs: 100 },
  });
  worker.loadDelivery = async () => row;
  worker.finish = async (job, status, code, availableAt) => {
    calls.finished.push({ job, status, code: code || null, availableAt: availableAt || null });
  };
  return { worker, calls };
}

test('eligible delivery sends one contextual bound message and marks it sent', async () => {
  const { worker, calls } = harness();
  await worker.processDelivery(JOB);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.finished, [{ job: JOB, status: 'sent', code: null, availableAt: null }]);
  assert.equal(calls.sent[0].data.notification_id, '42');
  assert.equal(calls.sent[0].data.environment, 'production');
  assert.deepEqual(calls.sent[0].notification, {
    title: 'Session finished · MyPage',
    body: '"Fix login redirect loop" is ready to review',
  });
});

test('a delivery with no context fields still sends with the generic fallback', async () => {
  const { worker, calls } = harness({
    row: delivery({
      kind: 'mention',
      push_category: 'direct_interactions',
      app_name: null,
      source_username: null,
      message_content: null,
      session_title: null,
    }),
  });
  await worker.processDelivery(JOB);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0].notification, {
    title: 'Usernode', body: 'You have new activity',
  });
});

test('pre-send revalidation cancels ineligible recipient and deployment state', async () => {
  for (const [change, reason] of [
    [{ read_at: new Date() }, 'notification_read'],
    [{ kind: 'future_kind', push_category: null, push_enabled: false }, 'kind_not_allowed'],
    [{ push_enabled: false }, 'preference_disabled'],
    [{ delivery_environment: 'staging' }, 'environment_mismatch'],
    [{ deployment_send_enabled: false }, 'sender_disabled'],
    [{ deployment_send_enabled: null }, 'sender_disabled'],
    [{ deployment_firebase_project_id: 'other-project' }, 'firebase_project_mismatch'],
    [{ deployment_send_not_before: null }, 'activation_cutoff'],
    [{ deployment_send_not_before: new Date() }, 'activation_cutoff'],
    [{ registration_user_id: 8 }, 'recipient_mismatch'],
    [{ registration_session_expires_at: new Date(Date.now() - 1000) }, 'session_inactive'],
    [{ permission_status: 'denied' }, 'permission_ineligible'],
  ]) {
    const { worker, calls } = harness({ row: delivery(change) });
    await worker.processDelivery(JOB);
    assert.equal(calls.sent.length, 0, reason);
    assert.equal(calls.finished[0].status, 'cancelled');
    assert.equal(calls.finished[0].code, reason);
  }
});

test('delivery reload includes the current deployment state and activation timestamps', async () => {
  let seen;
  const pool = {
    async query(sql, params) {
      seen = { sql, params };
      return { rows: [] };
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: {
      mobilePushEnvironment: 'production',
      firebaseProjectId: 'social-prod',
    },
    provider: { send: async () => {} },
  });
  assert.equal(await worker.loadDelivery(JOB), null);
  assert.match(seen.sql, /d\.created_at AS delivery_created_at/);
  assert.match(seen.sql, /LEFT JOIN mobile_push_deployment_state state/);
  assert.match(seen.sql, /LEFT JOIN mobile_push_kind_categories policy/);
  assert.match(seen.sql, /LEFT JOIN mobile_push_preferences preference/);
  assert.match(seen.sql, /COALESCE\(preference\.enabled, policy\.default_enabled, FALSE\) AS push_enabled/);
  assert.match(seen.sql, /state\.send_enabled AS deployment_send_enabled/);
  assert.match(seen.sql, /state\.send_not_before AS deployment_send_not_before/);
  assert.match(seen.sql, /state\.firebase_project_id AS deployment_firebase_project_id/);
  // Send-time context for the contextual notification copy (#3289): the same
  // joins the in-app dropdown uses, all LEFT so a missing row can never make
  // an otherwise-valid delivery vanish.
  assert.match(seen.sql, /LEFT JOIN apps a ON a\.id = n\.app_id/);
  assert.match(seen.sql, /LEFT JOIN users su ON su\.id = n\.source_user_id/);
  assert.match(seen.sql, /LEFT JOIN chat_messages cm ON cm\.id = n\.chat_message_id/);
  assert.match(seen.sql, /LEFT JOIN chat_sessions cs ON cs\.id = n\.session_id/);
  assert.match(seen.sql, /a\.name AS app_name/);
  assert.match(seen.sql, /su\.username AS source_username/);
  assert.match(seen.sql, /cm\.content AS message_content/);
  assert.match(seen.sql, /cs\.session_title, cs\.pr_title, cs\.branch_name/);
  assert.match(seen.sql, /n\.detail/);
  assert.deepEqual(seen.params, [JOB.id]);
});

test('finish updates the in-process claim without a lease-generation fence', async () => {
  let seen;
  const worker = new MobilePushWorker({
    pool: {
      async query(sql, params) {
        seen = { sql, params };
        return { rows: [] };
      },
    },
    config: {},
    provider: { send: async () => {} },
  });
  await worker.finish(JOB, 'sent');
  assert.doesNotMatch(seen.sql, /attempts\s*=|lease_expires_at/);
  assert.match(seen.sql, /WHERE id = \$1 AND status = 'sending'/);
  assert.deepEqual(seen.params, [JOB.id, 'sent', null, true, null]);
});

test('invalid provider token deletes the live registration and kills this delivery', async () => {
  const err = Object.assign(new Error('provider rejected token'), {
    code: 'messaging/registration-token-not-registered',
  });
  const row = delivery();
  const { worker, calls } = harness({ row, send: async () => { throw err; } });
  await worker.processDelivery(JOB);
  assert.deepEqual(calls.deleted, [{
    id: row.registration_id,
    registrationHash: row.registration_hash,
    registrationEnc: row.registration_enc,
  }]);
  assert.equal(calls.finished[0].status, 'dead');
  assert.equal(calls.finished[0].code, err.code);
});

test('a refreshed registration survives a permanent result from a stale provider call', async () => {
  const err = Object.assign(new Error('provider rejected stale token'), {
    code: 'messaging/registration-token-not-registered',
  });
  const { worker, calls } = harness({
    send: async () => { throw err; },
    deleteRowCount: 0,
  });
  await worker.processDelivery(JOB);
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.finished[0].status, 'pending');
  assert.equal(calls.finished[0].code, 'registration_refreshed');
  assert.ok(calls.finished[0].availableAt > new Date());
});

test('decrypt failures conditionally delete only the registration that was loaded', async () => {
  const stale = delivery({ registration_enc: 'corrupt-envelope' });
  const deleted = harness({ row: stale });
  await deleted.worker.processDelivery(JOB);
  assert.deepEqual(deleted.calls.deleted, [{
    id: stale.registration_id,
    registrationHash: stale.registration_hash,
    registrationEnc: stale.registration_enc,
  }]);
  assert.equal(deleted.calls.finished[0].status, 'dead');
  assert.equal(deleted.calls.finished[0].code, 'registration_decrypt_failed');

  const refreshed = harness({ row: stale, deleteRowCount: 0 });
  await refreshed.worker.processDelivery(JOB);
  assert.equal(refreshed.calls.finished[0].status, 'pending');
  assert.equal(refreshed.calls.finished[0].code, 'registration_refreshed');
});

test('transient failures use bounded backoff and keep retrying until delivery expiry', async () => {
  const err = Object.assign(new Error('unavailable'), { code: 'messaging/server-unavailable' });
  const retry = harness({ send: async () => { throw err; } });
  await retry.worker.processDelivery(JOB);
  assert.equal(retry.calls.finished[0].status, 'pending');
  assert.equal(retry.calls.finished[0].code, err.code);
  assert.ok(retry.calls.finished[0].availableAt > new Date());

  const highAttemptJob = { id: 9, attempts: 50 };
  const highAttempt = harness({
    row: delivery({ attempts: 50, expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000) }),
    send: async () => { throw err; },
  });
  await highAttempt.worker.processDelivery(highAttemptJob);
  assert.equal(highAttempt.calls.finished[0].status, 'pending');
  assert.equal(retryDelayMs(1, 5000, 60 * 60 * 1000), 5000);
  assert.equal(retryDelayMs(2, 5000, 60 * 60 * 1000), 10000);
  assert.equal(retryDelayMs(50, 5000, 60 * 60 * 1000), 60 * 60 * 1000);
});

test('claim uses the current deployment and increments the retry count', async () => {
  let seen;
  const pool = {
    async query(sql, params) {
      seen = { sql, params };
      return { rows: [{ id: 5, attempts: 2 }] };
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: {
      mobilePushEnabled: true,
      mobilePushEnvironment: 'production',
      firebaseProjectId: 'social-prod',
    },
    provider: { send: async () => {} },
  });
  assert.deepEqual(await worker.claimBatch(), [{ id: 5, attempts: 2 }]);
  assert.doesNotMatch(seen.sql, /SKIP LOCKED|lease_expires_at/);
  assert.match(seen.sql, /JOIN mobile_push_deployment_state/);
  assert.match(seen.sql, /send_enabled/);
  assert.match(seen.sql, /d\.created_at >= state\.send_not_before/);
  assert.match(seen.sql, /attempts = d\.attempts \+ 1/);
  assert.equal(seen.params[1], 'production');
  assert.equal(seen.params[2], 'social-prod');
  assert.equal(seen.params.length, 3);
});

test('maintenance resets interrupted work and performs bounded retention', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: { mobilePushEnabled: true, mobilePushEnvironment: 'production' },
    provider: { send: async () => {} },
    options: { retentionDays: 14, retentionBatchSize: 25 },
  });
  await worker.maintain();
  assert.equal(queries.length, 4);
  assert.doesNotMatch(queries[0].sql, /attempts\s*>=/);
  assert.doesNotMatch(queries[0].sql, /lease_expires_at/);
  assert.match(queries[0].sql, /status = 'sending'/);
  assert.equal(queries[0].params, undefined);
  assert.doesNotMatch(queries[1].sql, /mobile_auth_tokens/);
  assert.match(queries[1].sql, /r\.session_expires_at <= NOW\(\)/);
  assert.match(queries[1].sql, /ORDER BY r\.id LIMIT \$1/);
  assert.match(
    queries[1].sql,
    /DELETE FROM mobile_push_registrations r USING doomed\s+WHERE r\.id = doomed\.id\s+AND r\.session_expires_at <= NOW\(\)/
  );
  assert.deepEqual(queries[1].params, [25]);
  assert.match(queries[2].sql, /status IN \('sent', 'dead', 'cancelled'\)/);
  assert.match(queries[2].sql, /ORDER BY id LIMIT \$2/);
  assert.deepEqual(queries[2].params, [14, 25]);
  assert.match(queries[3].sql, /FROM mobile_push_installation_mutations/);
  assert.match(queries[3].sql, /NOT EXISTS/);
  assert.match(queries[3].sql, /FROM mobile_push_registrations/);
  assert.match(queries[3].sql, /m\.latest_mutation_revision = doomed\.latest_mutation_revision/);
  assert.match(queries[3].sql, /LIMIT \$2/);
  assert.deepEqual(queries[3].params, [14, 25]);
});
