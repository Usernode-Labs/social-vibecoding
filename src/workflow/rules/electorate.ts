// Who counts toward a vote, and how many of them there are: the merge
// gate's denominator. services/active-users.js and services/governance.js
// re-export these; the governance machine reads them in its transaction.
// services/active-users.js's header explains the four concepts (activity,
// collab-eligibility, membership, a recent invite) that these queries
// combine.

import type { Queryable } from './db.ts';
import type { AppMeta, Governance } from './governance-gate.ts';

// Everyone who could be in a non-self-hosted app's electorate, before the
// eligibility, membership and test-account filters: concept #1 (used the
// app for a minute on some day, and visited in the last 10 days) or
// concept #4 (accepted an invite in the last 10 days). $1 is the app id.
// A derived table, so the vote-facing queries keep their alias `a`.
export const RECENT_PEOPLE_SQL = `(
             SELECT x.user_id FROM app_activity x
              WHERE x.app_id = $1
                AND x.date >= CURRENT_DATE - 10
                AND EXISTS (
                  SELECT 1 FROM app_activity b
                  WHERE b.app_id = $1
                    AND b.user_id = x.user_id
                    AND b.seconds_spent >= 60
                )
             UNION
             SELECT c.user_id FROM app_collaborators c
              WHERE c.app_id = $1 AND c.status = 'member'
                AND c.accepted_at >= CURRENT_DATE - 10
           )`;

// The Private community floor, as a scalar subquery over $1 (the app id).
// A community whose audience is 'invited' (a private project with more than
// its creator) counts at least min(people who can vote in it, 2), so two
// people stay two after the invite's 10 days run out and neither can merge
// a change alone. Only people whose vote would count are in that number:
// members who are also building members (a private project is always
// collab-private) and pass counts_toward_outcome, so a test account cannot
// raise the bar on a real person's project. Anything else, and every
// self-hosted app, floors at 1. The audience test is communities.js
// audienceSql written out, because a constant is what scripts/check-sql.js
// can check against the schema: not view-public, and more than one member
// or a pending invite.
export const INVITED_FLOOR_SQL = `SELECT CASE
                  WHEN NOT ap.self_hosted
                   AND ap.view_visibility IS DISTINCT FROM 'public'
                   AND ((SELECT COUNT(*) FROM community_members o WHERE o.community_id = ap.community_id) > 1
                        OR EXISTS (SELECT 1 FROM app_collaborators ic
                                    WHERE ic.app_id = ap.id AND ic.status = 'invited'))
                  THEN LEAST(2, (
                    SELECT COUNT(*) FROM community_members m
                      JOIN app_collaborators c
                        ON c.app_id = ap.id AND c.user_id = m.user_id AND c.status = 'member'
                     WHERE m.community_id = ap.community_id
                       AND counts_toward_outcome(m.user_id, ap.id)
                  ))
                  ELSE 1
                END
           FROM apps ap WHERE ap.id = $1`;

export interface ActiveStats { active: number; majority: number }

// The vote denominator, for an app whose meta ({ selfHosted, collabPrivate })
// the caller has read. A test account (services/test-accounts.js) is left
// out of it on an app a real person made, by the same predicate that leaves
// its vote out of the tally (counts_toward_outcome, schema.sql): an admin who
// can mint accounts must not be able to raise a real app's threshold with
// them. On an app a test account made, test accounts count like anybody.
export async function activeUserStats(db: Queryable, appId: number, meta: AppMeta): Promise<ActiveStats> {
  const { selfHosted, collabPrivate } = meta;

  const { rows } = selfHosted
    ? await db.query(
        `SELECT COUNT(DISTINCT a.user_id) AS cnt
           FROM app_activity a
           WHERE a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )
             AND counts_toward_outcome(a.user_id, $1)
             AND EXISTS (
               SELECT 1 FROM apps ap
                WHERE ap.id = $1
                  AND (ap.community_id IS NULL OR EXISTS (
                    SELECT 1 FROM community_members cm
                     WHERE cm.community_id = ap.community_id AND cm.user_id = a.user_id
                  ))
             )`,
        [appId],
      )
    : await db.query(
        `SELECT COUNT(DISTINCT a.user_id) AS cnt,
                (${INVITED_FLOOR_SQL}) AS invited_floor
           FROM ${RECENT_PEOPLE_SQL} a
           WHERE (NOT $2::boolean OR EXISTS (
               SELECT 1 FROM app_collaborators c
               WHERE c.app_id = $1 AND c.user_id = a.user_id AND c.status = 'member'
             ))
             AND counts_toward_outcome(a.user_id, $1)
             AND EXISTS (
               SELECT 1 FROM apps ap
                WHERE ap.id = $1
                  AND (ap.community_id IS NULL OR EXISTS (
                    SELECT 1 FROM community_members cm
                     WHERE cm.community_id = ap.community_id AND cm.user_id = a.user_id
                  ))
             )`,
        [appId, collabPrivate],
      );
  // Floor at 1 so the vote machinery's majority threshold is never
  // 0/0; this is a vote-correctness floor, not a real-count guarantee.
  // A Private community floors higher (`invited_floor`, see
  // INVITED_FLOOR_SQL); the self-hosted query has no such column.
  const active = Math.max(parseInt(rows[0].cnt, 10) || 0, parseInt(rows[0].invited_floor, 10) || 0, 1);
  const majority = Math.floor(active / 2) + 1;
  return { active, majority };
}

