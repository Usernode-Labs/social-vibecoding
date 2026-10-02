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

const PREPARE_RUNTIME = 'native-preview-kubernetes-prepare';
const RETIRE = 'native-preview-retire';

function createPreviewWork(pool, config, {
  store = createExecutionStore(pool),
  owner = createPreviewFlow(pool),
  lock = require('../build-retention-guard').withResourceUse,
  prepare = require('../staging').prepareCandidateUnderBuildLock,
  cleanup = require('./cleanup').underBuildLock,
  clones = require('./clone-operation').createCloneOperations(),
  images = require('./image-build-operation').createImageBuildOperations(),
  runtimes = require('./runtime-operation').createRuntimeOperations({ dataKey: config.dataEncryptionKey }),
  candidateAccepted = null,
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);

  async function request(action) {
    return runtime.transact(transaction => requestInTransaction(transaction, action));
  }

  async function requestInTransaction(transaction, action) {
    if (config.nativeCliPreviewHandoffEnabled !== true) {
      throw new Error('Durable native preview admission is experimentally disabled');
    }
    if (action.type !== 'RequestCandidatePreview') throw new Error('Native candidate request required');

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
      const intent = {
        ...candidateResources(config, session.id, flow.attemptId),
        cloneOperation: {
          kind: 'template-v1',
          sourceDb: require('../db-manager').appDbName(app.slug),
        },
        buildOperation: require('./image-build-intent').reserveImageBuild(config, app, flow.headSha),
        runtimeOperation: {
          kind: 'kubernetes-v1',
          resources: {},
        },
      };
      const credentialEnc = encrypt(randomBytes(24).toString('hex'), config.dataEncryptionKey);
      await owner.reserveCandidateInTransaction(transaction, session.id, flow.id, intent, {
        credentialEnc,
        preparationOwner: 'bounded',
      });
      const work = await store.enqueue(transaction, {
        id: randomUUID(),
        effectKey: effect.effectKey,
        sessionId: session.id,
        workflow: PREPARE_RUNTIME,
        version: 1,
        causedBy: action.actionId,
        input: {
          identity: {
            flowId: flow.id,
            generation: flow.generation,
            headSha: flow.headSha,
          },
          intent,
          app: {
            id: app.id,
            slug: app.slug,
            repo_url: app.repo_url,
          },
          session: {
            id: session.id,
            branch_name: session.branch_name,
            pr_number: session.pr_number,
          },
          preparedActionId: randomUUID(),
          failedActionId: randomUUID(),
          clonePreparedActionId: randomUUID(),
          imageBuiltActionId: randomUUID(),
        },
      });
      return { ...admission, work };
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
    const { attempt, signal } = context;
    const { identity, intent, app, session } = attempt.input;
    return guarded(attempt, async resourceConfig => {
      if (signal.aborted) return { outcome: 'retry' };
      const state = await owner.read(attempt.session_id);
      const current = state.flow?.id === identity.flowId
        && !nativeHeadCondition(state.session, state.flow.startedStatus, identity.headSha)
        && ['preparing', 'candidate'].includes(state.flow.state)
        && !state.resource?.cleanupStarted;
      if (!current) return retired(attempt, 'preparation_obsolete');

      // New work has one complete contract. Once the desired runtime is
      // persisted, recovery reconciles it directly instead of repeating staging.
      if (state.resource.intent.runtimeOperation.desired) {
        return resumeCandidateRuntime(context, resourceConfig, state.resource.intent);
      }

      const resource = (await pool.query(`SELECT clone_credential_enc FROM preview_flow_resources
        WHERE flow_id = $1 AND session_id = $2`, [identity.flowId, attempt.session_id])).rows[0];
      const password = decrypt(resource?.clone_credential_enc, config.dataEncryptionKey);
      if (!password) throw Object.assign(new Error('Reserved clone credential is unavailable'), { permanent: true });

      // Staging validates pinned source before invoking each named operation.
      const candidate = {
        intent,
        password,
        preparationOwner: 'bounded',
        prepareClone: () => prepareCloneForStaging(context, password),
        prepareImage: runScript => prepareImage(context, runScript),
        prepareRuntime: params => selectAndPrepareRuntime(context, resourceConfig, params),
      };

      let result;
      try {
        result = await prepare(resourceConfig, session, app, identity.headSha, candidate, identity);
      } catch (error) {
        if (error.previewPreparationOutcome) return error.previewPreparationOutcome;
        if (!error.previewImageOutcome) throw error;
        const latest = (await store.read(attempt.id)).checkpoint;
        if (error.previewImageOutcome === 'waiting') {
          const waiting = { ...attempt, checkpoint: latest };
          return error.code.startsWith('runtime_') ? runtimeDeferred(waiting, error.code) : imageDeferred(waiting);
        }
        return {
          ...retired({ ...attempt, checkpoint: latest }, error.code),
          result: { prepared: false, ...(error.detail ? { detail: error.detail } : {}) },
        };
      }
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

  function runtimeDeferred(attempt, code) {
    return { outcome: 'waiting', checkpoint: attempt.checkpoint, code, delayMs: 1000 };
  }

  async function runtimeContext(context) {
    const { attempt, signal } = context;
    const { identity, intent } = attempt.input;
    const envelope = {
      sessionId: attempt.session_id,
      ...identity,
      operationId: intent.attemptId,
    };
    return {
      signal,
      async read() {
        return owner.readResourceIntent(attempt.session_id, identity.flowId);
      },
      async authorize(resource) {
        if (signal.aborted) return null;
        const result = await owner.apply({
          type: 'RequestCandidateRuntimeResourceCreation',
          actionId: randomUUID(),
          ...envelope,
          resource,
        });
        return result.decision.effects.find(effect => effect.type === 'CreateCandidateRuntimeResource')?.intent || null;
      },
      async observe(resource, uid) {
        const result = await owner.apply({
          type: 'CandidateRuntimeResourceObserved',
          actionId: randomUUID(),
          ...envelope,
          resource,
          uid,
        });
        return result.decision.accepted;
      },
    };
  }

  async function runtimeReceiptFor(context, resourceConfig, intent) {
    const observed = await runtimes.prepare(resourceConfig, intent, await runtimeContext(context));
    if (observed.reason === 'ownership_conflict') throw imageExit('runtime_ownership_conflict');
    if (observed.status !== 'healthy') throw imageExit(`runtime_${observed.reason || 'pending'}`, 'waiting');
    return candidateReceipt.parse({
      runtimeKind: 'kubernetes',
      runtimeName: intent.runtimeName,
      containerId: null,
      physicalId: observed.physicalId,
      attemptId: intent.attemptId,
      commitSha: intent.runtimeOperation.desired.headSha,
      imageRef: intent.runtimeOperation.desired.imageRef,
      buildRef: `${intent.buildOperation.namespace}/sv-p-${intent.attemptId.replace(/-/g, '')}`,
      stagingUrl: require('../application-runtime').appOrigin(resourceConfig, intent),
    });
  }

  async function selectAndPrepareRuntime(context, resourceConfig, params) {
    const { attempt } = context;
    const state = await owner.read(attempt.session_id);
    const desired = state.resource.intent.runtimeOperation.desired
      || require('./runtime-intent').selectRuntime(resourceConfig, attempt.input.identity, params);
    const permission = await owner.apply({
      type: 'RequestCandidateRuntimePreparation',
      actionId: randomUUID(),
      sessionId: attempt.session_id,
      ...attempt.input.identity,
      operationId: attempt.input.intent.attemptId,
      desired,
    });
    if (!permission.decision.accepted) throw imageExit('runtime_not_authorized');
    const receipt = await runtimeReceiptFor(context, resourceConfig, permission.current.resource.intent);
    return { ...receipt, url: receipt.stagingUrl, hostname: new URL(receipt.stagingUrl).hostname };
  }

  async function resumeCandidateRuntime(context, resourceConfig, intent) {
    const { attempt } = context;
    const clone = await clones.inspect(intent);
    if (clone.status === 'uncertain' && clone.reason === 'busy') return cloneDeferred(attempt);
    if (clone.status !== 'complete') return retired(attempt, 'clone_completion_unconfirmed');
    const image = await images.inspect(intent);
    if (image.reason === 'ownership_conflict') return retired(attempt, 'image_ownership_changed');
    if (image.status !== 'succeeded') return imageDeferred(attempt);
    if (image.uid !== intent.buildOperation.receipt?.uid || image.imageRef !== intent.runtimeOperation.desired.imageRef) {
      return retired(attempt, 'image_ownership_changed');
    }
    try {
      const receipt = await runtimeReceiptFor(context, resourceConfig, intent);
      await owner.recordRuntime(attempt.session_id, attempt.input.identity.flowId, receipt);
      return prepared(receipt);
    } catch (error) {
      if (!error.previewImageOutcome) throw error;
      if (error.previewImageOutcome === 'waiting') return runtimeDeferred(attempt, error.code);
      return retired(attempt, error.code);
    }
  }

  function cloneDeferred(attempt) {
    return { outcome: 'waiting', checkpoint: attempt.checkpoint, code: 'clone_uncertain', delayMs: 1000 };
  }

  function imageDeferred(attempt) {
    return { outcome: 'waiting', checkpoint: attempt.checkpoint, code: 'image_pending', delayMs: 1000 };
  }

  function imageExit(code, outcome = 'retired', detail) {
    return Object.assign(new Error('Candidate preparation did not complete'), {
      previewImageOutcome: outcome,
      code,
      detail,
    });
  }

  async function prepareImage({ attempt, signal, checkpoint }, runScript) {
    const { identity, intent, imageBuiltActionId } = attempt.input;
    if (signal.aborted) throw imageExit('claim_lost', 'waiting');
    const authorized = await owner.apply({
      type: 'RequestCandidateImageBuild',
      actionId: randomUUID(),
      sessionId: attempt.session_id,
      ...identity,
      operationId: intent.attemptId,
      runScript,
    });
    if (!authorized.decision.accepted) throw imageExit('image_not_authorized');
    const effect = authorized.decision.effects.find(value => value.type === 'PrepareCandidateImage');
    const prior = (await store.read(attempt.id)).checkpoint;
    const image = await images.prepare(effect.intent, {
      submitted: !!prior.imageSubmitted,
      uid: prior.imageUid,
      checkpoint(value) {
        if (signal.aborted) return { lostClaim: true };
        return checkpoint({
          ...prior,
          imageSubmitted: value.submitted,
          ...(value.uid ? { imageUid: value.uid } : {}),
        });
      },
    });
    if (image.status === 'failed') {
      throw imageExit(`image_failed_${image.failureKind}`, 'retired', imageFailureDetail(image.failureKind));
    }
    if (['ownership_conflict', 'submitted_resource_missing'].includes(image.reason)) {
      throw imageExit(`image_${image.reason}`);
    }
    if (image.status !== 'succeeded' || signal.aborted) throw imageExit('image_pending', 'waiting');
    const completion = await owner.apply({
      type: 'CandidateImageBuilt',
      actionId: imageBuiltActionId,
      sessionId: attempt.session_id,
      ...identity,
      operationId: intent.attemptId,
      uid: image.uid,
      imageRef: image.imageRef,
    });
    if (!completion.decision.accepted) throw imageExit('image_completion_obsolete');
    return { runtimeKind: 'kubernetes', imageRef: image.imageRef, buildRef: image.buildRef };
  }

  function imageFailureDetail(kind) {
    if (kind === 'build') {
      return 'The image build step failed. Inspect its diagnostics, fix the build and request a fresh preview attempt.';
    }
    if (kind === 'infrastructure') {
      return 'The image build ended with an infrastructure failure. A fresh preview attempt may retry it.';
    }
    return 'The image build failed, but its cause is unclassified. Inspect the retained Build before retrying.';
  }

  async function prepareClone({ attempt, signal }, password) {
    const { identity, intent, clonePreparedActionId } = attempt.input;
    const authorized = await owner.apply({
      type: 'RequestCandidateClone',
      actionId: randomUUID(),
      sessionId: attempt.session_id,
      ...identity,
      operationId: intent.attemptId,
    });
    if (!authorized.decision.accepted) return retired(attempt, 'clone_not_authorized');
    const effect = authorized.decision.effects.find(value => value.type === 'PrepareCandidateClone');
    const clone = await clones.prepare(effect.intent, password);
    if (clone.status === 'retired' || ['ownership_conflict', 'resource_missing'].includes(clone.reason)) {
      return retired(attempt, 'clone_ownership_changed');
    }
    if (clone.status !== 'complete' || signal.aborted) return cloneDeferred(attempt);

    const completion = await owner.apply({
      type: 'CandidateClonePrepared',
      actionId: clonePreparedActionId,
      sessionId: attempt.session_id,
      ...identity,
      operationId: intent.attemptId,
      databaseOid: clone.databaseOid,
    });
    if (!completion.decision.accepted) return retired(attempt, 'clone_completion_obsolete');
    return null;
  }

  async function prepareCloneForStaging(context, password) {
    const outcome = await prepareClone(context, password);
    if (outcome) {
      throw Object.assign(new Error('Candidate clone preparation did not complete'), {
        previewPreparationOutcome: outcome,
      });
    }
    return { password, via: 'recovered-template' };
  }

  function prepared(receipt) {
    return {
      outcome: 'succeeded',
      checkpoint: {},
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
      detail: proposed.result.detail || 'Durable preview preparation was interrupted or superseded; request a fresh attempt.',
    };
    const completion = await owner.applyInTransaction(transaction, {
      ...action, sessionId: attempt.session_id, ...identity,
    });
    if (proposed.result.prepared && completion.decision.accepted && candidateAccepted) {
      await candidateAccepted(transaction, attempt, completion);
    }
    if (!proposed.result.prepared || !completion.decision.accepted) {
      await admitCleanup(transaction, attempt.session_id, identity.flowId);
    }
    return { ...proposed, result: { ...proposed.result, accepted: completion.decision.accepted, reason: completion.decision.reason } };
  }

  async function runCleanup({ attempt, signal }) {
    return guarded(attempt, async () => {
      if (signal.aborted) return { outcome: 'retry' };
      const result = await cleanup({ pool, config, sessionId: attempt.session_id, flowId: attempt.input.flowId });
      // Absence is not creator termination. Retain and revisit this obligation.
      return { outcome: 'waiting', code: 'tombstone_retained', delayMs: 60000, result };
    });
  }

  return {
    request,
    requestInTransaction,
    guarded,
    census,
    store,
    handlers: {
      [PREPARE_RUNTIME]: { version: 1, run: runPreparation, commit: commitPreparation },
      [RETIRE]: { version: 1, run: runCleanup },
    },
  };
}

module.exports = { createPreviewWork, PREPARE_RUNTIME, RETIRE };
