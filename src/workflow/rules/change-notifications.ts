// What the bell says about a change once it is decided: the author's "your
// change is live" (pr_merged), and the asks it settles. The merge-followups
// machine writes both inside its transaction; services/notifications.js
// re-exports them for [main]'s merge, its included changes and every close.

import type { Queryable } from './db.ts';
import { kindAllowed } from './notification-preferences.ts';

// 5 October (Page Turners): what a "Waiting for your approval" digest
// (services/vote-digest.js) counted that still waits on its reader: changes
// still up for approval, put up before it was sent, in a project they have a
// stake in (the digest's own PENDING_SQL), not theirs, not voted on by them
// since, and not in a project they blocked. A digest that named its one
// change counts only that one. Never more than the digest said: a project
// pinned since it was sent is not what it counted. Reads `n` (the
// notification) and is evaluated only for a digest's row.
//
// The settle below counts with one more condition, `waiting.id IS DISTINCT
// FROM $4` (the change being decided, or NULL): in the merge-followups
// machine's transaction the change still reads 'promoted' when it settles,
// because its projection writes 'merged' after the domain writes.
const DIGEST_WAITING_HEAD = `LEAST((
  SELECT COUNT(DISTINCT waiting.id)::int FROM chat_sessions waiting
   WHERE waiting.status = 'promoted'
`;
const DIGEST_WAITING_TAIL = `     AND COALESCE(waiting.promoted_at, waiting.created_at) <= n.created_at
     AND (n.session_id IS NULL OR waiting.id = n.session_id)
     AND waiting.user_id IS DISTINCT FROM n.user_id
     AND (EXISTS (SELECT 1 FROM app_favorites stake WHERE stake.app_id = waiting.app_id AND stake.user_id = n.user_id)
          OR EXISTS (SELECT 1 FROM apps made WHERE made.id = waiting.app_id AND made.created_by = n.user_id))
     AND NOT EXISTS (SELECT 1 FROM user_app_blocks waiting_block
                      WHERE waiting_block.user_id = n.user_id AND waiting_block.app_id = waiting.app_id)
     AND NOT EXISTS (SELECT 1 FROM pr_votes waiting_vote
                      WHERE waiting_vote.session_id = waiting.id AND waiting_vote.user_id = n.user_id)
), CASE WHEN n.detail ~ '^[0-9]{1,6}$' THEN n.detail::int ELSE 99 END)`;
export const DIGEST_WAITING_SQL = `${DIGEST_WAITING_HEAD}${DIGEST_WAITING_TAIL}`;
const DIGEST_WAITING_BUT_DECIDED_SQL = `${DIGEST_WAITING_HEAD}     AND waiting.id IS DISTINCT FROM $4::int
${DIGEST_WAITING_TAIL}`;

export async function createPrMergedNotification(
  pool: Queryable,
  { userId, appId, sessionId, forced = false, credits = null }:
    { userId: number | null; appId: number; sessionId: number; forced?: boolean; credits?: string | null },
  allows: (db: Queryable, q: { userId: number | null; appId?: number | null; kind: string }) => Promise<boolean> = kindAllowed,
): Promise<any[]> {
  if (!userId || !sessionId) return [];
  if (!await allows(pool, { userId, appId, kind: 'pr_merged' })) return [];
  const detail = forced
    ? 'forced'
    : (typeof credits === 'string' && credits.trim() ? credits.trim().slice(0, 255) : null);
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, NULL, 'pr_merged', $4
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3 AND n.kind = 'pr_merged'
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId, sessionId, detail]
  );
  return rows;
}

// 5 October (Page Turners): the asks about a change that its decision
// answers for everybody. Nobody is asked to vote on it, to say they still
// back it, or to revive it once it is live or closed, and a digest that
// named it alone has nothing left to count. "Ready to try" (change_ready) is
// settled apart, because a change that went live makes it news.
export const DECIDED_ASK_KINDS: readonly string[] = Object.freeze(['pr_proposed', 'stale_pr', 'revision_recheck', 'vote_digest']);

/**
 * "Waiting for your approval" digests that no longer count anything
 * (DIGEST_WAITING_SQL is 0) are read: of `userIds`, or of the people with a
 * stake in `appId` (its favoriters and its creator, as the digest reads
 * them), sent since `since` when given. One of the two scopes is required,
 * so it never reads every digest on the platform. Resolves the ids of the
 * people whose bell changed.
 */
