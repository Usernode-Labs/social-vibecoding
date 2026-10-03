'use strict';

const REDUCER_VERSION = 3;

const { nativeHeadCondition } = require('../preview-flow/enabling-conditions');

function reject(reason) {
  return { accepted: false, reason, effects: [] };
}

function checksSettled(session) {
  return ['passing', 'failing', 'error', 'skipped'].includes(session?.check_state)
    || (session?.check_state === 'pending' && session.check_phase === 'deferred');
}

function reduce(state, action) {
  const { session, handoff, preview } = state;
  if (!session || session.source !== 'cli_handoff') return reject('native_cli_required');

  if (action.type === 'AcceptCliSyncHead') {
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

  if (action.type === 'ResumeCliSyncPreparation') {
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

  if (action.type === 'AcceptCliPreviewHead') {
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

  if (!handoff || handoff.head_sha !== action.headSha || handoff.flow_id !== action.flowId
      || preview.flow?.id !== action.flowId) return reject('superseded_handoff');
  const condition = nativeHeadCondition(preview.session, handoff.started_status, action.headSha);
  if (condition) return reject(condition);

  if (action.type === 'CliCandidateAvailable') {
    if (preview.flow.state !== 'candidate') return reject('candidate_not_ready');
    return {
      accepted: true,
      reason: 'cli_candidate_available',
      change: { phase: 'continuing' },
      effects: [{ type: 'ContinueCliPreview', effectKey: `${action.flowId}:cli-continuation` }],
    };
  }

  if (preview.flow.state !== 'ready' || preview.binding?.observed?.flowId !== action.flowId
      || session.staging_commit_sha !== action.headSha) return reject('activation_unconfirmed');
  if (action.type === 'CliChecksOutcomeBlocked') {
    const operation = state.checkOperation;
    if (!operation || operation.run_id !== action.runId || operation.revision !== action.headSha
        || operation.desired_revision !== action.headSha
        || operation.phase !== 'capture' || operation.state !== 'running') return reject('checks_run_changed');
    if (checksSettled(session)) return reject('checks_already_settled');
    if (state.checkRun && (state.checkRun.owner !== action.observedOwner
        || state.checkRun.commit_sha !== action.headSha
        || !state.checkRun.manifest?.durableCli)) return reject('checks_owner_changed');
    if (!state.checkRun && (action.reason !== 'manifest_missing' || action.observedOwner !== null)) {
      return reject('checks_manifest_changed');
    }
    return {
      accepted: true,
      reason: 'cli_checks_blocked',
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

  const request = action.type === 'RequestCliPreviewChecks';
  if (request && action.force && handoff.checks_recovery) return reject('checks_reconciliation_required');
  if (!request && (!checksSettled(session) || state.checksOutstanding)) return reject('checks_pending');
  return {
    accepted: true,
    reason: request ? 'cli_checks_requested' : 'cli_checks_observed',
    change: {
      phase: request ? 'checking' : 'complete',
      resetChecks: request && action.force,
      ...(!request && handoff.checks_recovery ? { clearRecovery: true } : {}),
    },
    effects: request ? [{ type: 'CaptureCliPreviewChecks', effectKey: `${action.actionId}:checks` }] : [],
  };
}

function replayDecision(entry) {
  if (entry.reducer_version !== REDUCER_VERSION) {
    throw new Error(`Unsupported cli-preview-handoff reducer version: ${entry.reducer_version}; use the offline historical archive`);
  }
  return reduce(entry.pre_state, entry.action);
}

module.exports = { reduce, checksSettled, replayDecision, REDUCER_VERSION };
