'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../decision-runtime');
const { createExecutionStore } = require('../execution/store');
const { createPreviewFlow } = require('./store');
const { candidateResources } = require('./candidate-resources');
const { candidateReceipt } = require('./actions');
const { nativeHeadCondition } = require('./enabling-conditions');
const { encrypt, decrypt } = require('../secrets');
const { STAGING_BUILD_LOCK, PREVIEW_LIFECYCLE_LOCK } = require('../advisory-locks');

const PREPARE = 'native-preview-prepare';
const RETIRE = 'native-preview-retire';

function createPreviewWork(pool, config, {
  store = createExecutionStore(pool),
  owner = createPreviewFlow(pool),
  lock = require('../build-retention-guard').withResourceUse,
  inspect = require('./candidate-runtime').observePreparedCandidate,
  prepare = require('../staging').prepareCandidateUnderBuildLock,
  cleanup = require('./cleanup').underBuildLock,
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);

  async function request(action) {
    if (config.nativePreviewWorkerEnabled !== true || !require('./activation').enabled(config)) {
      throw new Error('Durable native preview admission is experimentally disabled');
    }
    if (action.type !== 'RequestCandidatePreview') throw new Error('Native candidate request required');

    return runtime.transact(async transaction => {
      const admission = await owner.applyInTransaction(transaction, action);
      if (!admission.decision.accepted) return admission;
      const effect = admission.decision.effects.find(value => value.type === 'BuildPreview');
      const existing = await store.find(transaction, action.sessionId, effect.effectKey);
      if (existing) return { ...admission, work: existing };
      if (admission.replayed) throw new Error('Cannot enroll an already accepted synchronous preparation');

      return transaction.withSession(action.sessionId, async client => {
        const session = (await client.query('SELECT * FROM chat_sessions WHERE id = $1', [action.sessionId])).rows[0];
        const app = (await client.query('SELECT * FROM apps WHERE id = $1', [session.app_id])).rows[0];
        if (session.source !== 'cli_handoff' || !app?.repo_url) {
          throw new Error('This experiment accepts native CLI handoff preparation only');
        }
        const flow = admission.decision.flow;
        const intent = candidateResources(config, session.id, flow.attemptId);
        const credentialEnc = encrypt(randomBytes(24).toString('hex'), config.dataEncryptionKey);
        await owner.reserveCandidateInTransaction(transaction, session.id, flow.id, intent, {
          credentialEnc,
          preparationOwner: 'bounded',
        });
        const work = await store.enqueue(transaction, {
          id: randomUUID(),
          effectKey: effect.effectKey,
          sessionId: session.id,
          workflow: PREPARE,
          version: 1,
          causedBy: action.actionId,
          input: {
            identity: { flowId: flow.id, generation: flow.generation, headSha: flow.headSha },
            intent,
            app: { id: app.id, slug: app.slug, repo_url: app.repo_url },
            session: { id: session.id, branch_name: session.branch_name, pr_number: session.pr_number },
            preparedActionId: randomUUID(),
            failedActionId: randomUUID(),
          },
        });
        return { ...admission, work };
      });
    });
  }

  async function admitCleanup(transaction, sessionId, flowId) {
    // One recurring obligation retains this attempt's tombstone. Each actual
    // deletion pass obtains fresh domain permission and external ownership.
    const effectKey = `${flowId}:bounded-cleanup`;
    const existing = await store.find(transaction, sessionId, effectKey);
    if (existing) return existing;
    const actionId = randomUUID();
    const admission = await owner.applyInTransaction(transaction, {
      type: 'RequestPreviewCleanup', actionId, sessionId, flowId,
    });
    if (!admission.decision.accepted || !admission.decision.effects.length) return null;
    return store.enqueue(transaction, {
      id: randomUUID(),
      effectKey,
      sessionId,
      workflow: RETIRE,
      version: 1,
      causedBy: actionId,
      input: { flowId, intent: admission.current.resource.intent },
    });
  }

  async function census(limit = 25) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid census batch size');
    // Rotate before I/O, including protected/busy resources. No aggregate is
    // acquired while holding this selection's resource locks.
    const { rows } = await pool.query(`WITH selected AS (
      SELECT flow_id FROM preview_flow_resources WHERE preparation_owner = 'bounded'
      ORDER BY cleanup_queue_position LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE preview_flow_resources r SET cleanup_queue_position = DEFAULT
      FROM selected s WHERE r.flow_id = s.flow_id RETURNING r.flow_id, r.session_id`, [limit]);
    const results = [];
    for (const row of rows) {
      try {
        results.push(await runtime.transact(transaction => admitCleanup(transaction, row.session_id, row.flow_id)));
      } catch {
        // The rotated obligation remains discoverable on the next census.
        results.push({ pending: true });
      }
    }
    return results;
  }

  async function guarded(attempt, run) {
    const intent = attempt.input.intent;
    const resourceConfig = intent ? {
      ...config,
      appRuntime: intent.runtimeKind,
      kubernetes: { ...config.kubernetes, appNamespace: intent.namespace },
    } : config;
    const underBuildLock = () => lock(resourceConfig, STAGING_BUILD_LOCK, attempt.session_id,
      () => run(resourceConfig), { allRuntimes: true, tryOnly: true });
    const result = require('../preview-lifecycle').enabled(resourceConfig)
      ? await lock(resourceConfig, PREVIEW_LIFECYCLE_LOCK, attempt.session_id, underBuildLock, { tryOnly: true })
      : await underBuildLock();
    return result?.busy
      ? { outcome: 'waiting', checkpoint: attempt.checkpoint, code: 'resource_busy', delayMs: 1000 }
      : result;
  }

  async function runPreparation(context) {
    const { attempt, signal, checkpoint } = context;
    const { identity, intent, app, session } = attempt.input;
    return guarded(attempt, async resourceConfig => {
      if (signal.aborted) return { outcome: 'retry' };
      const state = await owner.read(attempt.session_id);
      const current = state.flow?.id === identity.flowId
        && !nativeHeadCondition(state.session, state.flow.startedStatus, identity.headSha)
        && ['preparing', 'candidate'].includes(state.flow.state)
        && !state.resource?.cleanupStarted;
      if (!current) return retired(attempt, 'preparation_obsolete');

      const observed = await inspect(resourceConfig, intent, identity.flowId, identity.headSha);
      const adoptable = observed.receipt && state.resource.clonePrepared;
      if (adoptable) {
        const receipt = state.resource.receipt || candidateReceipt.parse(observed.receipt);
        if (receipt.physicalId !== observed.receipt.physicalId || receipt.imageRef !== observed.receipt.imageRef) {
          throw Object.assign(new Error('Candidate observation conflicts with its receipt'), { permanent: true });
        }
        await owner.recordRuntime(attempt.session_id, identity.flowId, receipt);
        return prepared(receipt);
      }
      if (attempt.checkpoint.creationStarted || observed.present || state.resource.clonePrepared) {
        return retired(attempt, 'preparation_incomplete');
      }

      const resource = (await pool.query(`SELECT clone_credential_enc FROM preview_flow_resources
        WHERE flow_id = $1 AND session_id = $2`, [identity.flowId, attempt.session_id])).rows[0];
      const password = decrypt(resource?.clone_credential_enc, config.dataEncryptionKey);
      if (!password) throw Object.assign(new Error('Reserved clone credential is unavailable'), { permanent: true });
      const saved = await checkpoint({ creationStarted: true });
      if (saved.lostClaim || signal.aborted) return { outcome: 'retry' };

      // The opaque adapter is invoked once per domain resource attempt. After
      // an uncertain outcome, the next execution inspects or retires it.
      const result = await prepare(resourceConfig, session, app, identity.headSha, {
        intent,
        password,
        preparationOwner: 'bounded',
        onClonePrepared: () => owner.markClonePrepared(attempt.session_id, identity.flowId),
      }, identity);
      const receipt = candidateReceipt.parse({
        commitSha: result.commitSha,
        stagingUrl: result.stagingUrl,
        runtimeKind: result.runtimeKind,
        runtimeName: result.runtimeName,
        containerId: result.containerId,
        imageRef: result.imageRef,
        buildRef: result.buildRef ?? null,
        physicalId: result.physicalId,
        attemptId: intent.attemptId,
      });
      await owner.recordRuntime(attempt.session_id, identity.flowId, receipt);
      return prepared(receipt);
    });
  }

  function prepared(receipt) {
    return {
      outcome: 'succeeded',
      checkpoint: { creationStarted: true },
      result: { prepared: true, receipt },
    };
  }

  function retired(attempt, code) {
    return { outcome: 'succeeded', checkpoint: attempt.checkpoint, result: { prepared: false }, code };
  }

  async function commitPreparation(transaction, attempt, proposed) {
    if (proposed.outcome !== 'succeeded') return proposed;
    const { identity, preparedActionId, failedActionId } = attempt.input;
    const action = proposed.result.prepared ? {
      type: 'PreviewCandidatePrepared',
      actionId: preparedActionId,
      receipt: proposed.result.receipt,
    } : {
      type: 'PreparationFailed',
      actionId: failedActionId,
      detail: 'Durable preview preparation was interrupted or superseded; request a fresh attempt.',
    };
    const completion = await owner.applyInTransaction(transaction, {
      ...action, sessionId: attempt.session_id, ...identity,
    });
    if (!proposed.result.prepared || !completion.decision.accepted) {
      await admitCleanup(transaction, attempt.session_id, identity.flowId);
    }
    return { ...proposed, result: { ...proposed.result, accepted: completion.decision.accepted, reason: completion.decision.reason } };
  }

  async function runCleanup({ attempt, signal }) {
    return guarded(attempt, async () => {
      if (signal.aborted) return { outcome: 'retry' };
      await cleanup({ pool, config, sessionId: attempt.session_id, flowId: attempt.input.flowId });
      // Absence is not creator termination. Retain and revisit this obligation.
      return { outcome: 'waiting', code: 'tombstone_retained', delayMs: 60000 };
    });
  }

  return {
    request,
    census,
    store,
    handlers: {
      [PREPARE]: { version: 1, run: runPreparation, commit: commitPreparation },
      [RETIRE]: { version: 1, run: runCleanup },
    },
  };
}

module.exports = { createPreviewWork, PREPARE, RETIRE };
