// bot-look: one look into a project's code that a person's chat with the
// Homeroom bot started (look_into, services/homeroom-bot-thread-tools/
// look-into.js). One instance per look (`look:<id>`, its row in
// homeroom_bot_looks):
//
//   (none) ──Requested──▶ looking ──its run ends──▶ done
//                            ├──the run failed for good──▶ failed
//                            └──the run met OpenRouter's credit──▶ held
//
//   held ──CreditBack──▶ looking (the look runs again, once) ──▶ done
//        └──a newer look of theirs exists──▶ done (superseded)
//
// The look is one resumable work item, `look.run`: a read-only turn of the
// bot's in a worker, on durable steps over the item's checkpoint, so a
// restart that takes the process leaves the turn to the next one, which
// follows it to its end (services/durable-turn.js) rather than starting it
// again. Where the turn is, and whether its findings were posted, is that
// checkpoint and the look's row, not more states here (the kernel's rule 5).
// The chat that asked waits on the row for a few minutes; one that stopped
// waiting has its findings posted when the run ends (`deliver = 'post'`).
//
// #6920 (20 Nov 2026): a look whose turn met OpenRouter's credit waits in
// `held` and runs once credit is back (the bot-lane's CreditBack), under a
// key of that round's own (`run:r<n>`). A newer look by the same person into
// the same project replaces it, and nothing is run. A run that fails for
// good is recorded as failed, and said in that chat when it stopped waiting
// (`look.failed`).
//
// #6537: the same machine runs an update of a change its author made in
// Claude Code or Codex and asked the bot for (a row of kind 'update',
// services/homeroom-bot-takeover.js): one build turn on that change's own
// branch, on the same durable steps, its report said where the asks were
// made. look-into.js runLookWork hands such a row over.

import { NONE, appendEvent, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Outcome, Queryable, State, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { BOT_LANE } from '../rules/bot-loop.ts';

export const MACHINE = 'bot-look';
export const lookKey = (id: number) => `look:${id}`;
export const WORK = Object.freeze({ run: 'look.run', failed: 'look.failed' });

export interface Data {
  lookId: number; userId: number; requestedAt: string; endedAt?: string; error?: string | null;
  // #6920: how many times credit's return has run it this time.
  rounds?: number;
  // Why a held look was not run: `superseded` by a newer one.
  dropped?: string;
}
type S = State<Data>;

const id = (v: unknown, what: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) <= 0 || (v as number) > 2 ** 53) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const decodeRequested = (p: any) => ({ lookId: id(p?.lookId, 'lookId'), userId: id(p?.userId, 'userId') });

const runResult = (e: Event<any>) => /^run(?::r\d+)?$/.test(String((e.payload as WorkResultPayload).workKey));

/** Ask for look `lookId` to run: keyed by the look, so asking again is the same request. */
export function requestLook(db: Queryable, p: { lookId: number; appId: number; userId: number }): Promise<number> {
  return appendEvent(db, MACHINE, lookKey(p.lookId), { type: 'Requested', payload: { lookId: p.lookId, userId: p.userId } },
    { requestKey: `look:${p.lookId}`, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'system', name: 'look_into' } });
}

function failed(s: S, e: Event<any>, now: Date): Outcome<S> {
  const error = (e.payload as WorkResultPayload).error;
  const d: Data = { ...s.data, endedAt: now.toISOString(), error: String(error?.message || 'the look failed').slice(0, 500) };
  return { next: { name: 'failed', data: d }, work: [{ kind: WORK.failed, key: 'failed', input: { lookId: d.lookId } }] };
}

// CreditBack: the bot's lane's message, or the system.
const fromLane = (e: Event<any>): Check => ((e.source.kind === 'message' && e.source.from?.machine === BOT_LANE)
  || e.source.kind === 'system' ? ok() : reject('not_the_lane'));

interface Facts {
  // CreditBack on a held look: a newer look of the same person's into the
  // same project exists, so this one is not run.
  newer: boolean;
}
const NO_FACTS: Facts = { newer: false };

