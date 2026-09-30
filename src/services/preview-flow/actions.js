'use strict';

const { z } = require('zod');

const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
const identity = {
  flowId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  headSha: sha,
};
const envelope = { actionId: z.string().uuid(), sessionId: z.number().int().positive() };
const request = { headSha: sha, startedStatus: z.enum(['active', 'paused']) };
const resourceIntent = z.object({
  runtimeKind: z.enum(['docker', 'kubernetes']),
  runtimeName: z.string().min(1).max(255),
  dbName: z.string().min(1).max(63),
  namespace: z.string().min(1).max(63).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.runtimeKind === 'docker' && value.namespace !== null)
      || (value.runtimeKind === 'kubernetes' && value.namespace === null)) {
    ctx.addIssue({ code: 'custom', message: 'Resource intent namespace must match its runtime kind' });
  }
});
const runtimeReceipt = z.object({
  commitSha: sha,
  stagingUrl: z.string().url().max(512),
  runtimeKind: z.enum(['docker', 'kubernetes']),
  runtimeName: z.string().min(1).max(255),
  containerId: z.string().min(1).max(128).nullable(),
  imageRef: z.string().min(1).max(1024),
  buildRef: z.string().min(1).max(1024).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.runtimeKind === 'docker' && value.containerId !== value.runtimeName) {
    ctx.addIssue({ code: 'custom', message: 'Docker receipt must identify its container' });
  }
  if (value.runtimeKind === 'kubernetes' && value.containerId !== null) {
    ctx.addIssue({ code: 'custom', message: 'Kubernetes receipt cannot identify a Docker container' });
  }
});
const actionSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('RequestPreview'), ...request }).strict(),
  z.object({ ...envelope, type: z.literal('RetryPreview'), ...request }).strict(),
  z.object({ ...envelope, type: z.literal('PreviewReady'), ...identity, receipt: runtimeReceipt }).strict(),
  z.object({ ...envelope, type: z.literal('PreparationFailed'), ...identity,
    detail: z.string().min(1).max(4096) }).strict(),
  z.object({ ...envelope, type: z.literal('ClearPreview'), ...identity }).strict(),
]);

// Internal action boundary. HTTP/MCP authentication remains at the adapters;
// payloads cannot supply a capability, a SQL patch, or an enabling condition.
module.exports = { parseAction: value => actionSchema.parse(value), runtimeReceipt, resourceIntent };
