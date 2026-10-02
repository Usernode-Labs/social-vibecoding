'use strict';

const { reduceLegacy, requestCleanupDecision } = require('./legacy-reducer');
const { nativeHeadCondition, enablingCondition } = require('./enabling-conditions');
const { isResourceAction } = require('./actions');

function activationPending(binding) {
  return !!binding?.desired && binding.desired.activationId !== binding.observed?.activationId;
}

function rejection(state, reason) {
  return {
    accepted: false,
    reason,
    flow: state.flow,
    projection: 'unchanged',
    effects: [],
  };
}

function candidateCondition(state, action) {
  const { flow, resource } = state;
  if (!flow?.attemptId || flow.id !== action.flowId || flow.generation !== action.generation
      || flow.headSha !== action.headSha) {
    return 'superseded_flow';
  }
  if (resource?.cleanupStarted) return 'resource_retiring';
  return nativeHeadCondition(state.session, flow.startedStatus, action.headSha);
}

function predecessorConsumersReleased(state) {
  const resource = state.resource;
  const evidence = state.retirementEvidence;
  if (resource?.preparationOwner !== 'bounded' || !resource.intent?.runtimeOperation?.desired
      || !evidence || evidence.pendingRunIds.length) return false;

  for (const consumer of Object.values(resource.consumerReleases || {})) {
    const { retirement, requirements } = consumer;
    if (consumer.headSha !== resource.receipt?.commitSha || !requirements
        || !retirement || retirement.version !== 1
        || !retirement.jobs.every(job => job.stage === 'released')) return false;
    const released = kind => retirement.jobs.some(job => job.kind === kind);
    if ((requirements.captureRequired && !released('capture'))
        || (requirements.unitRequired && !released('unit-suite'))) return false;
  }

  const preparation = evidence.work.filter(work => work.workflow === 'native-preview-kubernetes-prepare');
  if (preparation.length !== 1) return false;
  const work = preparation[0];
  if (work.version !== 1 || work.status !== 'succeeded'
      || work.input.identity.flowId !== resource.flowId
      || work.input.identity.headSha !== resource.receipt?.commitSha
      || work.input.intent.attemptId !== resource.intent.attemptId) return false;

  const continuations = evidence.work.filter(work => work.workflow === 'native-cli-preview-continuation');
  return continuations.length > 0 && continuations.every(work => work.version === 1
    && work.status === 'succeeded' && work.input.flowId === resource.flowId
    && work.input.headSha === resource.receipt.commitSha);
}

