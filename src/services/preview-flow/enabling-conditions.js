'use strict';

const { isPreparationRequest, isResourceAction } = require('./actions');

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

module.exports = {
  enablingCondition,
  nativeHeadCondition,
  publishableStatus,
};
