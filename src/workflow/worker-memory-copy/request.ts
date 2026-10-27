import { randomUUID } from 'node:crypto';
import type { Runtime } from '../kernel/index.ts';
import type { Request } from './target.ts';
import { MACHINE, WORK, WAIT_MS, copyKey } from './machine.ts';

// Same bounded, best-effort contract as the old synchronous copy. Admission
// left pending by an older conductor is refused, never applied hours later.
export async function requestWorkerMemoryCopy(runtime: Runtime, p: Omit<Request, 'requestId'>) {
  const requestId = randomUUID(); const key = copyKey(p.sessionId);
  const out = await runtime.appendAndWait(MACHINE, key, { type: 'Requested', payload: { ...p, requestId } },
    { appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK }, requestKey: requestId });
  const settled = out.status === 'pending' ? (await runtime.refuseIfPending(out.eventId, 'copy_unavailable')) ?? out : out;
  if (!['accepted', 'replayed'].includes(settled.status) && settled.reason !== 'already_requested') return { copied: false };
  const instance = await runtime.waitFor(MACHINE, key, i => i.state === 'done', WAIT_MS + 10000);
  return { copied: instance?.data?.result?.copied === true };
}
