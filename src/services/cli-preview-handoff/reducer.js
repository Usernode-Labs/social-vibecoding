'use strict';

const REDUCER_VERSION = 5;

const { supportedSource, ordinaryNative, durableManifest } = require('./source-policy');

const { nativeHeadCondition } = require('../preview-flow/enabling-conditions');
const { consumersReleased } = require('../preview-flow/candidate-reducer');

function reject(reason) {
  return { accepted: false, reason, effects: [] };
}

function checksSettled(session) {
  return ['passing', 'failing', 'error', 'skipped'].includes(session?.check_state)
    || (session?.check_state === 'pending' && session.check_phase === 'deferred');
}

function reduce(state, action) {
  const { session, handoff, preview } = state;
  if (!supportedSource(session)) return reject('native_source_required');
  const prefix = session.source === 'cli_handoff' ? 'cli' : 'native';
  const type = action.type.replace('Native', 'Cli');
  const cliAdmission = ['AcceptCliSyncHead', 'ResumeCliSyncPreparation', 'AcceptCliPreviewHead'].includes(type);
  if (cliAdmission && session.source !== 'cli_handoff') return reject('native_cli_required');

  if (['AcceptNativeManualHead', 'AuthorizeNativeManualRequest'].includes(action.type)) {
    if (!ordinaryNative(session) || session.is_headless) return reject('ordinary_native_required');
    if (session.active_turn) return reject('session_busy');
    if (session.status !== action.expectedStatus || session.branch_name !== action.branchName
        || (session.checks_commit_sha || null) !== action.previousChecks
        || (session.staging_runtime_name || null) !== action.previousPreviewName) {
      return reject('session_state_changed');
    }
    const owner = session.user_id === action.userId;
    const reviewed = ['promoted', 'merging'].includes(session.status);
    let authorized;
    if (action.kind === 'deploy') authorized = owner && ['active', 'promoted'].includes(session.status);
    else if (action.kind === 'recheck') authorized = (owner || action.canAdminWrite) && ['active', 'paused', 'promoted'].includes(session.status);
    else authorized = owner || reviewed || !!session.shared_at;
    if (!authorized) return reject('manual_request_forbidden');
    if (reviewed && session.reviewed_head_sha !== action.headSha) return reject('reviewed_head_changed');
    if (!['active', 'paused', 'promoted', 'merging'].includes(session.status)) return reject('session_closed');
    if (action.type === 'AuthorizeNativeManualRequest') {
      return { accepted: true, reason: 'native_manual_request_authorized', effects: [], change: { authorizationOnly: true } };
    }
    return {
      accepted: true,
      reason: 'native_manual_head_accepted',
      change: { phase: 'preparing', headSha: action.headSha, startedStatus: action.startedStatus },
      effects: [{ type: 'PrepareNativePreview', effectKey: `${action.actionId}:prepare` }],
    };
  }

  if (type === 'AcceptCliSyncHead') {
    if (!handoff?.flow_id) return reject('cli_enrollment_required');
    if (session.active_turn) return reject('session_busy');
    if (session.status !== action.expectedStatus || session.branch_name !== action.branchName
        || (session.handoff_head_sha || null) !== action.previousHead
        || (session.handoff_uploaded_sha || null) !== action.previousUploaded
        || (session.checks_commit_sha || null) !== action.previousChecks
        || (session.handoff_local_commit_sha || null) !== action.previousLocalCommit
        || (session.handoff_upload_checked_sha || null) !== action.previousUploadChecked
        || (session.staging_runtime_name || null) !== action.previousPreviewName
        || (session.reviewed_head_sha || null) !== action.previousReviewed
        || Number(session.approval_epoch || 0) !== action.previousEpoch) {
      return reject('session_state_changed');
    }
    if ((action.workerSha && action.workerSha !== action.headSha)
        || (action.workerResult !== 'already_synced' && !action.workerSha)) {
      return reject('sync_revision_unverified');
    }
    if (action.previousUploaded !== action.previousHead && action.previousLocalCommit) {
      return reject('local_upload_awaiting_submission');
    }
    const keepApprovals = action.moveKind === 'mechanical' || action.moveKind === 'resolved'
      || action.moveKind === 'same' || action.moveKind === 'initialized';
    return {
      accepted: true,
      reason: 'cli_sync_head_accepted',
      change: {
        phase: 'preparing', headSha: action.headSha, startedStatus: 'active',
        approvalEpoch: action.previousEpoch
          + (session.status === 'promoted' && !keepApprovals ? 1 : 0),
        deferPreparation: !action.admissionEnabled,
      },
      effects: action.admissionEnabled
        ? [{ type: 'PrepareCliPreview', effectKey: `${action.actionId}:prepare` }]
        : [{ type: 'ReconcileCliSyncPreparation', owner: 'cli-preview-handoff' }],
    };
  }

  if (type === 'ResumeCliSyncPreparation') {
    if (!handoff?.sync_reconciliation || handoff.admission_id !== action.admissionId
        || handoff.head_sha !== action.headSha || session.handoff_head_sha !== action.headSha) {
      return reject('sync_obligation_changed');
    }
    if (session.active_turn) return reject('session_busy');
    const condition = nativeHeadCondition(preview.session, handoff.started_status, action.headSha);
    if (condition) return reject(condition);
    return {
      accepted: true,
      reason: 'cli_sync_preparation_resumed',
      change: { phase: 'preparing', resumeSync: true },
      effects: [{ type: 'PrepareCliPreview', effectKey: `${action.admissionId}:prepare` }],
    };
  }

  if (type === 'AcceptCliPreviewHead') {
    if (session.user_id !== action.userId) return reject('session_owner_changed');
    if (session.active_turn) return reject('session_busy');
    if (session.status !== action.expectedStatus) return reject('session_state_changed');
    if (session.status === 'promoted' && (session.reviewed_head_sha !== action.headSha
        || session.checks_commit_sha !== action.headSha)) return reject('reviewed_head_changed');
    if ((session.staging_runtime_name || null) !== action.previousPreviewName) return reject('preview_changed');
    if (session.handoff_uploaded_sha !== action.headSha) return reject('head_not_uploaded');
    if ((session.handoff_head_sha || null) !== action.previousHead
        || (session.checks_commit_sha || null) !== action.previousChecks
        || (session.handoff_upload_checked_sha || null) !== action.uploadCheckedSha) {
      return reject('session_state_changed');
    }
    return {
      accepted: true,
      reason: 'cli_head_accepted',
      change: { phase: 'preparing', headSha: action.headSha, startedStatus: action.startedStatus },
      effects: [{ type: 'PrepareCliPreview', effectKey: `${action.actionId}:prepare` }],
    };
  }

  if ((prefix === 'cli') !== action.type.includes('Cli')) return reject('action_source_mismatch');

  if (!handoff || handoff.head_sha !== action.headSha || handoff.flow_id !== action.flowId
      || preview.flow?.id !== action.flowId) return reject('superseded_handoff');
  const condition = nativeHeadCondition(preview.session, handoff.started_status, action.headSha);
  if (condition) return reject(condition);

  if (type === 'CliCandidateAvailable') {
    if (preview.flow.state !== 'candidate') return reject('candidate_not_ready');
    return {
      accepted: true,
      reason: `${prefix}_candidate_available`,
      change: { phase: 'continuing' },
      effects: [{ type: 'ContinueCliPreview', effectKey: `${action.flowId}:cli-continuation` }],
    };
  }

  if (preview.flow.state !== 'ready' || preview.binding?.observed?.flowId !== action.flowId
      || session.staging_commit_sha !== action.headSha) return reject('activation_unconfirmed');
  if (type === 'CliChecksOutcomeBlocked') {
    const operation = state.checkOperation;
    if (!operation || operation.run_id !== action.runId || operation.revision !== action.headSha
        || operation.desired_revision !== action.headSha
        || operation.phase !== 'capture' || operation.state !== 'running') return reject('checks_run_changed');
    if (checksSettled(session)) return reject('checks_already_settled');
    if (state.checkRun && (state.checkRun.owner !== action.observedOwner
        || state.checkRun.commit_sha !== action.headSha
        || !durableManifest(state.checkRun.manifest))) return reject('checks_owner_changed');
    if (!state.checkRun && (action.reason !== 'manifest_missing' || action.observedOwner !== null)) {
      return reject('checks_manifest_changed');
    }
    return {
      accepted: true,
      reason: `${prefix}_checks_blocked`,
      change: {
        phase: 'checking',
        recovery: {
          state: 'blocked', runId: action.runId, headSha: action.headSha,
          flowId: action.flowId, reason: action.reason,
          owner: 'check-harvest', actionId: action.actionId,
        },
      },
      effects: [{ type: 'ReconcileCliChecks', runId: action.runId, owner: 'check-harvest' }],
    };
  }

  if (action.type === 'RequestNativeRecheck') {
    if (!ordinaryNative(session) || session.is_headless) return reject('ordinary_native_required');
    if (session.user_id !== action.userId) return reject('session_owner_changed');
    if (!['active', 'paused', 'promoted'].includes(session.status)) return reject('session_closed');
    if (session.active_turn) return reject('session_busy');
    if (!action.admissionEnabled) return reject('native_admission_disabled');
    if (handoff.checks_recovery) return reject('checks_reconciliation_required');
    if (state.checksOutstanding || !consumersReleased(preview.resource)) return reject('checks_consumers_unresolved');
    if (state.continuationOutstanding) return reject('checks_continuation_pending');
    return {
      accepted: true,
      reason: 'native_recheck_requested',
      change: { phase: 'checking', resetChecks: true },
      effects: [{ type: 'CaptureCliPreviewChecks', effectKey: `${action.sessionId}:${action.actionId}:checks` }],
    };
  }

  const request = type === 'RequestCliPreviewChecks';
  if (request && action.force && handoff.checks_recovery) return reject('checks_reconciliation_required');
  if (!request && (!checksSettled(session) || state.checksOutstanding)) return reject('checks_pending');
  return {
    accepted: true,
    reason: request ? `${prefix}_checks_requested` : `${prefix}_checks_observed`,
    change: {
      phase: request ? 'checking' : 'complete',
      resetChecks: request && action.force,
      ...(!request && handoff.checks_recovery ? { clearRecovery: true } : {}),
    },
    effects: request ? [{ type: 'CaptureCliPreviewChecks',
      effectKey: prefix === 'cli' ? `${action.actionId}:checks` : `${action.sessionId}:${action.actionId}:checks` }] : [],
  };
}

function replayDecision(entry) {
  if (![3, 4, REDUCER_VERSION].includes(entry.reducer_version)) {
    throw new Error(`Unsupported cli-preview-handoff reducer version: ${entry.reducer_version}; use the offline historical archive`);
  }
  if (entry.reducer_version === 3 && entry.pre_state.session?.source !== 'cli_handoff') return reject('native_cli_required');
  return reduce(entry.pre_state, entry.action);
}

module.exports = { reduce, checksSettled, replayDecision, REDUCER_VERSION };
