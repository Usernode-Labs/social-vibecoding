'use strict';

const { z } = require('zod');

const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
const executionIdentityFields = {
  flowId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  headSha: sha,
};
const actionEnvelopeFields = {
  actionId: z.string().uuid(),
  sessionId: z.number().int().positive(),
};

const preparationRequestFields = {
  headSha: sha,
  startedStatus: z.enum(['active', 'paused']),
};

const resourceIntent = z.object({
  runtimeKind: z.enum(['docker', 'kubernetes']),
  runtimeName: z.string().min(1).max(255),
  dbName: z.string().min(1).max(63),
  namespace: z.string().min(1).max(63).nullable(),
  attemptId: z.string().uuid().optional(),
  checkoutDir: z.string().min(1).max(255).optional(),
  imageName: z.string().min(1).max(255).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.runtimeKind === 'docker' && value.namespace !== null)
      || (value.runtimeKind === 'kubernetes' && value.namespace === null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Resource intent namespace must match its runtime kind',
    });
  }
});

const runtimeReceiptFields = {
  commitSha: sha,
  stagingUrl: z.string().url().max(512),
  runtimeKind: z.enum(['docker', 'kubernetes']),
  runtimeName: z.string().min(1).max(255),
  containerId: z.string().min(1).max(128).nullable(),
  imageRef: z.string().min(1).max(1024),
  buildRef: z.string().min(1).max(1024).nullable(),
};

function validateRuntimeTuple(value, ctx) {
  if (value.runtimeKind === 'docker' && value.containerId !== value.runtimeName) {
    ctx.addIssue({ code: 'custom', message: 'Docker receipt must identify its container' });
  }
  if (value.runtimeKind === 'kubernetes' && value.containerId !== null) {
    ctx.addIssue({ code: 'custom', message: 'Kubernetes receipt cannot identify a Docker container' });
  }
}

const runtimeReceipt = z.object(runtimeReceiptFields).strict().superRefine(validateRuntimeTuple);
const candidateReceipt = z.object({
  ...runtimeReceiptFields,
  attemptId: z.string().uuid(),
  physicalId: z.string().min(1).max(128),
}).strict().superRefine(validateRuntimeTuple);

const routeObservation = z.object({
  target: z.string().min(1).max(255).nullable(),
  token: z.string().min(1).max(255).nullable(),
  uid: z.string().min(1).max(128).nullable(),
}).strict();

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('RetirePreviewPreparation'),
    ...executionIdentityFields,
    reviewActionId: z.string().uuid(),
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('RequestCandidatePreview'),
    ...preparationRequestFields,
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('PreviewCandidatePrepared'),
    ...executionIdentityFields,
    receipt: candidateReceipt,
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('RequestPreviewActivation'),
    ...executionIdentityFields,
    expected: routeObservation,
    stagingUrl: z.string().url().max(512),
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('PreviewActivationObserved'),
    ...executionIdentityFields,
    activationId: z.string().uuid(),
    observation: routeObservation,
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('RequestPreview'),
    ...preparationRequestFields,
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('RetryPreview'),
    ...preparationRequestFields,
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('PreviewReady'),
    ...executionIdentityFields,
    receipt: runtimeReceipt,
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('PreparationFailed'),
    ...executionIdentityFields,
    detail: z.string().min(1).max(4096),
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('ClearPreview'),
    ...executionIdentityFields,
  }).strict(),
  // Historical resources outlive their session/current flow. The stored
  // obligation supplies locators; callers cannot choose a runtime to delete.
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('RequestPreviewCleanup'),
    flowId: z.string().uuid(),
  }).strict(),
  z.object({
    ...actionEnvelopeFields,
    type: z.literal('PreviewCleanupCompleted'),
    flowId: z.string().uuid(),
    disposition: z.enum(['removed', 'replaced']),
  }).strict(),
]);

// Internal action boundary. HTTP/MCP authentication remains at the adapters;
// payloads cannot supply a capability, a SQL patch, or an enabling condition.
function parseAction(value) {
  return actionSchema.parse(value);
}

function isPreparationRequest(action) {
  return action.type === 'RequestPreview' || action.type === 'RetryPreview';
}

function isResourceAction(action) {
  return action.type === 'RequestPreviewCleanup' || action.type === 'PreviewCleanupCompleted';
}

module.exports = {
  parseAction,
  runtimeReceipt,
  resourceIntent,
  candidateReceipt,
  routeObservation,
  isPreparationRequest,
  isResourceAction,
};
