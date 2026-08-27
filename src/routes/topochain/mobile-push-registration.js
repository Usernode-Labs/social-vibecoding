'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../../db/pool');
const { mobileTokenAuth } = require('../../middleware/topochain-auth');
const { topochainMobilePushRegistrationLimiter } = require('../../middleware/rate-limits');
const { encrypt } = require('../../services/secrets');
const { isPushEnvironment } = require('../../services/mobile-push-policy');
const { isFirebaseProjectId } = require('../../services/mobile-push');
const log = require('../../services/logger');
const { ok, fail } = require('./helpers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION_RE = /^[1-9][0-9]*$/;
const MAX_REVISION = 9223372036854775807n;
const PLATFORMS = new Set(['android', 'ios']);
const PERMISSIONS = new Set(['authorized', 'provisional', 'denied', 'not_determined']);
const CLIENT_UNREGISTRATION_REASONS = new Set([
  'client_request',
  'notifications_disabled',
  'permission_denied',
  'signed_out',
  'account_changed',
  'identity_boundary',
  'terminal_reset',
  'configuration_unavailable',
]);
const MAX_REGISTRATION_LENGTH = 4096;

class MutationConflict extends Error {
  constructor(code, latestRevision) {
    super(code);
    this.name = 'MutationConflict';
    this.code = code;
    this.latestRevision = latestRevision == null ? null : String(latestRevision);
  }
}

class SessionInactive extends Error {
  constructor() {
    super('mobile_push_session_inactive');
    this.name = 'SessionInactive';
  }
}

class DeploymentUnavailable extends Error {
  constructor() {
    super('mobile_push_deployment_unavailable');
    this.name = 'DeploymentUnavailable';
  }
}

function pushEnvironment(config) {
  const value = config.mobilePushEnvironment;
  return isPushEnvironment(value) ? value : null;
}

function firebaseProjectId(config) {
  const value = config.firebaseProjectId;
  return isFirebaseProjectId(value) ? value : null;
}

function revision(body, details) {
  const raw = body?.mutation_revision;
  if (typeof raw !== 'string' || !REVISION_RE.test(raw)
      || raw.length > 19 || BigInt(raw) > MAX_REVISION) {
    details.mutation_revision = [
      'The mutation_revision field must be a positive decimal string within the signed BIGINT range.',
    ];
    return null;
  }
  return raw;
}

function installationId(body, details) {
  const raw = body?.installation_id;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    details.installation_id = ['The installation_id field must be a UUID.'];
    return null;
  }
  return raw.toLowerCase();
}

function validatePut(body) {
  const details = {};
  const value = {
    installationId: installationId(body, details),
    mutationRevision: revision(body, details),
    provider: body?.provider,
    platform: body?.platform,
    permissionStatus: body?.permission_status,
    registration: body?.registration,
  };
  if (value.provider !== 'fcm') details.provider = ['The provider field must be fcm.'];
  if (!PLATFORMS.has(value.platform)) details.platform = ['The platform field is invalid.'];
  if (!PERMISSIONS.has(value.permissionStatus)) {
    details.permission_status = ['The permission_status field is invalid.'];
  }
  if (typeof value.registration !== 'string' || !value.registration.length
      || value.registration.length > MAX_REGISTRATION_LENGTH
      || value.registration.trim() !== value.registration
      || /\s/.test(value.registration)) {
    details.registration = [
      `The registration field must be a nonempty opaque value of at most ${MAX_REGISTRATION_LENGTH} characters.`,
    ];
  }
  return { details, value };
}

function validateDelete(body) {
  const details = {};
  const unregistrationReason = body?.reason === undefined
    ? 'client_request' : body.reason;
  if (typeof unregistrationReason !== 'string'
      || !CLIENT_UNREGISTRATION_REASONS.has(unregistrationReason)) {
    details.reason = ['The reason field is invalid.'];
  }
  return {
    details,
    value: {
      installationId: installationId(body, details),
      mutationRevision: revision(body, details),
      unregistrationReason,
    },
  };
}

