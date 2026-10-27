import type { Queryable } from '../kernel/index.ts';
import { workedOnSql } from '../session-work.ts';

export interface Request {
  sourceId: number; sessionId: number; appId: number; userId: number; sourceOwnerId: number | null;
  sourceVersion: number; configVersion: number; ccSessionId: string; requestId: string;
}
export interface Target extends Request { expiresAt: number }

// Same app collaboration/membership rules as clone-headless, read again on
// the conductor. A ready system run may be adopted by another project member;
// the new session must belong to the requesting person and to that source.
export async function eligible(db: Queryable, p: Request, lock = false): Promise<boolean> {
  const share = lock ? ' FOR SHARE' : '';
  const { rows: [access] } = await db.query(
    `SELECT 1 FROM apps a JOIN users u ON u.id = $2
      WHERE a.id = $1 AND u.anonymised_at IS NULL AND u.has_platform_access
        AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.app_id = a.id AND b.user_id = u.id)
        AND (u.is_admin OR a.collab_visibility = 'public' OR EXISTS (
          SELECT 1 FROM app_collaborators c WHERE c.app_id = a.id AND c.user_id = u.id AND c.status = 'member'${share}))
        AND (u.is_admin OR a.community_id IS NULL OR EXISTS (
          SELECT 1 FROM community_members m WHERE m.community_id = a.community_id AND m.user_id = u.id${share}))
        ${lock ? 'FOR SHARE OF a, u' : ''}`, [p.appId, p.userId]);
  if (!access) return false;
  const { rows } = await db.query(
    `SELECT cs.id, cs.app_id, cs.user_id, cs.status, cs.is_headless, cs.headless_status,
            cs.cloned_from_session_id, cs.cc_session_id, cs.agent_thread_id, cs.agent_config_version,
            cs.cc_purged, ${workedOnSql({ memoryCopies: false })} AS busy,
            EXISTS (SELECT 1 FROM session_workers sw WHERE sw.session_id = cs.id) AS used
       FROM chat_sessions cs WHERE cs.id = ANY($1::int[]) ORDER BY cs.id${lock ? ' FOR UPDATE OF cs' : ''}`,
    [[p.sourceId, p.sessionId]]);
  const s = rows.find(r => r.id === p.sourceId); const d = rows.find(r => r.id === p.sessionId);
  return !!s && !!d && s.app_id === p.appId && d.app_id === p.appId
    && s.user_id === p.sourceOwnerId && d.user_id === p.userId
    && s.is_headless && s.headless_status === 'ready' && !s.cc_purged
    && s.cc_session_id === p.ccSessionId && s.agent_config_version === p.sourceVersion
    && !s.busy && !d.busy && !d.used && !d.is_headless && d.status === 'active'
    && d.cloned_from_session_id === p.sourceId && d.agent_config_version === p.configVersion
    && d.cc_session_id == null && d.agent_thread_id == null;
}
