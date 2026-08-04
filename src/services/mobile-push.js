'use strict';

const { getPool } = require('../db/pool');
const { createFirebaseProvider, parseServiceAccount } = require('./mobile-push-provider');
const { MobilePushWorker } = require('./mobile-push-worker');
const { isPushEnvironment } = require('./mobile-push-policy');
const log = require('./logger');

let worker = null;
let provider = null;

function isFirebaseProjectId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);
}

function deploymentIdentityConfigured(config) {
  return isPushEnvironment(config.mobilePushEnvironment)
    && isFirebaseProjectId(config.firebaseProjectId);
}

function validateConfiguration(config) {
  if (config.mobilePushEnabled && !isPushEnvironment(config.mobilePushEnvironment)) {
    throw new Error('PUSH_ENV is required when mobile push is enabled');
  }
  if (config.mobilePushEnabled && !isFirebaseProjectId(config.firebaseProjectId)) {
    throw new Error('FIREBASE_PROJECT_ID is required when mobile push is enabled');
  }
  if (config.mobilePushEnabled) {
    parseServiceAccount(config.firebaseServiceAccountJsonB64, config.firebaseProjectId);
  }
}

async function synchronizeDeploymentState(pool, config) {
  if (!deploymentIdentityConfigured(config)) {
    throw new Error('mobile_push_deployment_identity_invalid');
  }
  const environment = config.mobilePushEnvironment;
  const firebaseProjectId = config.firebaseProjectId;
  const sendEnabled = config.mobilePushEnabled === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT environment, firebase_project_id, send_enabled, send_not_before
         FROM mobile_push_deployment_state
        ORDER BY environment
        FOR UPDATE`
    );
    const previous = rows.find((row) => row.environment === environment) || null;
    const projectChanged = previous !== null
      && previous.firebase_project_id !== firebaseProjectId;
    const senderContinuing = previous !== null
      && previous.send_enabled === true
      && sendEnabled
      && !projectChanged;

    let state;
    if (previous) {
      const updated = await client.query(
        `UPDATE mobile_push_deployment_state
            SET firebase_project_id = $2,
                send_enabled = $3,
                send_not_before = CASE
                  WHEN NOT $3 THEN NULL
                  WHEN $4 THEN send_not_before
                  ELSE statement_timestamp()
                END,
                updated_at = NOW()
          WHERE environment = $1
        RETURNING environment, firebase_project_id, send_enabled, send_not_before`,
        [environment, firebaseProjectId, sendEnabled, senderContinuing]
      );
      state = updated.rows[0];
    } else {
      const inserted = await client.query(
        `INSERT INTO mobile_push_deployment_state (
           environment, firebase_project_id, send_enabled, send_not_before
         ) VALUES (
           $1, $2, $3,
           CASE WHEN $3 THEN statement_timestamp() ELSE NULL END
         )
         RETURNING environment, firebase_project_id, send_enabled, send_not_before`,
        [environment, firebaseProjectId, sendEnabled]
      );
      state = inserted.rows[0];
    }

    if (projectChanged) {
      // FCM registrations are minted for one Firebase project. Flutter will
      // register a fresh receive token after it observes the new identity.
      await client.query(
        'DELETE FROM mobile_push_registrations WHERE environment = $1',
        [environment]
      );
    }

    await client.query(
      `UPDATE mobile_push_deployment_state
          SET send_enabled = FALSE,
              send_not_before = NULL,
              updated_at = NOW()
        WHERE environment <> $1`,
      [environment]
    );
    await client.query(
      `UPDATE mobile_push_deliveries
          SET status = 'cancelled',
              last_error_code = 'deployment_environment_changed',
              updated_at = NOW()
        WHERE environment <> $1 AND status IN ('pending', 'sending')`,
      [environment]
    );
    if (!senderContinuing) {
      await client.query(
        `UPDATE mobile_push_deliveries
            SET status = 'cancelled',
                last_error_code = $2,
                updated_at = NOW()
          WHERE environment = $1 AND status IN ('pending', 'sending')`,
        [
          environment,
          sendEnabled
            ? (projectChanged ? 'firebase_project_changed' : 'sender_restarted')
            : 'sender_disabled',
        ]
      );
    }

    await client.query('COMMIT');
    return state;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function disableDeploymentStates(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT environment, firebase_project_id, send_enabled, send_not_before
         FROM mobile_push_deployment_state
        ORDER BY environment
        FOR UPDATE`
    );
    await client.query(
      `UPDATE mobile_push_deployment_state
          SET send_enabled = FALSE,
              send_not_before = NULL,
              updated_at = NOW()
        WHERE send_enabled OR send_not_before IS NOT NULL`
    );
    await client.query(
      `UPDATE mobile_push_deliveries
          SET status = 'cancelled',
              last_error_code = 'sender_disabled',
              updated_at = NOW()
        WHERE status IN ('pending', 'sending')`
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function initialize(config, dependencies = {}) {
  if (worker) return;
  validateConfiguration(config);
  const pool = dependencies.pool || getPool(config);
  let nextProvider = null;
  if (config.mobilePushEnabled) {
    nextProvider = dependencies.provider
      || createFirebaseProvider(config, dependencies.firebase);
  }
  try {
    if (deploymentIdentityConfigured(config)) {
      await synchronizeDeploymentState(pool, config);
    } else {
      await disableDeploymentStates(pool);
    }
  } catch (err) {
    if (nextProvider?.close) await nextProvider.close().catch(() => {});
    throw err;
  }
  if (!config.mobilePushEnabled) return;
  provider = nextProvider;
  worker = new MobilePushWorker({
    pool,
    config,
    provider,
    options: dependencies.options,
  });
}

function start() {
  worker?.start();
}

async function stop({ timeoutMs = 5000 } = {}) {
  const drained = worker ? await worker.stop({ timeoutMs }) : true;
  if (!drained) {
    log.warn('mobile-push', 'sender did not drain before shutdown deadline');
  }
  if (provider?.close) await provider.close().catch(() => {});
  worker = null;
  provider = null;
  return drained;
}

function resetForTests() {
  worker = null;
  provider = null;
}

module.exports = {
  validateConfiguration,
  isFirebaseProjectId,
  deploymentIdentityConfigured,
  synchronizeDeploymentState,
  disableDeploymentStates,
  initialize,
  start,
  stop,
  resetForTests,
};
