'use strict';

const { enablingCondition } = require('./enabling-conditions');
const { isPreparationRequest, isResourceAction } = require('./actions');

const REDUCER_VERSION = 2;

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

function replayDecision(entry) {
  if (entry.reducer_version === 1) {
    return require('./versions/v1').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === REDUCER_VERSION) {
    return reduce(entry.pre_state, entry.action, entry.facts);
  }
  throw new Error(`Unsupported preview reducer version: ${entry.reducer_version}`);
}

module.exports = {
  reduce,
  replayDecision,
  REDUCER_VERSION,
};
