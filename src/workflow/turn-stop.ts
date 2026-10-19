// Stopping a coding turn that workflow work started, from any process: the
// one work handler every machine that starts turns registers (proposal's
// sync, the shots agent, the Homeroom bot's builds, reads and fixes, a
// bench trial). Its machine queues it, in the transition that decides the
// turn is over (a person's Stop, a merge, a close, a request merged, a
// person writing during a read), beside cancelling the turn's own work
// item: the kernel's cancel ends the handler, never the turn, and a turn
// whose handler is gone runs on with no clock. So this:
//   - stamps the turn's record stopped (by whom), only if the record is
//     this instance's turn (its owner, written with the claim by
//     execInWorker), so a newer turn or a person's own is never touched;
//   - kills only that turn, by its journal (worker.stopTurnByJournal);
//   - with `release`, releases its record, which the cancelled work would
//     otherwise have released.
// A Stop that lands before the turn exists needs no kill: the cancelled
// item's next checkpoint refuses the dispatch (durable-turn's onTurnRecord)
// and execInWorker releases the record it wrote. One landing between the
// record and the exec (no journal to kill yet, the record released here) is
// read by execInWorker right after the exec: a record stamped, gone or now
// another turn's, and the turn is killed by its journal. `workKey` fences
// the stop to the item whose turn it is.

import type { Json, Pool, WorkHandler } from './kernel/index.ts';
import { legacy } from './legacy.ts';
import { TURN_STOP } from './rules/turn-stop.ts';

export { TURN_STOP, turnStop, isTurnStop, turnOwner } from './rules/turn-stop.ts';
export type { TurnStopInput } from './rules/turn-stop.ts';

export function turnStopServices({ pool }: { pool: Pool }): Record<string, WorkHandler> {
  return {
    [TURN_STOP]: {
      maxAttempts: 8,
      backoffMs: (attempt) => Math.min(60_000, 2000 * 2 ** (attempt - 1)),
      concurrency: 16,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/worker').stopOwnedTurn(pool, {
          sessionId: Number(input.sessionId), machine: String(input.machine), key: String(input.key),
          kinds: Array.isArray(input.kinds) ? input.kinds.map(String) : [],
          workKey: input.workKey == null ? null : String(input.workKey),
          by: input.by == null ? null : String(input.by), release: input.release !== false,
        });
        return JSON.parse(JSON.stringify(out ?? null)) as Json;
      },
    },
  };
}
