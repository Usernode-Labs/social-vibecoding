'use strict';

const { enablingCondition } = require('./enabling-conditions');
const REDUCER_VERSION = 2;

// No clock, ID allocation, SQL, service calls or dispatch in this module.
// The captured state/action/facts reproduce a decision after its row changes.
function reduce(state, action, facts) {
  const reason = enablingCondition(state, action);
  if (reason) return { accepted: false, reason, flow: state.flow, projection: 'unchanged', effects: [] };

  if (action.type === 'RequestPreviewCleanup' || action.type === 'PreviewCleanupCompleted') {
    const resource = state.resource;
    if (resource.cleanupCompleted) return { accepted: true, reason: 'cleanup_already_completed',
      flow: state.flow, projection: 'unchanged', disposition: resource.disposition, effects: [] };
    if (action.type === 'PreviewCleanupCompleted') return { accepted: true, reason: 'cleanup_completed',
      flow: state.flow, projection: 'unchanged',
      resourceChange: { flowId: action.flowId, cleanup: 'complete', disposition: action.disposition }, effects: [] };
    return { accepted: true, reason: resource.cleanupStarted ? 'cleanup_resumed' : 'cleanup_requested',
      flow: state.flow, projection: 'unchanged',
      ...(resource.cleanupStarted ? {} : { resourceChange: { flowId: action.flowId, cleanup: 'start' } }),
      effects: [{ type: 'CleanupPreview', effectKey: `${action.flowId}:cleanup`, causedBy: action.actionId,
        sessionId: action.sessionId, flowId: action.flowId, intent: resource.intent }] };
  }

  if (action.type === 'RequestPreview' || action.type === 'RetryPreview') {
    if (action.type === 'RequestPreview' && state.flow?.headSha === action.headSha
        && state.flow.startedStatus === action.startedStatus
        && !state.resource?.cleanupStarted
        && ['preparing', 'ready'].includes(state.flow.state)) {
      return { accepted: true, reason: 'joined_existing_flow', flow: state.flow,
        projection: 'unchanged', effects: [] };
    }
    const flow = { id: facts.newFlowId, generation: (state.flow?.generation || 0) + 1,
      headSha: action.headSha, startedStatus: action.startedStatus, state: 'preparing' };
    return { accepted: true, reason: 'preparation_requested', flow, projection: 'unchanged',
      ...(state.flow ? { supersededFlow: { ...state.flow, state: 'superseded' } } : {}),
      effects: [{ type: 'BuildPreview', effectKey: `${flow.id}:build`, causedBy: action.actionId,
        sessionId: action.sessionId, flowId: flow.id,
        generation: flow.generation, headSha: flow.headSha }] };
  }
  if (action.type === 'PreviewReady') {
    return { accepted: true, reason: 'runtime_published', flow: { ...state.flow, state: 'ready' },
      projection: 'publish', receipt: action.receipt, effects: [] };
  }
  return { accepted: true,
    reason: action.type === 'PreparationFailed' ? 'preparation_failed' : 'preview_cleared',
    flow: { ...state.flow, state: action.type === 'PreparationFailed' ? 'failed' : 'cleared' },
    ...(action.type === 'PreparationFailed' ? { checkFailure: { headSha: action.headSha, detail: action.detail } } : {}),
    projection: 'clear', effects: [] };
}

function replayDecision(entry) {
  const reducer = entry.reducer_version === 1 ? require('./versions/v1').reduce
    : entry.reducer_version === REDUCER_VERSION ? reduce : null;
  if (!reducer) throw new Error(`Unsupported preview reducer version: ${entry.reducer_version}`);
  return reducer(entry.pre_state, entry.action, entry.facts);
}

module.exports = { reduce, replayDecision, REDUCER_VERSION };
