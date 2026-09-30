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

function reduceCandidate(state, action, facts) {
  const { flow, resource, binding } = state;

  if (action.type === 'RequestCandidatePreview') {
    const condition = nativeHeadCondition(state.session, action.startedStatus, action.headSha);
    if (condition) return rejection(state, condition);
    if (activationPending(binding)) return rejection(state, 'activation_pending');
    // Until durable consumer retirement exists, permit one retained predecessor
    // alongside the serving attempt. Do not accumulate published runtimes.
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
    if (resource.published && (attemptId || isolatedBinding)) {
      return rejection(state, 'consumer_retirement_required');
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
