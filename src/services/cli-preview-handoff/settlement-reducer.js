'use strict';

const { z } = require('zod');

const identity = {
  actionId: z.string().uuid(),
  sessionId: z.number().int().positive().max(2147483647),
  flowId: z.string().uuid(),
  runId: z.string().uuid(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
};
const schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SettleCliChecks'),
    ...identity,
    observedOwner: z.string().min(1).max(255),
    result: z.object({
      state: z.enum(['passing', 'failing', 'error', 'skipped', 'deferred']),
      results: z.array(z.record(z.any())),
    }).strict(),
    errorDetail: z.string().nullable(),
    history: z.array(z.object({
      checkKey: z.string().regex(/^[a-f0-9]{64}$/),
      name: z.string(),
      path: z.string(),
      passes: z.number().int().nonnegative(),
      fails: z.number().int().nonnegative(),
    }).strict()),
  }).strict(),
  z.object({
    type: z.literal('DeliverCliCheckGate'),
    ...identity,
    gate: z.enum(['merge', 'bot']),
  }).strict(),
]);

function reject(reason) {
  return { accepted: false, reason, effects: [] };
}

function reduce(state, action) {
  const { session, handoff, operation, manifest, preview, settlement } = state;
  if (!session || session.source !== 'cli_handoff' || !handoff?.flow_id) return reject('enrolled_cli_required');
  if (handoff.flow_id !== action.flowId || handoff.head_sha !== action.headSha
      || session.handoff_head_sha !== action.headSha || session.checks_commit_sha !== action.headSha
      || session.staging_commit_sha !== action.headSha) return reject('checks_superseded');
  if (!['active', 'paused', 'promoted', 'merging'].includes(session.status)) return reject('session_closed');
  if (['promoted', 'merging'].includes(session.status) && session.reviewed_head_sha !== action.headSha) {
    return reject('reviewed_head_changed');
  }
  if (preview?.id !== action.flowId || preview.head_sha !== action.headSha || preview.state !== 'ready'
      || preview.observed?.flowId !== action.flowId
      || preview.observed?.receipt?.runtimeName !== session.staging_runtime_name) return reject('activation_unconfirmed');

  if (action.type === 'DeliverCliCheckGate') {
    if (session.status !== 'promoted') return reject('gate_not_in_review');
    if (!settlement?.accepted || settlement.result.state !== session.check_state
        || operation?.run_id !== action.runId) return reject('settlement_changed');
    if (!settlement.effects.some(effect => effect.gate === action.gate)) return reject('gate_not_requested');
    return { accepted: true, reason: 'gate_delivery_authorized', effects: [] };
  }

  if (operation?.run_id !== action.runId || operation.revision !== action.headSha
      || operation.desired_revision !== action.headSha || operation.phase !== 'capture'
      || operation.state !== 'running') return reject('checks_run_changed');
  if (session.check_state !== 'pending' || session.check_phase === 'deferred') return reject('checks_already_settled');
  if (manifest && manifest.owner !== action.observedOwner) return reject('checks_owner_changed');
  if (manifest?.manifest?.cliFlowId && manifest.manifest.cliFlowId !== action.flowId) return reject('checks_flow_changed');
  if (manifest && (manifest.commit_sha !== action.headSha || !manifest.manifest?.durableCli)) {
    return reject('checks_manifest_changed');
  }
  if (action.result.state !== 'error' && (!manifest?.manifest?.launched || manifest.manifest.reconstruction)) {
    return reject('checks_launch_unconfirmed');
  }

  let gate = null;
  if (['passing', 'skipped'].includes(action.result.state)) gate = 'merge';
  else if (action.result.state === 'failing') gate = 'bot';

  return {
    accepted: true,
    reason: 'cli_checks_settled',
    identity: { runId: action.runId, headSha: action.headSha, flowId: action.flowId },
    result: action.result,
    effects: gate ? [{
      type: 'DeliverCliCheckGate',
      gate,
      effectKey: `${action.runId}:gate:${gate}`,
    }] : [],
  };
}

module.exports = { parseAction: value => schema.parse(value), reduce };
