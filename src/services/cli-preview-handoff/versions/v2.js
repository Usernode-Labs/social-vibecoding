'use strict';

const { nativeHeadCondition } = require('../../preview-flow/enabling-conditions');

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
  const request = action.type === 'RequestCliPreviewChecks';
  if (!request && (!checksSettled(session) || state.checksOutstanding)) return reject('checks_pending');
  return {
    accepted: true,
    reason: request ? 'cli_checks_requested' : 'cli_checks_observed',
    change: { phase: request ? 'checking' : 'complete', resetChecks: request && action.force },
    effects: request ? [{ type: 'CaptureCliPreviewChecks', effectKey: `${action.actionId}:checks` }] : [],
  };
}

// Retained v2 traces preserve the pre-reconciliation decision contract.
module.exports = { reduce, checksSettled };