function validateGet(query) {
  const details = {};
  return {
    details,
    value: { installationId: installationId(query, details) },
  };
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function recordRegistrationEvent(client, {
  userId,
  registrationId,
  environment,
  installationId: id,
  platform,
  permissionStatus,
  eventKind,
  reasonCode = null,
}) {
  await client.query(
    `INSERT INTO mobile_push_registration_events (
       user_id, registration_id, environment, installation_id, platform,
       permission_status, event_kind, reason_code
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      registrationId ?? null,
      environment,
      id,
      platform,
      permissionStatus,
      eventKind,
      reasonCode,
    ]
  );
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function lockSession(client, userId, tokenId, credentialReference) {
  const { rows } = await client.query(
    `SELECT t.id, t.expires_at
       FROM mobile_auth_tokens t
       JOIN native_session_credentials c
         ON c.mobile_auth_token_id = t.id AND c.user_id = t.user_id
      WHERE t.id = $1 AND t.user_id = $2
        AND c.credential_reference = $3
        AND t.ability = 'session' AND t.expires_at > NOW()
        AND c.state = 'valid' AND c.expires_at > NOW()
        AND c.expires_at = t.expires_at
      FOR SHARE OF c`,
    [tokenId, userId, credentialReference]
  );
  if (!rows[0]) throw new SessionInactive();
  return rows[0].expires_at;
}

async function lockDeploymentState(
  client,
  environment,
  expectedProjectId = null
) {
  const { rows } = await client.query(
    `SELECT environment, firebase_project_id, send_enabled, send_not_before
       FROM mobile_push_deployment_state
      WHERE environment = $1
      FOR KEY SHARE`,
    [environment]
  );
  const state = rows[0] || null;
  if (!state || (expectedProjectId !== null
      && state.firebase_project_id !== expectedProjectId)) {
    throw new DeploymentUnavailable();
  }
  return state;
}

async function readRegistrationState(pool, { userId, environment, installationId }) {
  const { rows } = await pool.query(
    `SELECT state.environment, state.firebase_project_id,
            state.send_enabled, state.send_not_before,
            r.id AS registration_id, r.permission_status, r.session_expires_at
       FROM mobile_push_deployment_state state
       LEFT JOIN mobile_push_registrations r
         ON r.environment = state.environment
        AND r.user_id = $2
        AND r.installation_id = $3
      WHERE state.environment = $1`,
    [environment, userId, installationId]
  );
  if (!rows[0]) throw new DeploymentUnavailable();
  return rows[0];
}

function isDeliveryActive(state) {
  return state?.registration_id != null
    && state.send_enabled === true
    && state.send_not_before != null
    && new Date(state.session_expires_at) > new Date()
    && (state.permission_status === 'authorized'
      || state.permission_status === 'provisional');
}

function withDeploymentIdentity(state, fields) {
  return {
    ...fields,
    environment: state.environment,
    firebase_project_id: state.firebase_project_id,
  };
}

async function lockIdentity(client, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

async function lockFence(client, environment, id) {
  const { rows } = await client.query(
    `SELECT latest_mutation_revision::text AS latest_mutation_revision,
            latest_mutation_kind
       FROM mobile_push_installation_mutations
      WHERE environment = $1 AND installation_id = $2
      FOR UPDATE`,
    [environment, id]
  );
  return rows[0] || null;
}

function compareRevision(requested, fence) {
  if (!fence) return 1;
  const wanted = BigInt(requested);
  const latest = BigInt(fence.latest_mutation_revision);
  if (wanted < latest) {
    throw new MutationConflict('stale_mutation_revision', fence.latest_mutation_revision);
  }
  return wanted === latest ? 0 : 1;
}

async function writeFence(client, environment, id, revisionValue, kind) {
  await client.query(
    `INSERT INTO mobile_push_installation_mutations (
       environment, installation_id, latest_mutation_revision, latest_mutation_kind
     ) VALUES ($1, $2, $3::bigint, $4)
     ON CONFLICT (environment, installation_id) DO UPDATE
       SET latest_mutation_revision = EXCLUDED.latest_mutation_revision,
           latest_mutation_kind = EXCLUDED.latest_mutation_kind,
           updated_at = NOW()`,
    [environment, id, revisionValue, kind]
  );
}

function exactPut(
  row,
  userId,
  credentialReference,
  environment,
  input,
  registrationHash
) {
  return row
    && String(row.user_id) === String(userId)
    && row.native_session_credential_reference === credentialReference
    && row.environment === environment
    && String(row.installation_id).toLowerCase() === input.installationId
    && row.provider === input.provider
    && row.registration_hash === registrationHash
    && row.platform === input.platform
    && row.permission_status === input.permissionStatus;
}

async function putRegistration(client, {
  userId, tokenId, credentialReference, environment,
  firebaseProjectId: expectedProjectId,
  input, registrationHash, registrationEnc,
}) {
  // Deployment state is always locked before session/registration rows. The
  // project-change synchronizer uses the same order before deleting old-
  // project registrations, avoiding a state <-> registration deadlock.
  const deploymentState = await lockDeploymentState(client, environment, expectedProjectId);
  const sessionExpiresAt = await lockSession(
    client,
    userId,
    tokenId,
    credentialReference
  );
  const keys = [
    `mobile-push:installation:${environment}:${input.installationId}`,
    `mobile-push:registration:${environment}:${registrationHash}`,
  ].sort();
  for (const key of keys) await lockIdentity(client, key);

  const fence = await lockFence(client, environment, input.installationId);
  const { rows } = await client.query(
    `SELECT id, user_id, native_session_credential_reference,
            environment, installation_id, provider,
            registration_hash, platform, permission_status, session_expires_at
       FROM mobile_push_registrations
      WHERE (environment = $1 AND installation_id = $2)
         OR (environment = $1 AND registration_hash = $3)
      ORDER BY id FOR UPDATE`,
    [environment, input.installationId, registrationHash]
  );
  const installation = rows.find((row) => (
    row.environment === environment
    && String(row.installation_id).toLowerCase() === input.installationId
  ));

  if (compareRevision(input.mutationRevision, fence) === 0) {
    if (fence.latest_mutation_kind !== 'put'
        || !exactPut(
          installation,
          userId,
          credentialReference,
          environment,
          input,
          registrationHash
        )) {
      throw new MutationConflict('push_mutation_conflict', fence.latest_mutation_revision);
    }
    await client.query(
      `UPDATE mobile_push_registrations
          SET session_expires_at = GREATEST(session_expires_at, $2),
              last_seen_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [installation.id, sessionExpiresAt]
    );
    return { ...deploymentState, session_expires_at: sessionExpiresAt };
  }

  // Preserve the incumbent row for an ordinary FCM token/permission refresh
  // by the same user. Pending outbox rows reference this id;
  // deleting it would SET NULL those jobs and lose a notification that was
  // already durably enqueued. A user replacement deliberately
  // gets a new row so the old recipient's pending jobs are cancelled.
  const incumbent = installation
    && String(installation.user_id) === String(userId)
    ? installation : null;
  const reassigned = rows.filter((row) => (
    !incumbent || String(row.id) !== String(incumbent.id)
  ));
  if (reassigned.length) {
    for (const row of reassigned) {
      const sameInstallation = String(row.installation_id).toLowerCase()
        === input.installationId;
      await recordRegistrationEvent(client, {
        userId: row.user_id,
        registrationId: row.id,
        environment: row.environment,
        installationId: row.installation_id,
        platform: row.platform,
        permissionStatus: row.permission_status,
        eventKind: 'registration_reassigned',
        reasonCode: sameInstallation
          ? 'installation_reassigned' : 'token_reassigned',
      });
    }
    await client.query(
      'DELETE FROM mobile_push_registrations WHERE id = ANY($1::bigint[])',
      [reassigned.map((row) => row.id)]
    );
  }
  await writeFence(client, environment, input.installationId, input.mutationRevision, 'put');
  if (incumbent) {
    const eventKind = incumbent.registration_hash === registrationHash
      ? 'registration_updated' : 'token_replaced';
    await client.query(
      `UPDATE mobile_push_registrations
          SET provider = $2,
              registration_hash = $3,
              registration_enc = $4,
              platform = $5,
              permission_status = $6,
              session_expires_at = $7,
              native_session_credential_reference = $8,
              last_seen_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [
        incumbent.id, input.provider, registrationHash, registrationEnc,
        input.platform, input.permissionStatus, sessionExpiresAt,
        credentialReference,
      ]
    );
    await recordRegistrationEvent(client, {
      userId,
      registrationId: incumbent.id,
      environment,
      installationId: input.installationId,
      platform: input.platform,
      permissionStatus: input.permissionStatus,
      eventKind,
    });
  } else {
    const inserted = await client.query(
      `INSERT INTO mobile_push_registrations (
         user_id, environment, installation_id, provider, registration_hash,
         registration_enc, platform, permission_status, session_expires_at,
         native_session_credential_reference, last_seen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING id`,
      [
        userId, environment, input.installationId, input.provider, registrationHash,
        registrationEnc, input.platform, input.permissionStatus, sessionExpiresAt,
        credentialReference,
      ]
    );
    await recordRegistrationEvent(client, {
      userId,
      registrationId: inserted.rows[0].id,
      environment,
      installationId: input.installationId,
      platform: input.platform,
      permissionStatus: input.permissionStatus,
      eventKind: 'registration_created',
    });
  }
  return { ...deploymentState, session_expires_at: sessionExpiresAt };
}

async function deleteRegistration(client, {
  userId, tokenId, credentialReference, environment, input,
}) {
  const deploymentState = await lockDeploymentState(client, environment);
  await lockSession(client, userId, tokenId, credentialReference);
  await lockIdentity(client, `mobile-push:installation:${environment}:${input.installationId}`);
  const fence = await lockFence(client, environment, input.installationId);
  const { rows } = await client.query(
    `SELECT id, user_id, environment, installation_id, platform, permission_status
       FROM mobile_push_registrations
      WHERE environment = $1 AND installation_id = $2
      FOR UPDATE`,
    [environment, input.installationId]
  );
  const current = rows[0] || null;

  if (compareRevision(input.mutationRevision, fence) === 0) {
    if (fence.latest_mutation_kind !== 'delete' || current) {
      throw new MutationConflict('push_mutation_conflict', fence.latest_mutation_revision);
    }
    return deploymentState;
  }
  if (current && String(current.user_id) !== String(userId)) {
    throw new MutationConflict(
      'push_mutation_session_conflict',
      fence?.latest_mutation_revision || null
    );
  }

  await writeFence(client, environment, input.installationId, input.mutationRevision, 'delete');
  if (current) {
    await recordRegistrationEvent(client, {
      userId: current.user_id,
      registrationId: current.id,
      environment: current.environment,
      installationId: current.installation_id,
      platform: current.platform,
      permissionStatus: current.permission_status,
      eventKind: 'client_unregistered',
      reasonCode: input.unregistrationReason || 'client_request',
    });
    await client.query('DELETE FROM mobile_push_registrations WHERE id = $1', [current.id]);
  }
  return deploymentState;
}

function conflict(res, err) {
  const body = {
    success: false,
    error: err.code === 'stale_mutation_revision'
      ? 'The push mutation is stale.' : 'The push mutation conflicts with current state.',
    code: err.code,
  };
  if (err.latestRevision !== null) body.latest_mutation_revision = err.latestRevision;
  return res.status(409).json(body);
}

function routeError(res, err) {
  if (err instanceof MutationConflict) return conflict(res, err);
  if (err instanceof SessionInactive) return fail(res, 401, 'Unauthenticated.');
  if (err instanceof DeploymentUnavailable) {
    return fail(res, 503, 'Push registration is not configured.', {
      code: 'push_deployment_unavailable',
    });
  }
  if (err?.code === '23505') {
    return conflict(res, new MutationConflict('push_mutation_conflict', null));
  }
  log.error('mobile-push-registration', 'registration mutation failed', {
    code: typeof err?.code === 'string' ? err.code : 'unknown',
  });
  return fail(res, 500, 'Internal server error.');
}

function requireEnabled(config) {
  return (_req, res, next) => {
    if (config.mobilePushEnabled !== true) {
      return fail(res, 503, 'Push registration is disabled.', {
        code: 'push_registration_disabled',
      });
    }
    return next();
  };
}

function requireConfigured(config) {
  return (_req, res, next) => {
    if (!pushEnvironment(config) || !firebaseProjectId(config)) {
      return fail(res, 503, 'Push registration is not configured.', {
        code: 'push_registration_not_configured',
      });
    }
    return next();
  };
}

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function mobilePushRegistrationRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const guards = [
    noStore,
    mobileTokenAuth(config),
    topochainMobilePushRegistrationLimiter,
    requireConfigured(config),
  ];

  router.get('/api/v4/mobile/push-registration', ...guards, async (req, res) => {
    const { details, value } = validateGet(req.query);
    if (Object.keys(details).length) {
      return fail(res, 422, 'The given data was invalid.', { details });
    }
    try {
      const state = await readRegistrationState(pool, {
        userId: req.user.id,
        environment: pushEnvironment(config),
        installationId: value.installationId,
      });
      return ok(res, withDeploymentIdentity(state, {
        registered: state.registration_id != null,
        delivery_active: isDeliveryActive(state),
      }));
    } catch (err) {
      return routeError(res, err);
    }
  });

  router.put(
    '/api/v4/mobile/push-registration',
    ...guards,
    requireEnabled(config),
    async (req, res) => {
    const { details, value } = validatePut(req.body);
    if (Object.keys(details).length) {
      return fail(res, 422, 'The given data was invalid.', { details });
    }
    const environment = pushEnvironment(config);
    const registrationHash = hash(value.registration);
    let registrationEnc;
    try {
      registrationEnc = encrypt(value.registration, config.dataEncryptionKey);
      const state = await transaction(pool, (client) => putRegistration(client, {
        userId: req.user.id,
        tokenId: req.mobileAuth.tokenId,
        credentialReference: req.mobileAuth.credentialReference,
        environment,
        firebaseProjectId: firebaseProjectId(config),
        input: value,
        registrationHash,
        registrationEnc,
      }));
      return ok(res, withDeploymentIdentity(state, {
        registered: true,
        delivery_active: isDeliveryActive({
          ...state,
          registration_id: true,
          permission_status: value.permissionStatus,
        }),
        mutation_revision: value.mutationRevision,
      }));
    } catch (err) {
      return routeError(res, err);
    }
    }
  );

  router.delete('/api/v4/mobile/push-registration', ...guards, async (req, res) => {
    const { details, value } = validateDelete(req.body);
    if (Object.keys(details).length) {
      return fail(res, 422, 'The given data was invalid.', { details });
    }
    const environment = pushEnvironment(config);
    try {
      const state = await transaction(pool, (client) => deleteRegistration(client, {
        userId: req.user.id,
        tokenId: req.mobileAuth.tokenId,
        credentialReference: req.mobileAuth.credentialReference,
        environment,
        input: value,
      }));
      return ok(res, withDeploymentIdentity(state, {
        registered: false,
        delivery_active: false,
        mutation_revision: value.mutationRevision,
        installation_cleanup: {
          installation_id: value.installationId,
          environment: state.environment,
          mutation_revision: value.mutationRevision,
        },
      }));
    } catch (err) {
      return routeError(res, err);
    }
  });

  return router;
}

module.exports = {
  mobilePushRegistrationRoutes,
  validatePut,
  validateDelete,
  validateGet,
  pushEnvironment,
  firebaseProjectId,
  MutationConflict,
  DeploymentUnavailable,
  lockDeploymentState,
  readRegistrationState,
  isDeliveryActive,
  withDeploymentIdentity,
  putRegistration,
  deleteRegistration,
  noStore,
  requireEnabled,
  requireConfigured,
};
