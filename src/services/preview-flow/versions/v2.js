'use strict';

// Frozen publication/retirement checkpoint. Keep policy independent of live B1 rules.
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


// No clock, ID allocation, SQL, service calls or dispatch in this module.
// The captured state/action/facts reproduce a decision after its row changes.
function reduce(state, action, facts) {
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

    const decision = {
      accepted: true,
      reason: resource.cleanupStarted ? 'cleanup_resumed' : 'cleanup_requested',
      flow: state.flow,
      projection: 'unchanged',
      effects: [{
        type: 'CleanupPreview',
        effectKey: `${action.flowId}:cleanup`,
        causedBy: action.actionId,
        sessionId: action.sessionId,
        flowId: action.flowId,
        intent: resource.intent,
      }],
    };
    if (!resource.cleanupStarted) {
      decision.resourceChange = { flowId: action.flowId, cleanup: 'start' };
    }
    return decision;
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

module.exports = { reduce, enablingCondition };
