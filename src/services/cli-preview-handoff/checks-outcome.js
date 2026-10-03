'use strict';

const { nativeAction } = require('./source-policy');
const { randomUUID } = require('node:crypto');
const { createCliPreviewHandoff } = require('./store');

// Inspection reports facts; the CLI reducer decides whether this flow/run may
// become blocked. No replacement execution or resource deletion belongs here.
async function blockOutcome(pool, { sessionId, runId, headSha, reason, observedOwner }) {
  const { rows } = await pool.query('SELECT flow_id FROM cli_preview_handoffs WHERE session_id = $1', [sessionId]);
  if (!rows[0]?.flow_id) return { accepted: false, reason: 'not_enrolled' };

  const owner = createCliPreviewHandoff(pool);
  const state = await owner.read(sessionId);
  const handoff = state.handoff;
  if (!handoff?.flow_id || handoff.head_sha !== headSha) return { accepted: false, reason: 'superseded_handoff' };

  const previous = handoff.checks_recovery;
  if (previous?.runId === runId && previous.reason === reason && state.checkRun?.owner === observedOwner
      && state.checkOperation?.run_id === runId && state.checkOperation.state === 'running'
      && state.checkOperation.revision === headSha && state.checkOperation.desired_revision === headSha) {
    return { accepted: true, recovery: previous };
  }

  const result = await owner.apply({
    type: nativeAction(state.session, 'CliChecksOutcomeBlocked'), actionId: randomUUID(), sessionId,
    flowId: handoff.flow_id, headSha, runId, reason,
    observedOwner: observedOwner || null,
  });
  return {
    accepted: result.decision.accepted,
    reason: result.decision.reason,
    recovery: result.current.handoff?.checks_recovery || null,
  };
}

function collectedUncertainty(kind, outcome) {
  if (!outcome) return null;
  if (['gone', 'aborted'].includes(outcome.state)) return `${kind}_outcome_unconfirmed`;
  if (outcome.state === 'timeout') return `${kind}_deadline_unconfirmed`;
  const terminal = ['succeeded', 'failed'].includes(outcome.state);
  // Unit verdicts are based on verified Job success/failure, not TAP text.
  // Capture needs its frame stream to grade the requested assertions.
  if (kind === 'capture' && terminal && (outcome.partialReason === 'capture log unavailable'
      || (outcome.state === 'succeeded' && !outcome.stdout?.trim()))) {
    return `${kind}_output_unavailable`;
  }
  return null;
}

async function blockLiveFailure(pool, operation, error) {
  const record = await require('../check-runs').read(pool, operation.runId, operation.sessionId);
  if (!record) return { accepted: false, reason: 'manifest_not_admitted' };

  let reason = 'capture_outcome_unconfirmed';
  if (!record.manifest.launched) reason = 'launch_manifest_incomplete';
  else if (error.checksBlockedReason) reason = error.checksBlockedReason;
  else if (error.code === 'UNIT_SUITE_EXECUTION_UNCONFIRMED') reason = 'unit_outcome_unconfirmed';

  return blockOutcome(pool, {
    sessionId: operation.sessionId,
    runId: operation.runId,
    headSha: operation.revision,
    reason,
    observedOwner: record.owner,
  });
}

async function readRecovery(pool, session) {
  const { rows } = await pool.query(`SELECT checks_recovery FROM cli_preview_handoffs
    WHERE session_id = $1 AND head_sha = $2`, [session.id, session.checks_commit_sha]);
  return rows[0]?.checks_recovery || null;
}

module.exports = { blockOutcome, blockLiveFailure, collectedUncertainty, readRecovery };
