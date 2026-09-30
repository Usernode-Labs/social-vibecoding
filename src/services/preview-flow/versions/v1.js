'use strict';

// Frozen checkpoint policy for replay only. Do not import current enabling
// conditions: changing live policy must not change historical decisions.
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
  const { session, flow } = state;
  if (action.type === 'RequestPreview' || action.type === 'RetryPreview') {
    return nativeHeadCondition(session, action.startedStatus, action.headSha);
  }
  if (!flow || flow.id !== action.flowId || flow.generation !== action.generation
      || flow.headSha !== action.headSha) return 'superseded_flow';
  if (action.type === 'ClearPreview') {
    return ['preparing', 'ready', 'failed'].includes(flow.state) ? null : 'flow_settled';
  }
  const headCondition = nativeHeadCondition(session, flow.startedStatus, action.headSha);
  if (headCondition) return headCondition;
  if (flow.state !== 'preparing') return 'flow_settled';
  if (action.type === 'PreviewReady' && state.resource?.cleanupStarted) return 'resource_retiring';
  if (action.type === 'PreviewReady' && action.receipt.commitSha !== action.headSha) return 'receipt_head_mismatch';
  return null;
}
function reduce(state, action, facts) {
  const reason = enablingCondition(state, action);
  if (reason) return { accepted: false, reason, flow: state.flow, projection: 'unchanged', effects: [] };
  if (action.type === 'RequestPreview' || action.type === 'RetryPreview') {
    if (action.type === 'RequestPreview' && state.flow?.headSha === action.headSha
        && state.flow.startedStatus === action.startedStatus
        && !state.resource?.cleanupStarted
        && ['preparing', 'ready'].includes(state.flow.state)) {
      return { accepted: true, reason: 'joined_existing_flow', flow: state.flow, projection: 'unchanged', effects: [] };
    }
    const flow = { id: facts.newFlowId, generation: (state.flow?.generation || 0) + 1,
      headSha: action.headSha, startedStatus: action.startedStatus, state: 'preparing' };
    return { accepted: true, reason: 'preparation_requested', flow, projection: 'unchanged',
      effects: [{ type: 'BuildPreview', effectKey: `${flow.id}:build`, causedBy: action.actionId,
        sessionId: action.sessionId, flowId: flow.id, generation: flow.generation, headSha: flow.headSha }] };
  }
  if (action.type === 'PreviewReady') return { accepted: true, reason: 'runtime_published',
    flow: { ...state.flow, state: 'ready' }, projection: 'publish', receipt: action.receipt, effects: [] };
  return { accepted: true,
    reason: action.type === 'PreparationFailed' ? 'preparation_failed' : 'preview_cleared',
    flow: { ...state.flow, state: action.type === 'PreparationFailed' ? 'failed' : 'cleared' },
    ...(action.type === 'PreparationFailed' ? { checkFailure: { headSha: action.headSha, detail: action.detail } } : {}),
    projection: 'clear', effects: [] };
}
module.exports = { reduce };
