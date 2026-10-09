// A holder's side of an activity's lease: renewed by a plain update, as the
// kernel renews its work items' leases (kernel/services.ts), never through
// the event stream. Only the lease moves; a lease that already ran out is
// not revived, because the machine may have granted the session to someone
// else since (wf_session_activities' trigger lets nothing else change).

import type { Queryable } from '../kernel/index.ts';
import { LEASE_MS } from './machine.ts';

export interface Renewal { held: boolean; stop: Record<string, unknown> | null }

export async function renewLease(db: Queryable, activityId: string): Promise<Renewal> {
  const { rows } = await db.query(
    `UPDATE wf_session_activities SET lease_until = now() + make_interval(secs => $2::float8 / 1000)
      WHERE id = $1 AND lease_until > now()
      RETURNING stop`, [activityId, LEASE_MS]);
  return rows.length ? { held: true, stop: rows[0].stop || null } : { held: false, stop: null };
}

// What readers see: per session, the kinds of its live activities and
// whether a stop is on its way to its turn. One indexed read for a list.
export async function readActivities(db: Queryable, sessionIds: number[]): Promise<Map<number, { kinds: Set<string>; stopping: boolean }>> {
  const out = new Map<number, { kinds: Set<string>; stopping: boolean }>();
  if (!sessionIds.length) return out;
  const { rows } = await db.query(
    `SELECT session_id, array_agg(DISTINCT kind) AS kinds, bool_or(stop_requested_at IS NOT NULL) AS stopping
       FROM wf_session_activities
      WHERE session_id = ANY($1::int[]) AND lease_until > now()
      GROUP BY session_id`, [sessionIds]);
  for (const r of rows) out.set(Number(r.session_id), { kinds: new Set(r.kinds), stopping: !!r.stopping });
  return out;
}
