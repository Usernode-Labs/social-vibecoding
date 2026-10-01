'use strict';

const { randomUUID } = require('node:crypto');
const { createPreviewFlow } = require('./store');
const bindings = require('./binding-adapters');
const { activationPending } = require('./candidate-reducer');
const { withResourceUse } = require('../build-retention-guard');
const { STAGING_BUILD_LOCK, PREVIEW_LIFECYCLE_LOCK } = require('../advisory-locks');
const log = require('../logger');

function enabled(config) {
  return config?.nativePreviewAttempts === true || process.env.PREVIEW_NATIVE_ATTEMPTS_ENABLED === 'true';
}

function sameRoute(left, right) {
  return left.target === right.target && left.token === right.token && left.uid === right.uid;
}

function createActivation({
  routes = bindings,
  lock = withResourceUse,
  verify = require('./candidate-runtime').verifyCandidate,
} = {}) {
  // The caller holds the same session resource lock as preparation and cleanup.
  async function underBuildLock({ pool, config, app, sessionId, flowId, expectedIntent = null }) {
    const owner = createPreviewFlow(pool);
    let state = await owner.read(sessionId);
    if (!state.flow || state.flow.id !== flowId) return { accepted: false, reason: 'superseded_flow' };
    const ref = bindings.bindingRef(config, app, sessionId);
    const identity = { flowId, generation: state.flow.generation, headSha: state.flow.headSha };
    const intent = state.resource?.intent;
    if (!intent || intent.runtimeKind !== ref.runtimeKind || intent.namespace !== ref.namespace) {
      throw new Error('Activation runtime configuration differs from the reserved candidate');
    }

    if (!activationPending(state.binding)) {
      if (expectedIntent) return { accepted: false, reason: 'superseded_activation' };
      const expected = await routes.inspect(config, ref);
      const admission = await owner.apply({
        type: 'RequestPreviewActivation',
        actionId: randomUUID(),
        sessionId,
        ...identity,
        expected,
        stagingUrl: `https://${ref.hostname}`,
      });
      if (!admission.decision.accepted) {
        return { accepted: false, reason: admission.decision.reason };
      }
      state = admission.current;
    }

    const desired = state.binding.desired;
    if (desired.flowId !== flowId || (expectedIntent && desired.activationId !== expectedIntent)) {
      return { accepted: false, reason: 'superseded_activation' };
    }
    if (desired.receipt.stagingUrl !== `https://${ref.hostname}`) {
      throw new Error('Stable preview address changed; activation requires a new decision');
    }

    if (!state.resource?.clonePrepared) throw new Error('Candidate clone preparation is unconfirmed');
    await verify(config, state.resource.intent, flowId, desired.receipt);

    let observation = await routes.inspect(config, ref);
    if (observation.target !== desired.receipt.runtimeName) {
      if (!sameRoute(observation, desired.expected)) {
        throw new Error('Stable preview binding is ambiguous; conditional activation is blocked');
      }
      // Do not reinterpret a transport error as rejection. The durable desired
      // intent protects both possible targets until observation resolves it.
      await routes.activate(config, ref, desired.expected, desired.receipt);
      observation = await routes.inspect(config, ref);
    }

    const result = await owner.apply({
      type: 'PreviewActivationObserved',
      actionId: randomUUID(),
      sessionId,
      ...identity,
      activationId: desired.activationId,
      observation,
    });
    return {
      accepted: result.decision.accepted,
      reason: result.decision.reason,
      receipt: result.decision.receipt,
    };
  }

  async function recover({ pool, config, limit = 25 }) {
    const batchSize = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 25)));
    const { rows } = await pool.query(`WITH candidates AS (
      SELECT session_id FROM preview_bindings b WHERE desired IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cli_preview_handoffs h
          WHERE h.session_id = b.session_id AND h.flow_id::text = b.desired->>'flowId')
        AND desired->>'activationId' IS DISTINCT FROM observed->>'activationId'
        ORDER BY recovery_queue_position LIMIT $1 FOR UPDATE SKIP LOCKED
      ) UPDATE preview_bindings b SET recovery_queue_position = DEFAULT
      FROM candidates c WHERE b.session_id = c.session_id RETURNING b.session_id, b.desired`, [batchSize]);
    const results = [];
    for (const binding of rows) {
      try {
        const { rows: apps } = await pool.query(`SELECT a.* FROM apps a
          JOIN chat_sessions s ON s.app_id = a.id WHERE s.id = $1`, [binding.session_id]);
        if (!apps.length) throw new Error('Activation aggregate was deleted; route retirement requires reconciliation');
        const run = () => lock(config, STAGING_BUILD_LOCK, binding.session_id, () => underBuildLock({
          pool,
          config,
          app: apps[0],
          sessionId: binding.session_id,
          flowId: binding.desired.flowId,
          expectedIntent: binding.desired.activationId,
        }), { allRuntimes: true, tryOnly: true });
        const result = require('../preview-lifecycle').enabled(config)
          ? await lock(config, PREVIEW_LIFECYCLE_LOCK, binding.session_id, run, { tryOnly: true })
          : await run();
        results.push(result);
      } catch (error) {
        log.warn('preview-activation', 'Activation remains unresolved', {
          sessionId: binding.session_id,
          activationId: binding.desired.activationId,
          err: error.message,
        });
        results.push({ pending: true });
      }
    }
    return results;
  }

  return { underBuildLock, recover };
}

module.exports = { enabled, sameRoute, createActivation, ...createActivation() };