export async function settleVoteDigests(
  pool: Queryable,
  { userIds = null, appId = null, since = null, decided = null }:
    { userIds?: unknown[] | null; appId?: unknown; since?: unknown; decided?: number | null } = {},
): Promise<number[]> {
  const ids = Array.isArray(userIds)
    ? [...new Set(userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : null;
  const app = Number.isSafeInteger(Number(appId)) && Number(appId) > 0 ? Number(appId) : null;
  if (!(ids && ids.length) && !app) return [];
  const { rows } = await pool.query(
    `UPDATE notifications n SET read_at = NOW()
      WHERE n.kind = 'vote_digest' AND n.read_at IS NULL
        AND ($1::int[] IS NULL OR n.user_id = ANY($1::int[]))
        AND ($2::int IS NULL OR n.user_id IN (
              SELECT stake.user_id FROM app_favorites stake WHERE stake.app_id = $2
              UNION
              SELECT made.created_by FROM apps made WHERE made.id = $2 AND made.created_by IS NOT NULL))
        AND ($3::timestamptz IS NULL OR n.created_at >= $3::timestamptz)
        AND ${DIGEST_WAITING_BUT_DECIDED_SQL} = 0
      RETURNING n.user_id`,
    [ids && ids.length ? ids : null, app, since || null, decided]
  );
  return [...new Set(rows.map((row) => Number(row.user_id)))];
}

/**
 * 5 October (Page Turners): change `sessionId` was decided, live
 * ('merged') or closed ('archived'), so the bell stops asking about it:
 *
 *   - the asks it answered (DECIDED_ASK_KINDS) are read;
 *   - "ready to try" rows: closed, they are read. Live, the newest one each
 *     person was sent is the news that it is live (the bell words it Live,
 *     from the change's status) and is unread again for whoever had not said
 *     yes to it, who did not see it go; the ones about older versions are
 *     read. Unread again, never a new row: nothing rings twice;
 *   - digests of several changes it was the last one waiting in are read.
 *
 * Everyone whose bell changed is returned, to hear `notifications_changed`
 * (which also re-badges their phone, mobile-push-badge.js): the merge-followups
 * machine pushes it with its transition, services/notifications.js after. A change still up for
 * approval (or gone) is left alone. Resolves the ids of the people told.
 * Callers run it after the change's status is written: the merge
 * (routes/votes.js), a change carried by another's merge
 * (included-changes.js) and every close (session-lifecycle.js
 * finalizeArchivedSession).
 *
 * `status` stands for the row's when the caller decides it in the same
 * transaction and writes it afterwards (the merge-followups workflow
 * machine); the digests then count the change as decided too.
 */
export async function settleDecidedChange(pool: Queryable, sessionId: unknown, { status = null }: { status?: string | null } = {}): Promise<number[]> {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const { rows: [session] } = await pool.query(
    `SELECT id, app_id, status, COALESCE(promoted_at, created_at) AS asked_from
       FROM chat_sessions WHERE id = $1`,
    [id]
  );
  if (session && status) session.status = status;
  if (!session || (session.status !== 'merged' && session.status !== 'archived')) return [];
  const touched = new Set<number>();
  const note = (rows: { user_id: unknown }[]) => { for (const row of rows) touched.add(Number(row.user_id)); };

  note((await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE session_id = $1 AND read_at IS NULL AND kind = ANY($2::text[])
      RETURNING user_id`,
    [id, DECIDED_ASK_KINDS]
  )).rows);

  if (session.status === 'merged') {
    // The newest "ready to try" each person was sent about it.
    const NEWEST = `n.id = (SELECT MAX(newest.id) FROM notifications newest
                             WHERE newest.user_id = n.user_id AND newest.session_id = n.session_id
                               AND newest.kind = 'change_ready')`;
    note((await pool.query(
      `UPDATE notifications n SET read_at = NOW()
        WHERE n.session_id = $1 AND n.kind = 'change_ready' AND n.read_at IS NULL AND NOT (${NEWEST})
        RETURNING n.user_id`,
      [id]
    )).rows);
    note((await pool.query(
      `UPDATE notifications n SET read_at = NULL
        WHERE n.session_id = $1 AND n.kind = 'change_ready' AND n.read_at IS NOT NULL AND ${NEWEST}
          AND NOT EXISTS (SELECT 1 FROM pr_votes said_yes
                           WHERE said_yes.session_id = n.session_id AND said_yes.user_id = n.user_id
                             AND said_yes.vote = 'yes')
        RETURNING n.user_id`,
      [id]
    )).rows);
  } else {
    note((await pool.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE session_id = $1 AND kind = 'change_ready' AND read_at IS NULL
        RETURNING user_id`,
      [id]
    )).rows);
  }

  for (const userId of await settleVoteDigests(pool, { appId: session.app_id, since: session.asked_from, decided: id })) {
    touched.add(userId);
  }
  return [...touched];
}