// The full set of user ids currently counted as active for an app,
// using the same definition as getActiveUserStats (so "who gets the
// vote-request ping" matches "whose votes count"). That includes its test
// account rule: a test account is left out on an app a real person made
// (counts_toward_outcome), so the vote pings, the weekly digest and every
// other list read from here go to real people only, and on an app a test
// account made it is listed like anybody. Returns a bare array of ids.
// self_hosted apps fan out across every app's activity, mirroring
// getActiveUserStats's union semantics.
export async function activeUserIds(db: Queryable, appId: number, meta: AppMeta): Promise<number[]> {
  const { selfHosted, collabPrivate } = meta;

  const { rows } = selfHosted
    ? await db.query(
        `SELECT DISTINCT a.user_id AS id
           FROM app_activity a
           WHERE a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )
             AND counts_toward_outcome(a.user_id, $1)
             AND EXISTS (
               SELECT 1 FROM apps ap
                WHERE ap.id = $1
                  AND (ap.community_id IS NULL OR EXISTS (
                    SELECT 1 FROM community_members cm
                     WHERE cm.community_id = ap.community_id AND cm.user_id = a.user_id
                  ))
             )`,
        [appId],
      )
    : await db.query(
        `SELECT DISTINCT a.user_id AS id
           FROM ${RECENT_PEOPLE_SQL} a
           WHERE (NOT $2::boolean OR EXISTS (
               SELECT 1 FROM app_collaborators c
               WHERE c.app_id = $1 AND c.user_id = a.user_id AND c.status = 'member'
             ))
             AND counts_toward_outcome(a.user_id, $1)
             AND EXISTS (
               SELECT 1 FROM apps ap
                WHERE ap.id = $1
                  AND (ap.community_id IS NULL OR EXISTS (
                    SELECT 1 FROM community_members cm
                     WHERE cm.community_id = ap.community_id AND cm.user_id = a.user_id
                  ))
             )`,
        [appId, collabPrivate],
      );
  return rows.map((r) => r.id);
}

// The approver electorate for an 'invited'-policy app: member rows in
// app_approvers, or (when the roster is empty) every full admin, so an app
// can never make its own merge gate unreachable. Returns { ids, adminFallback }.
export async function getApproverSet(db: Queryable, appId: number): Promise<{ ids: number[]; adminFallback: boolean }> {
  const { rows } = await db.query(
    `SELECT user_id FROM app_approvers WHERE app_id = $1 AND status = 'member'`,
    [appId],
  );
  if (rows.length) return { ids: rows.map((r) => r.user_id), adminFallback: false };
  const { rows: admins } = await db.query(
    `SELECT id FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE`,
  );
  return { ids: admins.map((r) => r.id), adminFallback: true };
}

export interface Electorate { active: number; approverIds: number[] | null; adminFallback: boolean }

// Who counts, and how many of them there are. 'anyone' → the active-user
// stats (approverIds null = count every vote); 'invited' → the approver
// member set (admin fallback when empty). `stats` is how the active count
// is read: services/governance.js passes services/active-users.js's export,
// so a test that stubs that module still reaches the count it stubbed.
export async function electorate(
  db: Queryable, appId: number, gov: Governance, meta: AppMeta,
  stats: (db: Queryable, appId: number, meta: AppMeta) => Promise<ActiveStats> = activeUserStats,
): Promise<Electorate> {
  if (gov.approverPolicy === 'invited') {
    const { ids, adminFallback } = await getApproverSet(db, appId);
    return { active: Math.max(ids.length, 1), approverIds: ids, adminFallback };
  }
  const { active } = await stats(db, appId, meta);
  return { active, approverIds: null, adminFallback: false };
}
