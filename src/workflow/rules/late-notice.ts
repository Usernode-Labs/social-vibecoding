// A notice owed as a machine's work (a DM's email, "stopped before
// finishing", "@ada approved it.") is said when it is owed, never hours
// later: work a rollback left queued runs on the next roll-forward, and a
// notice that late reads as wrong. `owedAt` is when the transition owed it
// (its input); work owed before the field existed has none and runs.

export const LATE_NOTICE_MS = 6 * 60 * 60 * 1000;

export function lateNotice(owedAt: unknown, now = Date.now()): boolean {
  const at = typeof owedAt === 'string' ? Date.parse(owedAt) : NaN;
  return Number.isFinite(at) && now - at > LATE_NOTICE_MS;
}
