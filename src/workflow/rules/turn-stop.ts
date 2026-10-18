// The work request that stops a coding turn workflow work started, as the
// machines that start turns ask for it in a transition (src/workflow/
// turn-stop.ts runs it). Pure: types and a request builder only.

import type { Json, WorkRequest } from '../kernel/index.ts';

export const TURN_STOP = 'turn.stop';

export interface TurnStopInput {
  sessionId: number;
  // The instance whose turn it is, and the kinds of its work that run turns.
  machine: string;
  key: string;
  kinds: string[];
  by: string | null;
  release: boolean;
}

// The work request a transition adds. `tag` tells two stops of one
// instance apart (a merge's, then a close's): the same tag twice is one stop.
export function turnStop(i: TurnStopInput, tag: string): WorkRequest {
  return {
    kind: TURN_STOP,
    key: `stop:${i.sessionId}:${tag}`,
    input: { sessionId: i.sessionId, machine: i.machine, key: i.key, kinds: i.kinds, by: i.by, release: i.release } as Json,
  };
}

// The owner a work handler hands its turn's dispatch (execInWorker's
// `owner`): its instance and its own item, so the record names both.
export function turnOwner(ctx: { workId: string; kind: string; key: string }, machine: string, key: string): Json {
  return { machine, key, kind: ctx.kind, workKey: ctx.key, workId: ctx.workId };
}

// True for a result of this work, which every machine that queues it
// settles and otherwise ignores.
export const isTurnStop = (kind: unknown): boolean => kind === TURN_STOP;
