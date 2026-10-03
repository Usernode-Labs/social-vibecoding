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
    type: z.enum(['AcceptNativeManualHead', 'AuthorizeNativeManualRequest']),
    ...envelope,
    userId: z.number().int().positive(),
    canAdminWrite: z.boolean(),
    kind: z.enum(['deploy', 'ensure', 'recheck']),
    expectedStatus: z.string().min(1).max(32),
    branchName: z.string().min(1),
    previousChecks: envelope.headSha.nullable(),
    previousPreviewName: z.string().nullable(),
    startedStatus: z.enum(['active', 'paused']),
  }).strict(),
  z.object({
    type: z.literal('AcceptNativeSubmissionHead'),
    ...envelope,
    userId: z.number().int().positive(),
    expectedStatus: z.enum(['active', 'paused', 'promoted']),
    branchName: z.string().min(1),
    previousChecks: envelope.headSha.nullable(),
    previousPreviewName: z.string().nullable(),
    previousReviewed: envelope.headSha.nullable(),
    previousEpoch: z.number().int().nonnegative(),
    previousCheckState: z.string().nullable(),
    previousCheckPhase: z.string().nullable(),
    landedHeadSha: envelope.headSha,
    admissionEnabled: z.boolean(),
    moveKind: z.enum(['same', 'initialized', 'mechanical', 'resolved', 'authored', 'unknown']),
  }).strict(),
  z.object({
    type: z.literal('ResumeNativeSubmissionPreparation'),
    ...envelope,
    admissionId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal('AcceptCliSyncHead'),
    ...envelope,
    expectedStatus: z.enum(['active', 'promoted']),
    branchName: z.string().min(1),
    previousHead: envelope.headSha.nullable(),
    previousUploaded: envelope.headSha.nullable(),
    previousChecks: envelope.headSha.nullable(),
    previousLocalCommit: envelope.headSha.nullable(),
    previousUploadChecked: envelope.headSha.nullable(),
    previousPreviewName: z.string().nullable(),
    previousReviewed: envelope.headSha.nullable(),
    previousEpoch: z.number().int().nonnegative(),
    workerResult: z.enum(['clean', 'resolved', 'already_synced']),
    workerSha: envelope.headSha.nullable(),
    admissionEnabled: z.boolean(),
    moveKind: z.enum(['same', 'initialized', 'mechanical', 'resolved', 'authored', 'unknown']),
  }).strict(),
  z.object({
    type: z.literal('ResumeCliSyncPreparation'),
    ...envelope,
    admissionId: z.string().uuid(),
  }).strict(),
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
  z.object({
    type: z.literal('RequestNativeRecheck'), ...identity,
    userId: z.number().int().positive(),
    admissionEnabled: z.boolean(),
    reason: z.string().min(1).max(100),
    metadataKey: z.string().max(64).nullable(),
  }).strict(),
  z.object({ type: z.enum(['CliCandidateAvailable', 'NativeCandidateAvailable']), ...identity }).strict(),
  z.object({ type: z.enum(['RequestCliPreviewChecks', 'RequestNativePreviewChecks']), ...identity, force: z.boolean() }).strict(),
  z.object({ type: z.enum(['CliPreviewChecksObserved', 'NativePreviewChecksObserved']), ...identity }).strict(),
  z.object({
    type: z.enum(['CliChecksOutcomeBlocked', 'NativeChecksOutcomeBlocked']),
    ...identity,
    runId: z.string().uuid(),
    reason: blockedReasons,
    observedOwner: z.string().min(1).max(255).nullable(),
  }).strict(),
]);

module.exports = { parseAction: value => schema.parse(value) };
