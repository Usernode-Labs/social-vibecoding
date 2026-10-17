// The bot-dm machine's I/O: the Homeroom bot's answer to one message in a
// person's DM with it, the line it says when it could not answer at all, a
// tap's act under one of its offers, and a hello. Each runs strict (a
// failure throws, so the item is retried) and is keyed so a retry after a
// restart says and does nothing twice: an answer by its idempotency key
// (found before anything is done again), the words it passes on by their
// mark, an offer's act by its claim, a hello by the row written in its
// send's own transaction (services/homeroom-bot-dm.js, homeroom-bot-mayor.js).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// 15 s, doubling, at most 5 minutes between tries.
const backoff = (attempt: number) => Math.min(5 * 60 * 1000, 15 * 1000 * 2 ** (attempt - 1));

export function botDmServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const dm = () => legacy('services/homeroom-bot-dm');
  return {
    // The answer to one message: every code path and the model's turn
    // (answerUserMessage), or a later try at one the model could not
    // answer. `later`: the try to ask next, when it deferred again.
    [WORK.answer]: {
      maxAttempts: 6,
      backoffMs: backoff,
      concurrency: 16,
      leaseMs: 120 * 1000,
      async run({ input, key, resumeFrom, checkpoint }): Promise<Json> {
        // An outside effect the answer has on the way that no row can key
        // (a platform report's GitHub issue): its result is kept in the
        // checkpoint, so a retry gets it back instead of doing it again.
        const effects: Record<string, Json> = { ...(((resumeFrom as any)?.effects) || {}) };
        const once = async (name: string, fn: () => Promise<Json>): Promise<Json> => {
          if (Object.prototype.hasOwnProperty.call(effects, name)) return effects[name]!;
          const value = await fn();
          effects[name] = value ?? null;
          await checkpoint({ effects });
          return value;
        };
        const out = await dm().answerOwed(pool, config, {
          userId: Number(input.userId), conversationId: Number(input.conversationId), messageId: Number(input.messageId),
          attempt: Number(input.attempt) || 0, workKey: key, once,
        });
        return { sent: !!out?.sent, later: out?.later ?? null, skipped: out?.skipped ?? null };
      },
    },

    // The answer failed for good: one fixed line, under the answer's own key.
    [WORK.sorry]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await dm().sayCouldNotAnswer(pool, {
          userId: Number(input.userId), conversationId: Number(input.conversationId), messageId: Number(input.messageId),
        });
        return { sent: !!sent };
      },
    },

    // A tap under one of the bot's offers, or Build it under a plan.
    [WORK.act]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/homeroom-bot-mayor').actOnTap(pool, config, {
          userId: Number(input.userId), actionId: Number(input.actionId), choice: String(input.choice),
          answers: Array.isArray(input.answers) ? input.answers : [], key: String(input.key),
        });
        return (out || null) as Json;
      },
    },

    // Their one hello, claimed in the transaction that sends it.
    [WORK.hello]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await dm().greet(pool, { userId: Number(input.userId), kind: String(input.kind), appId: input.appId ?? null });
        return { sent: sent?.messageId ?? null };
      },
    },
  };
}
