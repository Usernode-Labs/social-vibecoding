// The bot-dm machine's I/O: the Homeroom bot's answer to one message in a
// person's DM with it, the line it says when it could not answer at all, a
// tap's act under one of its offers, a hello, and the email that stands in
// for a push. Each runs strict (a failure throws, so the item is retried)
// and is keyed so a retry after a restart says and does nothing twice: an
// answer by its idempotency key (found before anything is done again), the
// words it passes on by their mark, an offer's act by its claim, a hello by
// the row written in its send's own transaction (services/homeroom-bot-dm.js,
// homeroom-bot-mayor.js). An email has no such row: see its handler.
//
// Task 2148: an answer can be stopped by the person. Its work watches its
// instance for the mark their Stop leaves (machine.ts StopRequested), and
// the turn ends itself at its next safe point (services/homeroom-bot-stop.js).
// The watch's signal is its own, never the work's lease signal: that one
// also aborts when the process stops for a release, which is not a Stop.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { MACHINE, WORK, dmKey } from './machine.ts';
import { lateNotice } from '../rules/late-notice.ts';

interface Deps { config: any; pool: Pool }

// 15 s, doubling, at most 5 minutes between tries.
const backoff = (attempt: number) => Math.min(5 * 60 * 1000, 15 * 1000 * 2 ** (attempt - 1));

// Whether the person stopped the answer to this message (this try of it):
// the mark on the answer their instance has under way.
const STOP_ASKED_SQL = `
  SELECT 1 FROM wf_instances
   WHERE machine = $1 AND key = $2 AND state = 'answering'
     AND data->'current'->>'messageId' = $3::text
     AND COALESCE(data->'current'->>'attempt', '0') = $4::text
     AND data->'current'->>'stop' = 'true'`;
export async function stopAsked(pool: Pool, p: { userId: number; messageId: number; attempt: number }): Promise<boolean> {
  const { rows } = await pool.query(STOP_ASKED_SQL, [MACHINE, dmKey(p.userId), String(p.messageId), String(p.attempt || 0)]);
  return rows.length > 0;
}

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
      async run({ input, key, resumeFrom, checkpoint, attempt: tries }): Promise<Json> {
        // An outside effect the answer has on the way that no row can key
        // (a platform report's GitHub issue): its result is kept in the
        // checkpoint, so a retry gets it back instead of doing it again.
        const effects: Record<string, Json> = { ...(((resumeFrom as any)?.effects) || {}) };
        // What the answer has done that stays done (a request started, a
        // thread opened), kept the same way: the line a Stop says names it
        // even when an earlier try did it.
        let did: Json[] = Array.isArray((resumeFrom as any)?.did) ? [...(resumeFrom as any).did] : [];
        const once = async (name: string, fn: () => Promise<Json>): Promise<Json> => {
          if (Object.prototype.hasOwnProperty.call(effects, name)) return effects[name]!;
          const value = await fn();
          effects[name] = value ?? null;
          await checkpoint({ effects, did });
          return value;
        };
        const userId = Number(input.userId);
        const messageId = Number(input.messageId);
        const attempt = Number(input.attempt) || 0;
        const stop = await legacy('services/homeroom-bot-stop').watch({
          asked: () => stopAsked(pool, { userId, messageId, attempt }),
          kept: did,
          onNote: async (now: Json[]) => { did = JSON.parse(JSON.stringify(now)); await checkpoint({ effects, did }); },
        });
        try {
          const out = await dm().answerOwed(pool, config, {
            userId, conversationId: Number(input.conversationId), messageId, attempt, workKey: key, once,
            also: Array.isArray(input.also) ? input.also.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [],
            stop, retried: tries > 1,
          });
          return { sent: !!out?.sent, later: out?.later ?? null, skipped: out?.skipped ?? null, ...(out?.stopped ? { stopped: true } : {}) };
        } finally {
          stop.end();
        }
      },
    },

    // The answer failed for good: one fixed line, under the answer's own key.
    [WORK.sorry]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await dm().sayCouldNotAnswer(pool, {
          userId: Number(input.userId), conversationId: Number(input.conversationId), messageId: Number(input.messageId),
          attempt: Number(input.attempt) || 0,
        });
        return { sent: !!sent };
      },
    },

    // A stopped answer no turn was there to say (a try dropped while it
    // waited, one that deferred or failed for good after the Stop): one
    // fixed line, under the answer's own key.
    [WORK.stopped]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await dm().sayStopped(pool, {
          userId: Number(input.userId), conversationId: Number(input.conversationId), messageId: Number(input.messageId),
          attempt: Number(input.attempt) || 0,
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
          answers: Array.isArray(input.answers) ? input.answers : [], key: String(input.key), gaveUp: !!input.gaveUp,
        });
        return (out || null) as Json;
      },
    },

    // The email a message that rang them stands in for, when no phone could
    // take its push (decided now, when it is sent). A retry after a send
    // that was cut off may send it twice; a lost one is never sent.
    [WORK.mail]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        if (lateNotice(input.owedAt)) return { skipped: 'late' };
        const said = await legacy('services/activity-mail').emailIfNoPush(pool, input);
        return { said };
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
