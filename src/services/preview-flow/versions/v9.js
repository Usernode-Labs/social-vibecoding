'use strict';

// Frozen C5–C7 policy. Compose only frozen history and Node's pure comparison.
const { isDeepStrictEqual } = require('node:util');
const { reduce: reduceV8 } = require('./v8');
const RESOURCE_KINDS = ['secret', 'service', 'deployment'];

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

function reduceRuntime(state, action) {
  const select = action.type === 'RequestCandidateRuntimePreparation';
  const create = action.type === 'RequestCandidateRuntimeResourceCreation';
  const observe = action.type === 'CandidateRuntimeResourceObserved';
  if (!select && !create && !observe) return null;

  const { flow, resource } = state;
  const operation = resource?.intent?.runtimeOperation;
  const rejected = reason => ({
    accepted: false,
    reason,
    flow,
    projection: 'unchanged',
    effects: [],
  });
  if (operation?.kind !== 'kubernetes-v1' || resource.preparationOwner !== 'bounded'
      || resource.intent.attemptId !== action.operationId || resource.flowId !== action.flowId) {
    return rejected('runtime_operation_mismatch');
  }

  // Late observations can close a historical submission, but grant no creation
  // or publication authority. They must still identify its immutable desired spec.
  const desired = operation.desired;
  if (observe) {
    if (!desired || desired.flowId !== action.flowId || desired.generation !== action.generation
        || desired.headSha !== action.headSha) return rejected('runtime_identity_mismatch');
  } else {
    if (flow?.id !== action.flowId || flow.generation !== action.generation || flow.headSha !== action.headSha) {
      return rejected('superseded_flow');
    }
    const condition = nativeHeadCondition(state.session, flow.startedStatus, action.headSha);
    if (condition) return rejected(condition);
    if (flow.state !== 'preparing' || resource.cleanupStarted) return rejected('runtime_not_preparing');
    if (!resource.clonePrepared || !resource.intent.buildOperation?.receipt) return rejected('runtime_dependencies_unconfirmed');
  }

  const accepted = (reason, next, effects = []) => ({
    accepted: true,
    reason,
    flow,
    projection: 'unchanged',
    effects,
    runtimeChange: { flowId: action.flowId, operation: next },
  });
  if (select) {
    const requested = action.desired;
    if (requested.flowId !== action.flowId || requested.generation !== action.generation
        || requested.headSha !== action.headSha || requested.imageRef !== resource.intent.buildOperation.receipt.imageRef) {
      return rejected('runtime_specification_mismatch');
    }
    if (desired && !isDeepStrictEqual(desired, requested)) return rejected('runtime_specification_changed');
    return accepted('runtime_specification_selected', { ...operation, desired: requested });
  }

  if (!desired) return rejected('runtime_specification_missing');
  const progress = operation.resources[action.resource];
  if (observe) {
    if (!progress?.submitted) return rejected('runtime_resource_not_submitted');
    if (progress.uid && progress.uid !== action.uid) return rejected('runtime_uid_conflict');
    return accepted('runtime_resource_observed', {
      ...operation,
      resources: { ...operation.resources, [action.resource]: { ...progress, uid: action.uid } },
    });
  }

  const predecessor = RESOURCE_KINDS[RESOURCE_KINDS.indexOf(action.resource) - 1];
  if (predecessor && !operation.resources[predecessor]?.uid) return rejected('runtime_predecessor_unconfirmed');
  if (progress?.submitted) {
    return {
      accepted: true,
      reason: 'runtime_resource_already_submitted',
      flow,
      projection: 'unchanged',
      effects: [],
    };
  }
  const next = {
    ...operation,
    resources: { ...operation.resources, [action.resource]: { submitted: true } },
  };
  return accepted('runtime_resource_creation_requested', next, [{
    type: 'CreateCandidateRuntimeResource',
    effectKey: `${action.operationId}:runtime:${action.resource}`,
    causedBy: action.actionId,
    resource: action.resource,
    intent: { ...resource.intent, runtimeOperation: next },
  }]);
}

function reduce(state, action, facts) {
  const runtime = reduceRuntime(state, action);
  if (runtime) return runtime;
  const decision = reduceV8(state, action, facts);
  if (action.type !== 'PreviewCandidatePrepared' || !decision.accepted) return decision;
  const operation = state.resource?.intent?.runtimeOperation;
  if (operation && (!operation.desired
      || !RESOURCE_KINDS.every(kind => operation.resources[kind]?.uid)
      || action.receipt.physicalId !== operation.resources.deployment.uid
      || action.receipt.imageRef !== operation.desired.imageRef)) {
    return {
      accepted: false,
      reason: 'candidate_runtime_unconfirmed',
      flow: state.flow,
      projection: 'unchanged',
      effects: [],
    };
  }
  return decision;
}

module.exports = { reduce };
