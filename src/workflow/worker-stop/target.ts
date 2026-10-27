import type { Queryable } from '../kernel/index.ts';

export interface Target {
  sessionId: number; appId: number | null; ownerId: number | null; userId: number | null;
  configVersion: number; active: boolean; turnId: string | null; journal: string | null; usedAt: string | null;
}
export interface Current extends Target { username: string; turn: any }

// A null actor is reserved for the conductor's last recovery attempt. Human
// requests always carry an actor, whose current authority is read here.
export async function stopTarget(db: Queryable, sessionId: number, userId: number | null): Promise<Current | null> {
  const { rows: [r] } = await db.query(
    `SELECT cs.app_id, cs.user_id, cs.agent_config_version, cs.active_turn,
            sw.last_used_at::text AS used_at, u.username
       FROM chat_sessions cs LEFT JOIN users u ON u.id = $2
       LEFT JOIN session_workers sw ON sw.session_id = cs.id
      WHERE cs.id = $1 AND ($2::int IS NULL OR (u.anonymised_at IS NULL
        AND (cs.user_id = $2 OR (u.is_admin AND NOT u.admin_readonly))))`, [sessionId, userId]);
  if (!r) return null;
  const turn = typeof r.active_turn === 'string' ? JSON.parse(r.active_turn) : r.active_turn;
  return { sessionId, userId, appId: r.app_id, ownerId: r.user_id, configVersion: r.agent_config_version,
    active: r.active_turn != null, turnId: turn?.turnId || turn?.logicalTurnId || turn?.turnUuid || null,
    journal: turn?.journal || null, usedAt: r.used_at ?? null, username: r.username, turn };
}

export function sameScope(a: Current | null, b: Target): a is Current {
  return !!a && a.appId === b.appId && a.ownerId === b.ownerId && a.configVersion === b.configVersion;
}
export function sameTurn(a: Current, b: Target, removed = false): boolean {
  return a.active === b.active && a.turnId === b.turnId && a.journal === b.journal
    && (b.active || removed || a.usedAt === b.usedAt);
}
export function snapshot(r: Current): Target {
  const { username: _username, turn: _turn, ...out } = r;
  return out;
}
