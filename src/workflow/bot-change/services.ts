// The bot-change machine's I/O: what the Homeroom bot says and does about
// one of its changes once the machine decided it. Each handler sends only
// (the decision is the transition's), runs strict (a failure throws, so the
// item is retried instead of reporting success with nothing done), and is
// keyed so a retry after a crash says nothing twice: the DMs by their
// idempotency keys, the request's "It's live" by its post record.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// 30 s, doubling, at most 30 minutes between tries.
const backoff = (attempt: number) => Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** (attempt - 1));

export function botChangeServices({ pool }: Deps): Record<string, WorkHandler> {
  return {
    // Ready to try, once per approval epoch: the card in the requester's DM
    // (and its record, which the activity card reads), the approvers'
    // bells when nothing is broken, the chip on the message it was asked in.
    [WORK.ready]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const told = await legacy('services/homeroom-bot-dm').tellReady(pool, Number(input.sessionId),
          { epoch: Number(input.epoch), broken: Array.isArray(input.broken) ? input.broken : [] });
        return { messageId: told?.messageId ?? null, stale: !!told?.stale };
      },
    },

    // Its preview will not start: a quiet line, once per epoch.
    [WORK.stopped]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await legacy('services/homeroom-bot-dm').noteChangeStopped(pool, Number(input.sessionId),
          { why: 'preview', strict: true });
        return { messageId: sent?.messageId ?? null };
      },
    },

    // Back to the bot: its request queued for a fix round on `head`, and
    // the bot's loop woken in the same statement. `queued: false` with why
    // when the bot does not take it (off, not on this app, a failure that
    // looks like the platform's, which it tells the requester itself).
    [WORK.fix]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/homeroom-bot').queueChecksFix(pool, { sessionId: Number(input.sessionId), head: String(input.head) });
        return { queued: !!out?.queued, why: out?.why ?? null };
      },
    },

    // Failing checks the bot will not fix: its requester hears it needs a look.
    [WORK.needsLook]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await legacy('services/homeroom-bot-dm').noteNeedsLook(pool, { sessionId: Number(input.sessionId), why: 'checks', strict: true });
        return { messageId: sent?.messageId ?? null };
      },
    },

    // Merged: the bot's other work on the same request stops, bounded to
    // what had started before the merge (homeroom-bot.js).
    [WORK.merged]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/homeroom-bot').noteRequestMerged(pool, { id: Number(input.sessionId) },
          { before: input.before ?? null, strict: true });
        return (out || null) as Json;
      },
    },

    // Live: whoever the bot built it for hears it, in their DM.
    [WORK.liveDm]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await legacy('services/homeroom-bot-dm').noteProposalMerged(pool, { id: Number(input.sessionId) },
          { deps: { strict: true } });
        return { sent: !!sent };
      },
    },

    // Live: the request says it, on GitHub and in its thread, once.
    [WORK.livePost]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const { rows: [row] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [Number(input.sessionId)]);
        if (!row) return { gone: true };
        const posted = await legacy('services/homeroom-bot-live').announceLive(pool, { session: row, strict: true });
        return { posted: !!posted };
      },
    },
  };
}
