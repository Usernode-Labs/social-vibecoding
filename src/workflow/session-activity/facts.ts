// What the session-activity machine reads inside a transition, in one
// statement: which of the session's activities still have a running lease,
// and the turn its journal (chat_sessions.active_turn) records. Nothing is
// locked: holders renew their leases outside the pipeline, as the kernel's
// work items do, and a lease that runs out while this transition decides
// only makes it more careful.

import type { Tx } from '../kernel/index.ts';

// A journal in one of these phases is a turn still running or about to be
// resumed (services/turn-lifecycle.js RECOVERABLE_PHASES, legacy phases
// included). One without a phase is a detached turn from before phases.
// cleanup_pending and quarantined turns run nothing.
export const LIVE_TURN_PHASES: ReadonlySet<string> = new Set([
  'dispatch_pending', 'executing', 'tail_pending', 'tail', 'retry_pending', 'retry_dispatch_pending',
]);

export interface Facts {
  live: Set<string>;
  journal: { turnId: string | null; live: boolean } | null;
}

export async function readFacts(tx: Tx, sessionId: number): Promise<Facts> {
  const { rows: [r] } = await tx.query(
    `SELECT ARRAY(SELECT id::text FROM wf_session_activities WHERE session_id = $1 AND lease_until > now()) AS live,
            cs.active_turn IS NOT NULL AND cs.active_turn <> 'null'::jsonb AS has_turn,
            cs.active_turn->>'turnId' AS turn_id,
            COALESCE(cs.active_turn->>'phase', 'executing') AS phase
       FROM (SELECT 1) one LEFT JOIN chat_sessions cs ON cs.id = $1`,
    [sessionId]);
  return {
    live: new Set<string>(r?.live || []),
    journal: r?.has_turn ? { turnId: r.turn_id || null, live: LIVE_TURN_PHASES.has(r.phase) } : null,
  };
}
