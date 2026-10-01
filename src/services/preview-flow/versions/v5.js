'use strict';

// Frozen delayed-creation policy. No imports from live domain rules.
function isPreparationRequest(action) {
  return action.type === 'RequestPreview' || action.type === 'RetryPreview';
}

function isResourceAction(action) {
  return action.type === 'RequestPreviewCleanup' || action.type === 'PreviewCleanupCompleted';
}

// Initial policy: native proposal handoff. Imported/manual/fleet policies must
// be added deliberately when their adapters move here. No permissive default.
function publishableStatus(session, startedStatus, headSha) {
  return !!session && (session.status === startedStatus
    || (session.status === 'promoted' && session.reviewedHeadSha === headSha));
}

function nativeHeadCondition(session, startedStatus, headSha) {
  if (!session) return 'session_missing';
  if (session.source === 'imported') return 'imported_session';
  if (session.checksCommitSha !== headSha) return 'head_changed';
  if (!publishableStatus(session, startedStatus, headSha)) return 'status_changed';
  return null;
}

function enablingCondition(state, action) {
  const { session, flow, resource, preview } = state;

  // Historical resource retirement is independent of the current flow pointer.
  if (isResourceAction(action)) {
    if (!resource || resource.flowId !== action.flowId || resource.sessionId !== action.sessionId) {
      return 'resource_missing';
    }
    if (!resource.intent) return 'resource_intent_missing';

    const reportsCompletion = action.type === 'PreviewCleanupCompleted';
    if (resource.cleanupCompleted) {
      if (reportsCompletion && resource.disposition !== action.disposition) {
        return 'cleanup_result_conflict';
      }
      return null;
    }

    const stillPublished = resource.published
      && preview?.stagingUrl === resource.receipt?.stagingUrl
      && preview?.runtimeKind === resource.receipt?.runtimeKind
      && preview?.runtimeName === resource.receipt?.runtimeName
      && preview?.commitSha === resource.receipt?.commitSha;
    if (stillPublished) return 'resource_published';
    if (reportsCompletion && !resource.cleanupStarted) return 'cleanup_not_requested';
    return null;
  }

  if (isPreparationRequest(action)) {
    return nativeHeadCondition(session, action.startedStatus, action.headSha);
  }

  // Reported flow outcomes must name the current execution before any policy
  // about its status, head or resources can grant permission.
  if (!flow || flow.id !== action.flowId || flow.generation !== action.generation
      || flow.headSha !== action.headSha) {
    return 'superseded_flow';
  }

  if (action.type === 'ClearPreview') {
    // Removing an archived/merged preview is valid. Clearing is a factual
    // retirement of this identity, not permission to publish into that status.
    if (['preparing', 'ready', 'failed'].includes(flow.state)) return null;
    return 'flow_settled';
  }

  const headCondition = nativeHeadCondition(session, flow.startedStatus, action.headSha);
  if (headCondition) return headCondition;
  if (flow.state !== 'preparing') return 'flow_settled';

  if (action.type === 'PreviewReady') {
    if (resource?.cleanupStarted) return 'resource_retiring';
    if (action.receipt.commitSha !== action.headSha) {
      return 'receipt_head_mismatch';
    }
  }
  return null;
}

// A cleanup pass proves absence at its observation boundary, not termination
// of an external creator. Isolated attempts can request a fresh pass later.
function requestCleanupDecision(state, action) {
  const resource = state.resource;
  const reconciling = resource.cleanupCompleted;
  let reason = 'cleanup_requested';
  if (reconciling) reason = 'cleanup_reconciliation_requested';
  else if (resource.cleanupStarted) reason = 'cleanup_resumed';

  // A fresh isolated observation is new work. Replaying the same action keeps
  // its key; a later scan must not reuse a completed effect's identity.
  const effectKey = resource.intent.attemptId
    ? `${action.flowId}:cleanup:${action.actionId}`
    : `${action.flowId}:cleanup`;

  const decision = {
    accepted: true,
    reason,
    flow: state.flow,
    projection: 'unchanged',
    effects: [{
      type: 'CleanupPreview',
      effectKey,
      causedBy: action.actionId,
      sessionId: action.sessionId,
      flowId: action.flowId,
      intent: resource.intent,
    }],
  };

  if (reconciling || !resource.cleanupStarted) {
    decision.resourceChange = {
      flowId: action.flowId,
      cleanup: reconciling ? 'reconcile' : 'start',
    };
  }
  return decision;
}

// No clock, ID allocation, SQL, service calls or dispatch in this module.
// The captured state/action/facts reproduce a decision after its row changes.
function reduceLegacy(state, action, facts) {
  const reason = enablingCondition(state, action);
  if (reason) {
    return {
      accepted: false,
      reason,
      flow: state.flow,
      projection: 'unchanged',
      effects: [],
    };
  }

  if (isResourceAction(action)) {
    const resource = state.resource;
    if (resource.cleanupCompleted) {
      return {
        accepted: true,
        reason: 'cleanup_already_completed',
        flow: state.flow,
        projection: 'unchanged',
        disposition: resource.disposition,
        effects: [],
      };
    }

    if (action.type === 'PreviewCleanupCompleted') {
      return {
        accepted: true,
        reason: 'cleanup_completed',
        flow: state.flow,
        projection: 'unchanged',
        resourceChange: {
          flowId: action.flowId,
          cleanup: 'complete',
          disposition: action.disposition,
        },
        effects: [],
      };
    }

    return requestCleanupDecision(state, action);
  }

  if (isPreparationRequest(action)) {
    const canJoinExisting = action.type === 'RequestPreview'
      && state.flow?.headSha === action.headSha
      && state.flow.startedStatus === action.startedStatus
      && !state.resource?.cleanupStarted
      && ['preparing', 'ready'].includes(state.flow.state);
    if (canJoinExisting) {
      return {
        accepted: true,
        reason: 'joined_existing_flow',
        flow: state.flow,
        projection: 'unchanged',
        effects: [],
      };
    }

    const flow = {
      id: facts.newFlowId,
      generation: (state.flow?.generation || 0) + 1,
      headSha: action.headSha,
      startedStatus: action.startedStatus,
      state: 'preparing',
    };
    const decision = {
      accepted: true,
      reason: 'preparation_requested',
      flow,
      projection: 'unchanged',
      effects: [{
        type: 'BuildPreview',
        effectKey: `${flow.id}:build`,
        causedBy: action.actionId,
        sessionId: action.sessionId,
        flowId: flow.id,
        generation: flow.generation,
        headSha: flow.headSha,
      }],
    };
    if (state.flow) {
      decision.supersededFlow = { ...state.flow, state: 'superseded' };
    }
    return decision;
  }

  if (action.type === 'PreviewReady') {
    return {
      accepted: true,
      reason: 'runtime_published',
      flow: { ...state.flow, state: 'ready' },
      projection: 'publish',
      receipt: action.receipt,
      effects: [],
    };
  }

  const preparationFailed = action.type === 'PreparationFailed';
  const decision = {
    accepted: true,
    reason: preparationFailed ? 'preparation_failed' : 'preview_cleared',
    flow: { ...state.flow, state: preparationFailed ? 'failed' : 'cleared' },
    projection: 'clear',
    effects: [],
  };
  if (preparationFailed) {
    decision.checkFailure = { headSha: action.headSha, detail: action.detail };
  }
  return decision;
}


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

module.exports = { reduce: reduceCandidate };