async function readFacts(tx: Tx, state: S, event: Event<any>): Promise<Facts> {
  if (event.type !== 'CreditBack' || state.name !== 'held') return NO_FACTS;
  const { rows } = await tx.query(
    `SELECT 1 FROM homeroom_bot_looks n JOIN homeroom_bot_looks o ON o.id = $1
      WHERE n.kind = 'look' AND n.id > o.id AND n.user_id = o.user_id AND n.app_id = o.app_id
      LIMIT 1`, [Number((state.data as Data).lookId)]);
  return { newer: rows.length > 0 };
}

export function botLook() {
  const keyed = (to: (s: S, e: Event<any>, f: Facts, ctx: any) => Outcome<S>) => ({
    guard: (s: S, _e: Event<any>, _f: Facts, ctx: any): Check =>
      (ctx.key === lookKey((s.data as Data).lookId) ? ok() : reject('key_mismatch')),
    to,
  });
  return defineMachine<S, Facts>({
    name: MACHINE,
    // 2 (20 Nov 2026): a look held for OpenRouter's credit (`held`,
    // `rounds`), resumed on CreditBack. An older release leaves the
    // instances this one wrote alone.
    version: 2,
    retainDays: 14,
    events: { Requested: decodeRequested, CreditBack: () => ({}) },
    create: ['Requested'],
    // Nothing from web: the bot's own tool asks for a look, on the conductor.
    web: [],
    terminal: ['done', 'failed'],
    decode: (row) => ({ name: row.state, data: row.data as Data }),
    facts: (tx: Tx, state: S, event: Event<any>) => readFacts(tx, state, event),
    authorize: {
      // The chat's answer (its work item) asks; an admin may ask again.
      Requested: (e) => (['system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
      CreditBack: fromLane,
    },
    transitions: {
      [NONE]: {
        Requested: {
          to: (_s, e, _f, ctx): Outcome<S> => ({
            next: { name: 'looking', data: { lookId: e.payload.lookId, userId: e.payload.userId, requestedAt: ctx.now.toISOString() } },
            work: [{ kind: WORK.run, key: 'run', input: { lookId: e.payload.lookId } as Json }],
          }),
        },
        CreditBack: { ignore: 'nothing_owed' },
      },
      looking: {
        Requested: { ignore: 'already_looking' },
        WorkSucceeded: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_look')),
          to: (s, e, _f, ctx) => ((e.payload.result as any)?.credit === true
            ? { next: { name: 'held', data: { ...s.data, endedAt: ctx.now.toISOString() } } }
            : { next: { name: 'done', data: { ...s.data, endedAt: ctx.now.toISOString() } } }),
        },
        WorkFailed: { guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_look')), to: (s, e, _f, ctx) => failed(s, e, ctx.now) },
        WorkExhausted: { guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_look')), to: (s, e, _f, ctx) => failed(s, e, ctx.now) },
        CreditBack: { ignore: 'not_held' },
      },
      // Held for OpenRouter's credit. A newer look of theirs replaces it.
      held: {
        CreditBack: keyed((s, _e, f, ctx): Outcome<S> => {
          if (f.newer) {
            return { next: { name: 'done', data: { ...s.data, endedAt: ctx.now.toISOString(), dropped: 'superseded' } } };
          }
          const round = (s.data.rounds || 0) + 1;
          const work: WorkRequest[] = [{
            kind: WORK.run, key: `run:r${round}`, input: { lookId: s.data.lookId } as Json,
          }];
          return {
            next: { name: 'looking', data: { ...s.data, rounds: round, endedAt: undefined, error: null } },
            work,
          };
        }),
        '*': { ignore: 'held' },
      },
      // Terminal states still take their work's results (the kernel's rule 7).
      done: { '*': { ignore: 'ended' } },
      failed: { '*': { ignore: 'ended' } },
    },
  });
}