function reduceCandidate(state, action, facts) {
  const runtimeDecision = require('./runtime-reducer').reduceRuntime(state, action);
  if (runtimeDecision) return runtimeDecision;

  const { flow, resource, binding } = state;

  const imageRequest = action.type === 'RequestCandidateImageBuild';
  const imageReport = action.type === 'CandidateImageBuilt';
  const runtimeRequest = action.type === 'RequestCandidateRuntime';
  if (imageRequest || imageReport || runtimeRequest) {
    const condition = candidateCondition(state, action);
    if (condition) return rejection(state, condition);
    if (flow.state !== 'preparing') return rejection(state, 'flow_settled');
    const operation = resource?.intent?.buildOperation;
    if (resource?.preparationOwner !== 'bounded' || !resource.clonePrepared
        || resource.intent.runtimeKind !== 'kubernetes' || operation?.kind !== 'kpack-v1'
        || operation.revision !== flow.headSha || resource.intent.attemptId !== action.operationId
        || flow.attemptId !== action.operationId) return rejection(state, 'image_operation_mismatch');

    const recipeSelected = Object.hasOwn(operation, 'runScript');
    if (imageRequest) {
      if (recipeSelected && operation.runScript !== action.runScript) return rejection(state, 'image_recipe_changed');
      const selected = { ...operation, runScript: action.runScript };
      return {
        accepted: true,
        reason: 'image_build_requested',
        flow,
        projection: 'unchanged',
        effects: [{
          type: 'PrepareCandidateImage',
          effectKey: `${action.operationId}:kpack-image`,
          causedBy: action.actionId,
          sessionId: action.sessionId,
          flowId: flow.id,
          operationId: action.operationId,
          intent: { ...resource.intent, buildOperation: selected },
        }],
        ...(!recipeSelected ? { imageChange: { flowId: flow.id, operation: selected } } : {}),
      };
    }
    if (!recipeSelected) return rejection(state, 'image_not_requested');
    if (runtimeRequest) {
      if (!operation.receipt) return rejection(state, 'image_not_complete');
      return {
        accepted: true,
        reason: 'candidate_runtime_requested',
        flow,
        projection: 'unchanged',
        effects: [{
          type: 'PrepareCandidateRuntime',
          effectKey: `${action.operationId}:candidate-runtime`,
          causedBy: action.actionId,
          sessionId: action.sessionId,
          flowId: flow.id,
          intent: resource.intent,
        }],
      };
    }

    const receipt = { uid: action.uid, imageRef: action.imageRef };
    const outputPrefix = `${operation.repository}@sha256:`;
    if (!action.imageRef.startsWith(outputPrefix) || !/^[a-f0-9]{64}$/.test(action.imageRef.slice(outputPrefix.length))) {
      return rejection(state, 'image_repository_mismatch');
    }
    if (operation.receipt && (operation.receipt.uid !== receipt.uid || operation.receipt.imageRef !== receipt.imageRef)) {
      return rejection(state, 'image_receipt_conflict');
    }
    return {
      accepted: true,
      reason: 'candidate_image_built',
      flow,
      projection: 'unchanged',
      effects: [],
      imageChange: { flowId: flow.id, operation: { ...operation, receipt } },
    };
  }

  if (action.type === 'RequestCandidateClone' || action.type === 'CandidateClonePrepared') {
    const condition = candidateCondition(state, action);
    if (condition) return rejection(state, condition);
    if (flow.state !== 'preparing') return rejection(state, 'flow_settled');
    if (resource?.preparationOwner !== 'bounded' || resource.intent?.cloneOperation?.kind !== 'template-v1'
        || resource.intent.attemptId !== action.operationId || flow.attemptId !== action.operationId) {
      return rejection(state, 'clone_operation_mismatch');
    }
    const reporting = action.type === 'CandidateClonePrepared';
    return {
      accepted: true,
      reason: reporting ? 'clone_prepared' : 'clone_requested',
      flow,
      projection: 'unchanged',
      effects: reporting ? [] : [{
        type: 'PrepareCandidateClone',
        effectKey: `${action.operationId}:template-clone`,
        causedBy: action.actionId,
        sessionId: action.sessionId,
        flowId: flow.id,
        operationId: action.operationId,
        intent: resource.intent,
      }],
      ...(reporting ? { cloneChange: { flowId: flow.id, databaseOid: action.databaseOid } } : {}),
    };
  }

  if (action.type === 'RetirePreviewPreparation') {
    const returned = state.reviewReturn;
    if (!returned?.accepted || returned.reason !== 'returned_to_development'
        || returned.change.status !== state.session?.status
        || returned.change.approvalEpoch !== state.session?.approvalEpoch) {
      return rejection(state, 'review_return_changed');
    }
    if (!flow || flow.id !== action.flowId || flow.generation !== action.generation
        || flow.headSha !== action.headSha) {
      return rejection(state, 'superseded_flow');
    }
    // Authorized activation may still finish externally. Preserve its recovery
    // owner, and every published consumer, instead of claiming cancellation.
    const bound = binding?.desired?.flowId === flow.id || binding?.observed?.flowId === flow.id;
    if (bound || resource?.published || !['preparing', 'candidate'].includes(flow.state)) {
      return { accepted: true, reason: 'preview_owner_preserved', flow, projection: 'unchanged', effects: [] };
    }
    const cleanup = resource?.intent ? requestCleanupDecision(state, action) : null;
    return {
      accepted: true,
      reason: 'preparation_retired',
      flow: { ...flow, state: 'superseded' },
      projection: 'unchanged',
      effects: cleanup?.effects || [],
      ...(cleanup?.resourceChange ? { resourceChange: cleanup.resourceChange } : {}),
    };
  }

  if (action.type === 'RequestCandidatePreview') {
    const condition = nativeHeadCondition(state.session, action.startedStatus, action.headSha);
    if (condition) return rejection(state, condition);
    if (activationPending(binding)) return rejection(state, 'activation_pending');
    // Bound unreleased published dependencies. Creator tombstones remain outside
    // this budget after their consumers/runtime/database are safely released.
    if (state.retainedPublishedAttempts >= 2) return rejection(state, 'consumer_retirement_required');

    const nextFlow = {
      id: facts.newFlowId,
      attemptId: facts.newAttemptId,
      generation: (flow?.generation || 0) + 1,
      headSha: action.headSha,
      startedStatus: action.startedStatus,
      state: 'preparing',
    };
    const decision = {
      accepted: true,
      reason: 'candidate_requested',
      flow: nextFlow,
      projection: 'unchanged',
      effects: [{
        type: 'BuildPreview',
        effectKey: `${nextFlow.id}:build`,
        causedBy: action.actionId,
        sessionId: action.sessionId,
        flowId: nextFlow.id,
        attemptId: nextFlow.attemptId,
        generation: nextFlow.generation,
        headSha: nextFlow.headSha,
      }],
    };
    if (flow) decision.supersededFlow = { ...flow, state: 'superseded' };
    return decision;
  }

  if (action.type === 'PreviewActivationObserved') {
    // Settle the authorized intent, even if a legacy status writer moved since
    // dispatch. An observation grants no new activation or mutation permission.
    const desired = binding?.desired;
    if (!desired || desired.activationId !== action.activationId || desired.flowId !== action.flowId
        || flow?.id !== action.flowId || flow.generation !== action.generation
        || flow.headSha !== action.headSha) {
      return rejection(state, 'superseded_activation');
    }
    if (!action.observation.token || (desired.receipt.runtimeKind === 'kubernetes' && !action.observation.uid)) {
      return rejection(state, 'binding_identity_missing');
    }
    if (action.observation.target !== desired.receipt.runtimeName) {
      return rejection(state, 'binding_target_mismatch');
    }
    return {
      accepted: true,
      reason: 'activation_observed',
      flow: { ...flow, state: 'ready' },
      projection: 'publish_candidate',
      receipt: desired.receipt,
      bindingChange: {
        desired,
        observed: { ...desired, route: action.observation },
      },
      effects: [],
    };
  }

  if (action.type === 'PreviewCandidatePrepared' || action.type === 'RequestPreviewActivation') {
    const condition = candidateCondition(state, action);
    if (condition) return rejection(state, condition);

    if (action.type === 'PreviewCandidatePrepared') {
      if (flow.state !== 'preparing') return rejection(state, 'flow_settled');
      if (action.receipt.attemptId !== flow.attemptId || action.receipt.commitSha !== flow.headSha) {
        return rejection(state, 'candidate_identity_mismatch');
      }
      if (!resource?.clonePrepared) return rejection(state, 'clone_not_prepared');
      const image = resource.intent?.buildOperation;
      if (image && (!image.receipt || action.receipt.imageRef !== image.receipt.imageRef
          || action.receipt.buildRef !== `${image.namespace}/sv-p-${flow.attemptId.replace(/-/g, '')}`)) {
        return rejection(state, 'candidate_image_unconfirmed');
      }
      const runtime = resource.intent?.runtimeOperation;
      if (runtime && (!runtime.desired
          || !['secret', 'service', 'deployment'].every(kind => runtime.resources[kind]?.uid)
          || action.receipt.physicalId !== runtime.resources.deployment.uid
          || action.receipt.imageRef !== runtime.desired.imageRef)) {
        return rejection(state, 'candidate_runtime_unconfirmed');
      }
      return {
        accepted: true,
        reason: 'candidate_prepared',
        flow: { ...flow, state: 'candidate' },
        projection: 'unchanged',
        effects: [],
      };
    }

    if (flow.state !== 'candidate') return rejection(state, 'candidate_not_ready');
    if (activationPending(binding)) return rejection(state, 'activation_pending');
    if (!resource?.receipt || resource.receipt.attemptId !== flow.attemptId) {
      return rejection(state, 'candidate_receipt_missing');
    }
    if (binding?.observed && (binding.observed.route.target !== action.expected.target
        || binding.observed.route.uid !== action.expected.uid)) {
      return rejection(state, 'observed_binding_changed');
    }
    const desired = {
      activationId: facts.newActivationId,
      flowId: flow.id,
      attemptId: flow.attemptId,
      receipt: { ...resource.receipt, stagingUrl: action.stagingUrl },
      expected: action.expected,
    };
    return {
      accepted: true,
      reason: 'activation_requested',
      flow: { ...flow, state: 'activating' },
      projection: 'unchanged',
      bindingChange: { desired, observed: binding?.observed || null },
      effects: [{
        type: 'ActivatePreview',
        effectKey: `${desired.activationId}:activate`,
        causedBy: action.actionId,
        sessionId: action.sessionId,
        ...desired,
      }],
    };
  }

  if (isResourceAction(action) && resource) {
    const attemptId = resource.intent?.attemptId;
    const isolatedBinding = !!binding?.desired?.attemptId;
    if (attemptId && (binding?.desired?.attemptId === attemptId || binding?.observed?.attemptId === attemptId)) {
      return rejection(state, 'resource_bound');
    }
    // Legacy consumers are not yet all represented as durable references. Keep
    // published predecessors, including the legacy resource handed over first.
    if (resource.published && (attemptId || isolatedBinding) && !predecessorConsumersReleased(state)) {
      return rejection(state, 'consumer_retirement_required');
    }

    if (action.type === 'PreviewDependenciesReleased') {
      const condition = enablingCondition(state, action);
      if (condition) return rejection(state, condition);
      if (!attemptId || resource.preparationOwner !== 'bounded') return rejection(state, 'bounded_owner_required');
      if (!resource.cleanupStarted) return rejection(state, 'cleanup_not_requested');
      return {
        accepted: true,
        reason: 'dependencies_released',
        flow,
        projection: 'unchanged',
        effects: [],
        dependenciesReleased: true,
      };
    }

    const ownsPreparation = resource.preparationOwner === 'bounded'
      && resource.flowId === flow?.id
      && ['preparing', 'candidate'].includes(flow.state)
      && !nativeHeadCondition(state.session, flow.startedStatus, flow.headSha);
    if (action.type === 'RequestPreviewCleanup' && ownsPreparation) {
      return rejection(state, 'preparation_owned');
    }

    if (attemptId && resource.cleanupCompleted && action.type === 'RequestPreviewCleanup') {
      const condition = enablingCondition(state, action);
      if (condition) return rejection(state, condition);
      // Retained locators are a tombstone. Absence cannot prove that creation
      // accepted before a crash will not finish later. Authorize another pass;
      // the executor must still recheck the external binding and physical owner.
      return requestCleanupDecision(state, action);
    }
  }

  if (binding?.desired?.attemptId && ['RequestPreview', 'RetryPreview'].includes(action.type)) {
    return rejection(state, activationPending(binding) ? 'activation_pending' : 'isolated_activation_required');
  }

  if (flow?.attemptId) {
    if (action.type === 'PreviewReady') return rejection(state, 'activation_required');
    if (action.type === 'ClearPreview') return rejection(state, 'binding_retirement_required');
    if (action.type === 'PreparationFailed') {
      const decision = reduceLegacy(state, action, facts);
      if (decision.accepted) decision.projection = 'unchanged';
      return decision;
    }
  }
  return reduceLegacy(state, action, facts);
}

module.exports = { reduceCandidate, activationPending };
