// Who a merged proposal's announcement names, and the sentence that names
// them (#1688). The merge-followups machine writes the merged line and the
// author's notification with these inside its transaction; routes/votes.js
// re-exports them for [main]'s merge.

import type { Queryable } from './db.ts';
import { currentVotePredicateSql } from './vote-predicate.ts';

export interface Credits { author: string | null; backers: string[]; shapers: string[] }

// #1688: who to name when a proposal lands.
//   author  — the proposer.
//   backers — everyone whose Yes counted at merge, in vote order, the author
//             excluded (voting for your own is allowed; being thanked for it
//             reads oddly).
//   shapers — everyone else who took part: a No with a line on the version
//             that merged (an objection that did not stop it), or a word in
//             the proposal's thread before it landed. Nobody is named twice.
// `before` bounds the thread's speakers to those who spoke before it: the
// merge-followups machine names them when the change goes live, which can
// be well after the merge.
export async function mergeCredits(
  pool: Queryable, session: { id: number; app_id: number; user_id: number | null },
  { before = null }: { before?: string | null } = {},
): Promise<Credits> {
  const { rows: authorRows } = session.user_id
    ? await pool.query('SELECT username FROM users WHERE id = $1', [session.user_id])
    : { rows: [] };
  const author = authorRows[0]?.username || null;
  const { rows: votes } = await pool.query(
    `SELECT u.username, pv.vote, pv.reason
       FROM pr_votes pv
       JOIN users u ON u.id = pv.user_id
       JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1 AND ${currentVotePredicateSql('pv', 'cs')}
      ORDER BY pv.created_at ASC, pv.id ASC`,
    [session.id]
  );
  const { rows: talkers } = await pool.query(
    `SELECT u.username, MIN(cm.created_at) AS first_at
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.app_id = $1 AND cm.thread_type = 'session' AND cm.thread_ref = $2
        AND cm.msg_type = 'message'
        AND ($3::timestamptz IS NULL OR cm.created_at <= $3::timestamptz)
      GROUP BY u.username
      ORDER BY first_at ASC`,
    [session.app_id, session.id, before]
  );
  const seen = new Set<string>(author ? [author] : []);
  const backers: string[] = [];
  for (const v of votes || []) {
    if (v.vote === 'yes' && v.username && !seen.has(v.username)) {
      seen.add(v.username);
      backers.push(v.username);
    }
  }
  const shapers: string[] = [];
  for (const v of votes || []) {
    if (v.vote === 'no' && v.reason && v.username && !seen.has(v.username)) {
      seen.add(v.username);
      shapers.push(v.username);
    }
  }
  for (const t of talkers || []) {
    if (t.username && !seen.has(t.username)) {
      seen.add(t.username);
      shapers.push(t.username);
    }
  }
  return { author, backers, shapers };
}

// "alice", "alice and bob", "alice, bob and carol", "… and 2 more" past
// eight — the announcement is a sentence, not a roll call.
function nameList(names: string[]): string {
  const list = names.slice(0, 8);
  const rest = names.length - list.length;
  if (rest > 0) return `${list.join(', ')} and ${rest} more`;
  return list.length <= 1
    ? list.join('')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// "Built by evan, backed by alice and bob, shaped by carol." The author is
// left out for the push that goes to the author. With nobody to name, the
// wording the announcement carried before #1688.
export function creditsSentence(credits: Partial<Credits>, { withAuthor = true }: { withAuthor?: boolean } = {}): string {
  const parts: string[] = [];
  if (withAuthor && credits.author) parts.push(`Built by ${credits.author}`);
  if (credits.backers?.length) parts.push(`${parts.length ? 'backed' : 'Backed'} by ${nameList(credits.backers)}`);
  if (credits.shapers?.length) parts.push(`${parts.length ? 'shaped' : 'Shaped'} by ${nameList(credits.shapers)}`);
  if (!parts.length) return withAuthor ? 'Thanks to everyone who voted' : '';
  return `${parts.join(', ')}.`;
}

