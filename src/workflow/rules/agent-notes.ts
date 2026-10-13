// A change's agent conversation hears that the change closed: the note,
// and the change stops being the conversation's active one. The
// merge-followups machine writes it in the merge's transaction;
// services/agent-sessions.js wraps it for the merge and archive paths,
// which must never fail over a conversation note.

import type { Queryable } from './db.ts';

const positiveInt = (value: number) => (Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null);

// A row that belongs to the conversation itself rather than to any one
// change: a change starting, a change closing. `session_id` is NULL on
// purpose, so a change's own transcript slice stays exactly what it wrote.
export async function appendConversationEvent(
  pool: Queryable,
  { agentSessionId, content, event, metadata = {} }: { agentSessionId: number; content: string; event: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
     VALUES (NULL, $1, 'system', $2, $3::jsonb)`,
    [agentSessionId, content, JSON.stringify({ ...metadata, agentSessionEvent: event })],
  );
  await pool.query('UPDATE agent_sessions SET last_activity_at = NOW() WHERE id = $1', [agentSessionId]);
}

// The sentence the conversation gets when one of its changes closes.
export function closedSentence({ prNumber, outcome }: { prNumber: number | null; outcome: string }): string {
  const ref = prNumber ? `PR #${prNumber}` : 'The change';
  switch (outcome) {
    case 'merged': return `${ref} merged. It is part of the app now.`;
    case 'rejected': return `${ref} was set aside by the group's vote.`;
    case 'withdrawn': return `${ref} was withdrawn.`;
    case 'replaced': return `${ref} was replaced by a newer proposal.`;
    default: return `${ref} was closed.`;
  }
}

export interface ClosedChange { id: number; agent_session_id?: number | null; pr_number?: number | null }

// Posts a note to the parent conversation and, if the change was the active
// one, clears it so the next dispatch has to name a change. Errors throw:
// inside a transaction they fail it, and services/agent-sessions.js's
// noteChangeClosed turns them into a warning for its callers.
//
// `change` is the row the caller already holds. A classic session carries
// `agent_session_id: null`, and returns here without a query; a row that did
// not select the column (undefined) is looked up.
export async function changeClosed(pool: Queryable, { change, outcome }: { change: ClosedChange | null; outcome: string }): Promise<boolean> {
  if (!change || change.agent_session_id === null) return false;
  let agentSessionId = change.agent_session_id;
  let prNumber = change.pr_number || null;
  if (agentSessionId === undefined) {
    const { rows } = await pool.query(
      `SELECT agent_session_id, pr_number FROM chat_sessions
        WHERE id = $1 AND agent_session_id IS NOT NULL`,
      [change.id],
    );
    agentSessionId = rows.length ? rows[0].agent_session_id : null;
    prNumber = prNumber || (rows.length ? rows[0].pr_number : null);
  }
  const id = positiveInt(Number(agentSessionId));
  if (!id) return false;
  await pool.query(
    `UPDATE agent_sessions SET active_change_id = NULL
      WHERE id = $1 AND active_change_id = $2`,
    [id, change.id],
  );
  await appendConversationEvent(pool, {
    agentSessionId: id,
    content: closedSentence({ prNumber, outcome }),
    event: 'change_closed',
    metadata: { changeId: change.id, outcome },
  });
  return true;
}
