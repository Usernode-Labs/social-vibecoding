// The session-activity machine's I/O: the retirement of a session's worker,
// once nothing uses the session any more.

import type { Json, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff } from '../github-work.ts';
import { WORK } from './machine.ts';

export function sessionActivityServices(): Record<string, WorkHandler> {
  return {
    // Its worker and Claude Code volume go. Deleting what is already gone
    // is a no-op, so a retry after a crash is safe.
    [WORK.retire]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        await legacy('services/worker').destroyCcVolume(input.sessionId);
        return { retired: true };
      },
    },
  };
}
