'use strict';

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
  const { session, flow } = state;
  if (action.type === 'RequestPreviewCleanup' || action.type === 'PreviewCleanupCompleted') {
    const resource = state.resource;
    if (!resource || resource.flowId !== action.flowId || resource.sessionId !== action.sessionId) return 'resource_missing';
    if (!resource.intent) return 'resource_intent_missing';
    if (resource.cleanupCompleted) {
      return action.type === 'PreviewCleanupCompleted' && resource.disposition !== action.disposition
        ? 'cleanup_result_conflict' : null;
    }
    if (resource.published && state.preview?.stagingUrl === resource.receipt?.stagingUrl
        && state.preview?.runtimeKind === resource.receipt?.runtimeKind
        && state.preview?.runtimeName === resource.receipt?.runtimeName
        && state.preview?.commitSha === resource.receipt?.commitSha) return 'resource_published';
    if (action.type === 'PreviewCleanupCompleted' && !resource.cleanupStarted) return 'cleanup_not_requested';
    return null;
  }
  if (action.type === 'RequestPreview' || action.type === 'RetryPreview') {
    return nativeHeadCondition(session, action.startedStatus, action.headSha);
  }
  if (!flow || flow.id !== action.flowId || flow.generation !== action.generation
      || flow.headSha !== action.headSha) return 'superseded_flow';
  if (action.type === 'ClearPreview') {
    // Removing an archived/merged preview is valid. Clearing is a factual
    // retirement of this identity, not permission to publish into that status.
    return ['preparing', 'ready', 'failed'].includes(flow.state) ? null : 'flow_settled';
  }
  const headCondition = nativeHeadCondition(session, flow.startedStatus, action.headSha);
  if (headCondition) return headCondition;
  if (flow.state !== 'preparing') return 'flow_settled';
  if (action.type === 'PreviewReady' && state.resource?.cleanupStarted) return 'resource_retiring';
  if (action.type === 'PreviewReady' && action.receipt.commitSha !== action.headSha) {
    return 'receipt_head_mismatch';
  }
  return null;
}

module.exports = { enablingCondition, nativeHeadCondition, publishableStatus };
