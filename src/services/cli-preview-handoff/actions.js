'use strict';

const { z } = require('zod');

const envelope = {
  actionId: z.string().uuid(),
  sessionId: z.number().int().positive().max(2147483647),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
};
const blockedReasons = z.enum([
  'manifest_missing', 'launch_manifest_incomplete',
  'capture_creation_unconfirmed', 'unit_creation_unconfirmed',
  'capture_outcome_unconfirmed', 'unit_outcome_unconfirmed',
  'capture_output_unavailable',
  'capture_deadline_unconfirmed', 'unit_deadline_unconfirmed',
  'unit_ownership_conflict',
]);

const identity = { ...envelope, flowId: z.string().uuid() };
const schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('AcceptCliPreviewHead'),
    ...envelope,
    userId: z.number().int().positive(),
    startedStatus: z.enum(['active', 'paused']),
    expectedStatus: z.enum(['active', 'paused', 'promoted']),
    previousPreviewName: z.string().max(255).nullable(),
    previousHead: envelope.headSha.nullable(),
    previousChecks: envelope.headSha.nullable(),
    uploadCheckedSha: envelope.headSha.nullable(),
  }).strict(),
  z.object({ type: z.literal('CliCandidateAvailable'), ...identity }).strict(),
  z.object({ type: z.literal('RequestCliPreviewChecks'), ...identity, force: z.boolean() }).strict(),
  z.object({ type: z.literal('CliPreviewChecksObserved'), ...identity }).strict(),
  z.object({
    type: z.literal('CliChecksOutcomeBlocked'),
    ...identity,
    runId: z.string().uuid(),
    reason: blockedReasons,
    observedOwner: z.string().min(1).max(255).nullable(),
  }).strict(),
]);

module.exports = { parseAction: value => schema.parse(value) };
