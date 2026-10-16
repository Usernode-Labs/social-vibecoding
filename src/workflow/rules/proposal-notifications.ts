// What the bell says as a proposal moves through its lifecycle: the vote
// requests when it goes up for a vote (pr_proposed), its author's "your agent
// put it up" when an agent did (connector_submitted), and the "gone quiet"
// warning (stale_pr). The proposal machine writes them in the transition that
// makes the move; services/notifications.js re-exports them, so there is one
// copy. A notification row rings the phone through its own trigger, and the
// machine pushes its id (the relaying process reads it for the open tabs).

import type { Queryable } from './db.ts';
import { activeUserIds } from './electorate.ts';
import { appMetaFromRow } from './governance-gate.ts';
import { allowsKind, filterUsersByCategory } from './notification-preferences.ts';
import { firstVersionSql } from './first-version.ts';

export interface NotificationRow {
  id: number; user_id: number; app_id: number | null; session_id: number | null; source_user_id: number | null;
  kind: string; detail?: string | null; created_at: Date | string;
}

// What a caller outside the machine may pass instead (services/notifications.js
// passes services/active-users.js's and notification-preferences.js's
// exports, so a test that stubs those modules still reaches them).
export interface FanOutDeps {
  activeIds?: (db: Queryable, appId: number) => Promise<number[]>;
  byCategory?: typeof filterUsersByCategory;
}

async function appActiveIds(db: Queryable, appId: number): Promise<number[]> {
  const { rows: [a] } = await db.query('SELECT self_hosted, collab_visibility FROM apps WHERE id = $1', [appId]);
  return activeUserIds(db, appId, appMetaFromRow(a));
}

// Collab-private apps: only collaborators can vote, so only they get nudged
// (a favoriter of a view-public/collab-private app would otherwise be asked
// to vote on a PR they can't act on).
async function onlyCollaborators(db: Queryable, appId: number, userIds: number[]): Promise<number[]> {
  if (!appId || !userIds.length) return userIds;
  const { rows: [a] } = await db.query('SELECT collab_visibility FROM apps WHERE id = $1', [appId]);
  if (a?.collab_visibility !== 'private') return userIds;
  const { rows } = await db.query(
    `SELECT user_id FROM app_collaborators
      WHERE app_id = $1 AND status = 'member' AND user_id = ANY($2::int[])`,
    [appId, userIds]);
  const members = new Set(rows.map((r) => r.user_id));
  return userIds.filter((id) => members.has(id));
}

// A proposal went up for a vote: the app's active users (the people whose
// votes count), plus its creator and favoriters as a stakeholder floor, less
// the proposer. The platform's own app asks only its creator and
// favoriters: everyone active anywhere counts as active on it, and asking
// them all would ping the whole platform on every self-edit. Muted
// recipients (the new_proposals category, off by default) are left out, a
// recipient already asked about this proposal is not asked again, and
// nobody is asked to vote on a project's first version (it goes live
// without one).
export async function createPrProposedNotifications(
  db: Queryable, { appId, sessionId, proposerId }: { appId: number; sessionId: number; proposerId: number | null },
  deps: FanOutDeps = {},
): Promise<NotificationRow[]> {
  if (!appId || !sessionId) return [];
  const { rows: [app] } = await db.query('SELECT self_hosted FROM apps WHERE id = $1', [appId]);
  const active = app?.self_hosted ? [] : await (deps.activeIds || appActiveIds)(db, appId);
  const { rows: extra } = await db.query(
    `SELECT created_by AS id FROM apps WHERE id = $1 AND created_by IS NOT NULL
     UNION
     SELECT user_id AS id FROM app_favorites WHERE app_id = $1`,
    [appId]);
  const all = new Set<number>([...active.map(Number), ...extra.map((r) => Number(r.id))]);
  if (proposerId != null) all.delete(Number(proposerId));
  let ids = await onlyCollaborators(db, appId, [...all]);
  if (!ids.length) return [];
  ids = await (deps.byCategory || filterUsersByCategory)(db, { userIds: ids, appId, categoryKey: 'new_proposals' });
  if (!ids.length) return [];
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT u, $2, $3, $4, 'pr_proposed'
       FROM UNNEST($1::int[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u AND n.session_id = $3 AND n.kind = 'pr_proposed'
      )
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions cs WHERE cs.id = $3 AND ${firstVersionSql('cs')}
        )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [ids, appId, sessionId, proposerId ?? null]);
  return rows;
}

// #1405: a connector session (or the owner's own agent, #3893) put work
// somewhere: the person whose agent did it hears so. `detail` is where it
// went ('submitted': up for a vote; 'shared': the in-progress area). Unread-
// deduped per session and detail.
export async function createConnectorSubmittedNotification(
  db: Queryable, { userId, appId, sessionId, detail }: { userId: number | null; appId: number | null; sessionId: number | null; detail?: string | null },
): Promise<NotificationRow[]> {
  if (!userId || !sessionId) return [];
  const kindDetail = (detail || 'submitted').slice(0, 32);
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, NULL, 'connector_submitted', $4::varchar
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'connector_submitted' AND n.detail IS NOT DISTINCT FROM $4
          AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId || null, sessionId, kindDetail]);
  return rows;
}

// A proposal up for a vote that nobody has looked at for a while: its author
// is warned once, unless they muted the kind. `allows` fails open (the quiet
// failure mode of the whole feature is a notification silently not
// arriving); the machine passes it as is.
export async function createStalePrNotification(
  db: Queryable, { userId, appId, sessionId }: { userId: number | null; appId: number | null; sessionId: number },
  allows: typeof allowsKind = allowsKind,
): Promise<NotificationRow[]> {
  if (!userId) return [];
  if (!await allows(db, { userId, appId, kind: 'stale_pr' })) return [];
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, NULL, 'stale_pr')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]);
  return rows;
}
