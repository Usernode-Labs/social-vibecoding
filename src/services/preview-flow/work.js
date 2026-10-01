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
const PREPARE_CLONE = 'native-preview-template-prepare';
const PREPARE_IMAGE = 'native-preview-kpack-prepare';
const RETIRE = 'native-preview-retire';

function createPreviewWork(pool, config, {
  store = createExecutionStore(pool),
  owner = createPreviewFlow(pool),
  lock = require('../build-retention-guard').withResourceUse,
  inspect = require('./candidate-runtime').observePreparedCandidate,
  prepare = require('../staging').prepareCandidateUnderBuildLock,
  cleanup = require('./cleanup').underBuildLock,
  clones = require('./clone-operation').createCloneOperations(),
  images = require('./image-build-operation').createImageBuildOperations(),
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
        const recoverClone = config.nativePreviewRecoverableClone === true;
        const recoverImage = config.nativePreviewRecoverableBuild === true;
        if (recoverImage && !recoverClone) throw new Error('Recoverable image preparation requires the recoverable clone');
        let workflow = PREPARE;
        if (recoverClone) workflow = PREPARE_CLONE;
        if (recoverImage) workflow = PREPARE_IMAGE;
        const intent = {
          ...candidateResources(config, session.id, flow.attemptId),
          ...(recoverClone ? {
            cloneOperation: {
              kind: 'template-v1',
              sourceDb: require('../db-manager').appDbName(app.slug),
            },
          } : {}),
          ...(recoverImage ? {
            buildOperation: require('./image-build-intent').reserveImageBuild(config, app, flow.headSha),
          } : {}),
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
          workflow,
          version: 1,
          causedBy: action.actionId,
          input: {
            identity: { flowId: flow.id, generation: flow.generation, headSha: flow.headSha },
            intent,
            app: { id: app.id, slug: app.slug, repo_url: app.repo_url },
            session: { id: session.id, branch_name: session.branch_name, pr_number: session.pr_number },
            preparedActionId: randomUUID(),
            failedActionId: randomUUID(),
            ...(recoverClone ? { clonePreparedActionId: randomUUID() } : {}),
            ...(recoverImage ? { imageBuiltActionId: randomUUID() } : {}),
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

      const recoverImage = attempt.workflow === PREPARE_IMAGE;
      const recoverClone = attempt.workflow === PREPARE_CLONE || recoverImage;
      const observed = await inspect(resourceConfig, intent, identity.flowId, identity.headSha);
      const adoptable = observed.receipt && state.resource.clonePrepared;
      if (adoptable) {
        let observedReceipt = candidateReceipt.parse(observed.receipt);

        if (recoverClone) {
          const clone = await clones.inspect(intent);
          if (clone.status === 'uncertain' && clone.reason === 'busy') return cloneDeferred(attempt);
          if (clone.status !== 'complete') return retired(attempt, 'clone_completion_unconfirmed');
        }

        if (recoverImage) {
          // Deployment was authorized only after this image fact committed.
          // Runtime health alone cannot establish the candidate's provenance.
          if (!state.resource.intent.buildOperation.receipt) {
            return retired(attempt, 'image_completion_unconfirmed');
          }
          const image = await images.inspect(state.resource.intent);
          if (image.status === 'uncertain' && image.reason === 'ownership_conflict') {
            return retired(attempt, 'image_ownership_changed');
          }
          if (image.status !== 'succeeded') return imageDeferred(attempt);
          if (attempt.checkpoint.imageUid && attempt.checkpoint.imageUid !== image.uid) {
            return retired(attempt, 'image_ownership_changed');
          }
          const matchingRuntime = observedReceipt.runtimeKind === intent.runtimeKind
            && observedReceipt.runtimeName === intent.runtimeName
            && observedReceipt.attemptId === intent.attemptId
            && observedReceipt.commitSha === identity.headSha;
          if (!matchingRuntime) return retired(attempt, 'runtime_identity_mismatch');
          if (observedReceipt.imageRef !== image.imageRef) return retired(attempt, 'runtime_image_mismatch');
          if (observedReceipt.buildRef !== null && observedReceipt.buildRef !== image.buildRef) {
            return retired(attempt, 'runtime_build_mismatch');
          }

          // The real runtime observer does not know the Build. Join its
          // healthy runtime identity to the independently verified output.
          observedReceipt = candidateReceipt.parse({ ...observedReceipt, buildRef: image.buildRef });
        }

        const receipt = state.resource.receipt || observedReceipt;
        const changedRuntime = receipt.physicalId !== observedReceipt.physicalId
          || receipt.imageRef !== observedReceipt.imageRef;
        const changedProvenance = recoverImage && (
          receipt.buildRef !== observedReceipt.buildRef
          || receipt.commitSha !== observedReceipt.commitSha
          || receipt.attemptId !== observedReceipt.attemptId
          || receipt.runtimeKind !== observedReceipt.runtimeKind
          || receipt.runtimeName !== observedReceipt.runtimeName
        );
        if (changedRuntime || changedProvenance) {
          throw Object.assign(new Error('Candidate observation conflicts with its receipt'), { permanent: true });
        }
        await owner.recordRuntime(attempt.session_id, identity.flowId, receipt);
        return prepared(receipt, attempt);
      }
      const runtimeStarted = recoverClone ? attempt.checkpoint.runtimeCreationStarted : attempt.checkpoint.creationStarted;
      if (runtimeStarted || observed.present || (!recoverClone && state.resource.clonePrepared)) {
        return retired(attempt, 'preparation_incomplete');
      }

      const resource = (await pool.query(`SELECT clone_credential_enc FROM preview_flow_resources
        WHERE flow_id = $1 AND session_id = $2`, [identity.flowId, attempt.session_id])).rows[0];
      const password = decrypt(resource?.clone_credential_enc, config.dataEncryptionKey);
      if (!password) throw Object.assign(new Error('Reserved clone credential is unavailable'), { permanent: true });
      if (recoverClone) {
        const cloneResult = await prepareClone(context, password);
        if (cloneResult) return cloneResult;
      }

      if (!recoverImage) {
        const saved = await checkpoint({
          creationStarted: true,
          ...(recoverClone ? { runtimeCreationStarted: true } : {}),
        });
        if (saved.lostClaim || signal.aborted) return { outcome: 'retry' };
      }

      // The image-aware path may repeat source fetch and Build observation.
      // Its runtime-start checkpoint still makes deployment a one-shot phase.
      let result;
      try {
        result = await prepare(resourceConfig, session, app, identity.headSha, {
          intent,
          password,
          preparationOwner: 'bounded',
          ...(recoverClone ? { preparedClone: true } : {}),
          ...(recoverImage ? {
            prepareImage: runScript => prepareImage(context, runScript),
            onRuntimeStarting: () => startCandidateRuntime(context),
          } : {}),
          async onClonePrepared() {
            if (!recoverClone) await owner.markClonePrepared(attempt.session_id, identity.flowId);
          },
        }, identity);
      } catch (error) {
        if (!error.previewImageOutcome) throw error;
        const latest = (await store.read(attempt.id)).checkpoint;
        if (error.previewImageOutcome === 'waiting') return imageDeferred({ ...attempt, checkpoint: latest });
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
      return prepared(receipt, attempt);
    });
  }

  function cloneDeferred(attempt) {
    return { outcome: 'waiting', checkpoint: attempt.checkpoint, code: 'clone_uncertain', delayMs: 1000 };
  }

  function imageDeferred(attempt) {
    return { outcome: 'waiting', checkpoint: attempt.checkpoint, code: 'image_pending', delayMs: 1000 };
  }

  function imageExit(code, outcome = 'retired', detail) {
    return Object.assign(new Error('Candidate image preparation did not complete'), {
      previewImageOutcome: outcome,
      code,
      detail,
    });
  }

  async function startCandidateRuntime({ attempt, signal, checkpoint }) {
    const { identity, intent } = attempt.input;
    const permission = await owner.apply({
      type: 'RequestCandidateRuntime',
      actionId: randomUUID(),
      sessionId: attempt.session_id,
      ...identity,
      operationId: intent.attemptId,
    });
    if (!permission.decision.accepted) throw imageExit('runtime_not_authorized');
    const prior = (await store.read(attempt.id)).checkpoint;
    const saved = await checkpoint({ ...prior, runtimeCreationStarted: true });
    if (saved.lostClaim || signal.aborted) throw imageExit('claim_lost', 'waiting');
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

  function prepared(receipt, attempt) {
    return {
      outcome: 'succeeded',
      checkpoint: {
        creationStarted: true,
        ...([PREPARE_CLONE, PREPARE_IMAGE].includes(attempt.workflow) ? { runtimeCreationStarted: true } : {}),
      },
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
      [PREPARE_CLONE]: { version: 1, run: runPreparation, commit: commitPreparation },
      [PREPARE_IMAGE]: { version: 1, run: runPreparation, commit: commitPreparation },
      [RETIRE]: { version: 1, run: runCleanup },
    },
  };
}

module.exports = { createPreviewWork, PREPARE, PREPARE_CLONE, PREPARE_IMAGE, RETIRE };
