'use strict';

const { z } = require('zod');

const returnAction = z.object({
  type: z.literal('RequestReturnToDevelopment'),
  actionId: z.string().uuid(),
  sessionId: z.number().int().positive().max(2147483647),
  userId: z.number().int().positive().max(2147483647),
  actorUsername: z.string().min(1).max(255).nullable(),
}).strict();

function parseAction(value) {
  return returnAction.parse(value);
}

module.exports = { parseAction };
