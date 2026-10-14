// bot-build: a Homeroom bot build, or an App bench trial, from the moment it
// is started to its end (docs/plans/bot-build-workflow.md). One instance per
// build: `run:<runId>` for a live or a shadow build of the bot's,
// `trial:<trialId>` for a bench trial. The build itself is one resumable work
// item, `build.run`: its handler runs the build's pipeline on a durable
// context over the item's checkpoint, so a restart that takes the process
// leaves the item to the next leader, which carries the build on from the
// last step it saved. A run can be built more than once (its plan, then the
// build its requester said Build it to; a shadow build the lane takes again
// after a platform fault), so the key carries what tells those apart:
// `run:<runId>@<nonce>`. Where the build is inside its pipeline is that
// checkpoint, not more states here (the kernel's rule 5).
//
// A build whose handler fails for good (it kept throwing, or kept taking its
// process down) ends `failed`, and `build.lost` records why where the build
// is read: the run's outcome and its note on the request, or the trial's row.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, State, WorkResultPayload } from '../kernel/index.ts';

export const MACHINE = 'bot-build';

export const TARGETS = ['live', 'shadow', 'trial'] as const;
export type Target = typeof TARGETS[number];

const NONCE = /^[A-Za-z0-9_.-]{1,40}$/;

export function buildKey(target: Target, id: number, nonce?: string | null): string {
  const base = target === 'trial' ? `trial:${id}` : `run:${id}`;
  return nonce && NONCE.test(nonce) ? `${base}@${nonce}` : base;
}

export const WORK = Object.freeze({ run: 'build.run', lost: 'build.lost' });

export interface Data {
  target: Target;
  id: number;
  nonce?: string | null;
  requestedAt: string;
  endedAt?: string;
  result?: Json;
  error?: { message: string; code: string | null } | null;
  lost?: boolean;
}
type S = State<Data>;

interface Requested { target: Target; id: number; nonce: string | null; input: Json }

function decodeRequested(payload: unknown): Requested {
  const p = payload as Partial<Requested> | null;
  if (!p || !TARGETS.includes(p.target as Target) || !Number.isInteger(p.id) || (p.id as number) <= 0) {
    throw new Error('Requested needs a target (live, shadow, trial) and a positive id');
  }
  if (p.nonce != null && (typeof p.nonce !== 'string' || !NONCE.test(p.nonce))) throw new Error('Requested has a malformed nonce');
  const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : {};
  return { target: p.target as Target, id: p.id as number, nonce: p.nonce ?? null, input: input as Json };
}

const runResult = (e: Event<any>) => (e.payload as WorkResultPayload).workKey === 'run';

export function botBuild() {
  return defineMachine<S, null>({
    name: MACHINE,
    version: 1,
    events: { Requested: decodeRequested },
    create: ['Requested'],
    terminal: ['done', 'failed'],
    decode: (row) => ({ name: row.state, data: row.data as Data }),
    authorize: {
      // The bot's dispatch and the bench lane start builds; an admin may
      // start one again from the console.
      Requested: (e) => (['system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
    },
    transitions: {
      [NONE]: {
        Requested: {
          to: (_s, e, _f, ctx): Outcome<S> => {
            const p = e.payload as Requested;
            return {
              next: { name: 'building', data: { target: p.target, id: p.id, nonce: p.nonce, requestedAt: ctx.now.toISOString() } },
              work: [{ kind: WORK.run, key: 'run', input: { ...(p.input as object), target: p.target, id: p.id, nonce: p.nonce } as Json }],
            };
          },
        },
      },
      building: {
        Requested: { ignore: 'already_building' },
        WorkSucceeded: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_build')),
          to: (s, e, _f, ctx) => ({
            next: { name: 'done', data: { ...s.data, endedAt: ctx.now.toISOString(), result: (e.payload as WorkResultPayload).result ?? null } },
          }),
        },
        WorkFailed: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_build')),
          to: (s, e, _f, ctx) => failed(s, e, ctx.now),
        },
        WorkExhausted: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_build')),
          to: (s, e, _f, ctx) => failed(s, e, ctx.now),
        },
      },
      // Terminal states still take their work's results (the kernel's rule 7).
      done: {
        '*': { ignore: 'ended' },
        WorkSucceeded: { ignore: 'ended' },
        WorkFailed: { ignore: 'ended' },
        WorkExhausted: { ignore: 'ended' },
      },
      failed: {
        '*': { ignore: 'ended' },
        WorkSucceeded: { to: (s) => ({ next: { ...s, data: { ...s.data, lost: true } } }) },
        WorkFailed: { to: (s) => ({ next: s }) },
        WorkExhausted: { to: (s) => ({ next: s }) },
      },
    },
  });
}

function failed(s: S, e: Event<any>, now: Date): Outcome<S> {
  const error = (e.payload as WorkResultPayload).error || { message: 'the build failed', code: null };
  const err = { message: String(error.message || 'the build failed').slice(0, 2000), code: error.code ?? null };
  return {
    next: { name: 'failed', data: { ...s.data, endedAt: now.toISOString(), error: err } },
    work: [{ kind: WORK.lost, key: 'lost', input: { target: s.data.target, id: s.data.id, nonce: s.data.nonce ?? null, error: err } as Json }],
  };
}
