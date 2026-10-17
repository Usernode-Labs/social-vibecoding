// The bot-voice machine's I/O: the Homeroom bot's turn in a place, a tap's
// act under one of its offers, a follow-up's report and a held request's
// answer. Each handler runs strict (a failure throws, so the item is retried
// rather than reporting success with nothing said) and is keyed so a retry
// after a restart says and does nothing twice: a reply by its mark in the
// place, an ask by its message, an offer's act by its claim, a post by its
// row (services/homeroom-bot-voice.js, homeroom-bot-holds.js).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { placeKey } from '../rules/bot-replies.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// 15 s, doubling, at most 5 minutes between tries: a reply is worth waiting
// for a few minutes, not an hour.
const backoff = (attempt: number) => Math.min(5 * 60 * 1000, 15 * 1000 * 2 ** (attempt - 1));

export function botVoiceServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const voice = () => legacy('services/homeroom-bot-voice');
  return {
    // One turn: what was said since `through`, answered or not (the gate
    // decides, as it always did). The reply carries the turn's mark.
    [WORK.turn]: {
      maxAttempts: 6,
      backoffMs: backoff,
      concurrency: 16,
      // A turn is a few model calls, each up to 45 s.
      leaseMs: 120 * 1000,
      async run({ input, key }): Promise<Json> {
        const turnKey = `${placeKey(Number(input.appId), input.place)}#${key}`;
        const out = await voice().runTurn(pool, config, {
          appId: Number(input.appId), place: input.place, through: Number(input.through) || 0, sorry: !!input.sorry, turnKey,
        });
        return { outcome: out?.outcome ?? null, throughId: out?.throughId ?? null, replyId: out?.replyId ?? null };
      },
    },

    // A tap under one of its offers: withdraw, propose closing, or file.
    [WORK.act]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await voice().actOnOffer(pool, config, {
          offerId: Number(input.offerId), userId: Number(input.userId), choice: String(input.choice), key: String(input.key),
        });
        return (out || null) as Json;
      },
    },

    // What came of a change people asked for here, said where they asked.
    [WORK.report]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await voice().sayReport(pool, config, {
          appId: Number(input.appId), place: input.place, sessionId: Number(input.sessionId),
          runTag: String(input.runTag), asks: input.asks, outcome: input.outcome || {},
        });
        return { sent: sent?.id ?? null };
      },
    },

    // The answer to a mention on a request a person holds: its post row,
    // written pending with the decision, said and closed here.
    [WORK.post]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/homeroom-bot-holds').sayHeld(pool, {
          appId: Number(input.appId), issueNumber: Number(input.issueNumber), kind: String(input.kind), text: String(input.text),
          mention: input.mention || null, mentions: Array.isArray(input.mentions) ? input.mentions : [],
        });
        return (out || null) as Json;
      },
    },
  };
}
