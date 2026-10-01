'use strict';

const { z } = require('zod');

const returnFields = {
  actionId: z.string().uuid(),
  sessionId: z.number().int().positive().max(2147483647),
  userId: z.number().int().positive().max(2147483647),
  actorUsername: z.string().min(1).max(255).nullable(),
};

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('RequestReturnToDevelopment'), ...returnFields }).strict(),
  z.object({ type: z.literal('RequestImportedReturnToDevelopment'), ...returnFields }).strict(),
  z.object({
    type: z.literal('RequestReturnAnnouncement'),
    actionId: z.string().uuid(),
    sessionId: z.number().int().positive().max(2147483647),
    returnActionId: z.string().uuid(),
  }).strict(),
]);

function parseAction(value) {
  return actionSchema.parse(value);
}

module.exports = { parseAction };
