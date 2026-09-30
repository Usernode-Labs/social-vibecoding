'use strict';

const { enablingCondition } = require('./enabling-conditions');
const { isPreparationRequest, isResourceAction } = require('./actions');

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

module.exports = { reduceLegacy, requestCleanupDecision };
