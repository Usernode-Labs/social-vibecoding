import { randomUUID } from 'node:crypto';
import type { Queryable, Runtime, EventOutcome } from '../kernel/index.ts';
import { MACHINE, WORK, WAIT_MS, stopKey, failure } from './machine.ts';
import type { Result } from './machine.ts';
import type { Target } from './target.ts';
import { legacyTurnKey, snapshot, stopTarget } from './target.ts';

function fail(result: Result): never {
  if (result.ok) throw new Error('Expected a failed stop');
  throw Object.assign(new Error(result.message), { code: result.code, httpStatus: result.status });
}
export interface StopRequest {
  sessionId: number; userId: number; expectedTurnId?: string | null; expectedJob?: Pick<Target, 'active' | 'turnId' | 'journal'> & { legacy?: string | null };
}
export async function prepareStop(db: Queryable, p: Omit<StopRequest, 'userId'> & { userId: number | null }, { allowIdentityless = false } = {}) {
  const current = await stopTarget(db, p.sessionId, p.userId);
  if (!current) fail(failure('not_authorized', 'Session not found', 404));
  if (!current.active && (p.expectedJob?.active || p.expectedTurnId)) return null;
  if (p.expectedTurnId && current.turnId !== p.expectedTurnId) fail(failure('turn_changed', 'The running job changed. Retry Stop.', 409));
  if (p.expectedJob && (current.active !== p.expectedJob.active || current.turnId !== p.expectedJob.turnId || current.journal !== p.expectedJob.journal
      || (p.expectedJob.legacy && p.expectedJob.legacy !== legacyTurnKey(current.turn)))) {
    fail(failure('turn_changed', 'The running job changed. Retry Stop.', 409));
  }
  if (current.active && !current.turnId && !current.journal && !(allowIdentityless && legacyTurnKey(current.turn))) {
    fail(failure('turn_changed', 'The running job has no safe stop identity.', 409));
  }
  return current;
}

export async function requireAcceptedStop(runtime: Runtime, out: EventOutcome, { allowCoalesced = false } = {}) {
  const settled = out.status === 'pending' ? (await runtime.refuseIfPending(out.eventId, 'stop_unavailable')) ?? out : out;
  if (allowCoalesced && settled.status === 'rejected' && settled.reason === 'already_stopping') return;
  if (!['accepted', 'replayed'].includes(settled.status)) {
    fail(settled.reason === 'not_authorized' ? failure('not_authorized', 'Session not found', 404)
      : settled.reason === 'turn_changed' || settled.reason === 'scope_mismatch'
        ? failure('turn_changed', 'The running job changed. Retry Stop.', 409) : failure());
  }
}

// Leave a short wait after the runtime budget for ledger settlement and
// the machine to record its result.
export async function requestWorkerStop(runtime: Runtime, db: Queryable, p: StopRequest, waitMs = WAIT_MS + 5_000) {
  const current = await prepareStop(db, p);
  if (!current) return { ok: true as const, stopped: true as const };
  const requestId = randomUUID(); const key = stopKey(p.sessionId, requestId);
  const out = await runtime.appendAndWait(MACHINE, key, { type: 'Requested', payload: {
    ...snapshot(current), userId: p.userId, requestId,
  } }, { appId: current.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK }, requestKey: requestId });
  await requireAcceptedStop(runtime, out);
  const done = await runtime.waitFor(MACHINE, key, i => i.state === 'done', waitMs);
  const result = done?.data?.result as Result | undefined;
  if (!result || !result.ok) fail(result || failure());
  return result;
}
