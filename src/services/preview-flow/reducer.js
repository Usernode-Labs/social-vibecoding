'use strict';

const { enablingCondition } = require('./enabling-conditions');
const REDUCER_VERSION = 1;

// No clock, ID allocation, SQL, service calls or dispatch in this module.
// The captured state/action/facts reproduce a decision after its row changes.
function reduce(state, action, facts) {
  const reason = enablingCondition(state, action);
  if (reason) return { accepted: false, reason, flow: state.flow, projection: 'unchanged', effects: [] };

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
  if (entry.reducer_version !== REDUCER_VERSION) throw new Error(`Unsupported preview reducer version: ${entry.reducer_version}`);
  return reduce(entry.pre_state, entry.action, entry.facts);
}

module.exports = { reduce, replayDecision, REDUCER_VERSION };
