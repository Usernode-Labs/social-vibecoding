'use strict';

const { randomUUID } = require('node:crypto');
const { resourceIntent } = require('./actions');
const { createPreviewFlow } = require('./store');
const { withResourceUse } = require('../build-retention-guard');
const { STAGING_BUILD_LOCK, PREVIEW_LIFECYCLE_LOCK } = require('../advisory-locks');
const log = require('../logger');

const FLOW_LABEL = 'social.usernode.io/preview-flow';

function createCleanup({
  runtime = require('../application-runtime'),
  db = require('../db-manager'),
  lock = withResourceUse,
  lifecycle = require('../preview-lifecycle'),
  clones = null,
} = {}) {
  // Called only while staging holds STAGING_BUILD_LOCK. Never clear a session
  // projection here: historical resource ownership is separate from publication.
  async function underBuildLock({ pool, config, sessionId, flowId }) {
    const owner = createPreviewFlow(pool);

    // The reducer decides retirement under the aggregate/resource transaction;
    // this executor only consumes accepted work and reports observed completion.
    const { decision, current: authorized } = await owner.apply({
      type: 'RequestPreviewCleanup',
      actionId: randomUUID(),
      sessionId,
      flowId,
    });
    if (!decision.accepted) {
      if (['resource_published', 'resource_bound', 'consumer_retirement_required', 'preparation_owned'].includes(decision.reason)) {
        return { protected: true };
      }
      throw new Error(`Preview cleanup not authorized: ${decision.reason}`);
    }

    const effect = decision.effects.find(value => value.type === 'CleanupPreview');
    if (!effect) return { disposition: decision.disposition };
    // A DB outage defers removal; durable intent survives. Guessing whether an
    // unacknowledged publication committed would risk deleting a live preview.
    const intent = resourceIntent.parse(effect.intent);
    const runtimeConfig = {
      ...config,
      appRuntime: intent.runtimeKind,
      kubernetes: {
        ...config?.kubernetes,
        appNamespace: intent.namespace,
      },
    };
    if (intent.attemptId) {
      // SQL permission does not prove that an out-of-band route writer has not
      // attached this candidate. Unknown external ownership defers all deletion.
      const { rows: apps } = await pool.query(`SELECT a.* FROM apps a
        JOIN chat_sessions s ON s.app_id = a.id WHERE s.id = $1`, [sessionId]);
      if (apps.length) {
        const bindings = require('./binding-adapters');
        const binding = await bindings.inspect(runtimeConfig, bindings.bindingRef(runtimeConfig, apps[0], sessionId));
        if (binding.target === intent.runtimeName) throw new Error('Candidate still has an external serving binding');
      } else if (authorized.binding?.desired || authorized.binding?.observed) {
        throw new Error('Deleted aggregate retains an unresolved serving binding');
      }
      await require('./candidate-runtime').removeCandidate(runtimeConfig, intent, flowId, authorized.resource?.receipt);
      if (intent.cloneOperation) {
        const cloneService = clones || require('./clone-operation').createCloneOperations();
        const removed = await cloneService.remove(intent);
        if (removed.status !== 'removed') throw new Error('Candidate clone retirement remains unconfirmed');
      } else {
        await db.dropDatabase(intent.dbName, { strict: true });
      }
      await require('./candidate-runtime').removeCandidateImage(intent);
      if (intent.checkoutDir) await require('../docker').execFileAsync('rm', ['-rf', intent.checkoutDir]);
      const completion = await owner.apply({
        type: 'PreviewCleanupCompleted',
        actionId: randomUUID(),
        sessionId,
        flowId,
        disposition: 'removed',
      });
      if (!completion.decision.accepted) throw new Error(`Candidate cleanup completion rejected: ${completion.decision.reason}`);
      return { disposition: 'removed' };
    }

    const runtimeState = await runtime.inspect(runtimeConfig, intent);
    if (!runtimeState || runtimeState.status === 'unknown') {
      throw new Error('Cannot establish preview runtime ownership');
    }

    // SQL permission does not prove external ownership. A different/absent
    // flow label protects both the shared runtime and the clone it may use.
    const canRemoveResources = runtimeState.status === 'not_found' || runtimeState.labels?.[FLOW_LABEL] === flowId;
    let disposition;
    if (canRemoveResources) {
      const removal = await runtime.remove(runtimeConfig, intent, {
        stopTimeoutSec: require('../docker').STAGING_STOP_GRACE_SEC,
      });
      if (removal?.removed === false) {
        throw new Error(removal.error || 'Preview runtime removal failed');
      }
      // Same-SHA generations share this clone. Hold the same resource lock as
      // every builder until deletion finishes; a successor cannot start restoring.
      await db.dropDatabase(intent.dbName, { strict: true });
      disposition = 'removed';
    } else {
      disposition = 'replaced';
    }

    const completion = await owner.apply({
      type: 'PreviewCleanupCompleted',
      actionId: randomUUID(),
      sessionId,
      flowId,
      disposition,
    });
    if (!completion.decision.accepted) {
      throw new Error(`Preview cleanup completion rejected: ${completion.decision.reason}`);
    }
    return { disposition };
  }

  async function sweep({ pool, config, limit = 25 }) {
    const activation = require('./activation');
    // The admission flag must not disable the owner of already accepted work.
    try {
      await activation.recover({ pool, config, limit });
    } catch (error) {
      log.warn('preview-activation', 'Recovery scan failed; cleanup obligations remain independent', { err: error.message });
    }

    const requestedLimit = Number(limit);
    const batchSize = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
      : 25;

    // Move selected obligations to the back in one committed statement before
    // acquiring runtime locks or doing I/O. Failures, busy resources and process
    // death cannot pin the oldest batch at the front. A database sequence orders
    // new arrivals/retries without relying on clocks or a process-local cursor.
    // This statement locks only resource rows; it never then locks a session.
    // Completed isolated attempts remain tombstones: absence is an observation,
    // not proof that all external creation ended. Revisit them fairly, even
    // after aggregate deletion or disabled admission. No time-based expiry.
    // The publication filter only avoids unnecessary attempts. Retirement is
    // authorized again under aggregate/resource locks, after this selection.
    const { rows: obligations } = await pool.query(`WITH candidates AS (
      SELECT r.flow_id FROM preview_flow_resources r LEFT JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.intent IS NOT NULL
          AND r.preparation_owner IS DISTINCT FROM 'bounded'
          AND (r.cleanup_completed_at IS NULL OR r.intent->>'attemptId' IS NOT NULL)
          AND NOT (r.published_at IS NOT NULL
            AND s.staging_url IS NOT DISTINCT FROM r.receipt->>'stagingUrl'
            AND s.staging_runtime_kind IS NOT DISTINCT FROM r.receipt->>'runtimeKind'
            AND s.staging_runtime_name IS NOT DISTINCT FROM r.receipt->>'runtimeName'
            AND s.staging_commit_sha IS NOT DISTINCT FROM r.receipt->>'commitSha')
        ORDER BY r.cleanup_queue_position LIMIT $1 FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE preview_flow_resources r SET cleanup_queue_position = DEFAULT
      FROM candidates c WHERE r.flow_id = c.flow_id RETURNING r.flow_id, r.session_id, r.intent`, [batchSize]);

    const results = [];
    for (const obligation of obligations) {
      const runtimeConfig = { ...config, appRuntime: obligation.intent.runtimeKind };
      const cleanupWithBuildLock = () => lock(
        runtimeConfig,
        STAGING_BUILD_LOCK,
        obligation.session_id,
        () => underBuildLock({
          pool,
          config,
          sessionId: obligation.session_id,
          flowId: obligation.flow_id,
        }),
        { allRuntimes: true, tryOnly: true },
      );

      try {
        // Same ordering as the Kubernetes build: lifecycle, then build resource.
        // Do not wait behind a live phase or cancel its check consumers.
        let result;
        if (lifecycle.enabled(runtimeConfig)) {
          result = await lock(runtimeConfig, PREVIEW_LIFECYCLE_LOCK, obligation.session_id,
            cleanupWithBuildLock, { tryOnly: true });
        } else {
          result = await cleanupWithBuildLock();
        }
        results.push(result);
      } catch (err) {
        log.warn('preview-cleanup', 'Resource cleanup remains pending', {
          flowId: obligation.flow_id,
          sessionId: obligation.session_id,
          err: err.message,
        });
        results.push({ pending: true });
      }
    }
    return results;
  }

  let timer = null;
  let inFlight = null;

  function start({ pool, config, intervalMs = 60000 }) {
    if (timer) return inFlight;
    const runSweep = () => {
      if (inFlight) return inFlight;
      inFlight = sweep({ pool, config })
        .catch(err => log.warn('preview-cleanup', 'Cleanup sweep deferred', { err: err.message }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
    timer = setInterval(runSweep, intervalMs);
    timer.unref();
    return runSweep();
  }

  async function stop() {
    clearInterval(timer);
    timer = null;
    await inFlight;
  }

  return { underBuildLock, sweep, start, stop };
}

module.exports = { FLOW_LABEL, createCleanup, ...createCleanup() };
