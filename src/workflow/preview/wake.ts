// The web side of a preview wake: append its request, then read the receipt
// of the conductor work. No Kubernetes writes or new workflow state here.
import { randomUUID } from 'node:crypto';
import type { Pool, Runtime } from '../kernel/index.ts';
import { MACHINE, sessionKey, WORK, wakeKey } from './machine.ts';

interface WakeResult {
  status: 'none' | 'awake' | 'woke' | 'failed' | 'timeout';
  url?: string; detail?: string; ms?: number;
}

export async function requestWake(rt: Runtime, pool: Pool,
  request: { sessionId: number; appId: number; reason: string; repairRoute: boolean },
  { waitMs = 285000, pollMs = 1000 }: { waitMs?: number; pollMs?: number } = {}): Promise<WakeResult> {
  const key = sessionKey(request.sessionId);
  const out = await rt.appendAndWait(MACHINE, key, { type: 'WakeRequested', payload: request },
    { requestKey: `preview-wake:${request.sessionId}:${randomUUID()}`, source: { kind: 'system', name: 'preview-wake' },
      appId: request.appId, waitMs: 2000 });
  if (!['accepted', 'replayed', 'pending'].includes(out.status)) {
    return { status: 'failed', detail: 'The preview is no longer available to wake' };
  }
  const deadline = Date.now() + waitMs;
  do {
    const { rows: [work] } = await pool.query(
      `SELECT status, result, last_error FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 AND work_key = $4`,
      [MACHINE, key, WORK.wake, wakeKey(out.eventId)]);
    if (work && ['reported', 'settled'].includes(work.status)) {
      if (work.result?.outcome === 'succeeded') return work.result.value;
      return { status: 'failed', detail: work.last_error?.message || 'The preview could not be woken' };
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (Date.now() <= deadline);
  return { status: 'timeout', detail: 'The preview was asleep and did not wake in time' };
}
