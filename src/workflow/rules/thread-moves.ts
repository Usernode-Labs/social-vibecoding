// Threads, stage 6 of #6019: what a thread move does to the rows, in the
// transaction that decides it. Two callers apply a move, and both come here:
// services/thread-moves.js, when every requester agreed or 24 hours passed
// with no objection, and the governance machine's apply
// (governance-proposal/machine.ts applyKind), when the project voted for it.
//
// A move only rewrites `thread_id`s; every row keeps its anchor
// (chat_messages `thread_type`/`thread_ref`), so a merge is undone by a
// split and nothing is lost either way.
//
//   merge: everything in thread `thread_id` goes into `input.into`, whose
//          lead stays its lead; the merged thread closes and points at it
//          (`merged_into`), so its number still opens the thread.
//   split: `input.items` leave for a thread of their own: the first
//          request's own thread when it had one (the one a merge closed,
//          reopened), else a new one led by it, or by the first change. A
//          request takes the changes built for it along.

interface Db { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }

export interface MoveItem { type: 'request' | 'change' | 'close' | 'decision'; number?: number; id?: number }

const ints = (values: unknown[]) => values.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);

export async function applyMerge(db: Db, move: { thread_id: number | string; input: any }): Promise<number> {
  const from = Number(move.thread_id);
  const into = Number(move.input?.into);
  if (!(into > 0) || into === from) throw new Error('thread-moves: a merge names another thread');
  await db.query('UPDATE requests SET thread_id = $2 WHERE thread_id = $1', [from, into]);
  await db.query('UPDATE issues SET thread_id = $2 WHERE thread_id = $1', [from, into]);
  // Each change carries its replies (the chat_sessions_carry_thread_messages trigger).
  await db.query('UPDATE chat_sessions SET thread_id = $2 WHERE thread_id = $1', [from, into]);
  await db.query('UPDATE chat_messages SET thread_id = $2 WHERE thread_id = $1', [from, into]);
  // What people chose for the merged thread holds for the one it went into,
  // unless they chose there too.
  await db.query(
    `INSERT INTO thread_followers (thread_id, user_id, muted_at)
     SELECT $2, user_id, muted_at FROM thread_followers WHERE thread_id = $1
     ON CONFLICT (thread_id, user_id) DO NOTHING`,
    [from, into]
  );
  await db.query('DELETE FROM thread_followers WHERE thread_id = $1', [from]);
  await db.query(
    `UPDATE threads SET merged_into = $2, state = 'closed', closed_at = NOW() WHERE id = $1`,
    [from, into]
  );
  return into;
}

export async function applySplit(db: Db, move: { app_id: number | string; thread_id: number | string; input: any }): Promise<number> {
  const appId = Number(move.app_id);
  const from = Number(move.thread_id);
  const items: MoveItem[] = Array.isArray(move.input?.items) ? move.input.items : [];
  const numbers = ints(items.filter((i) => i.type === 'request').map((i) => i.number));
  const changes = ints(items.filter((i) => i.type === 'change').map((i) => i.id));
  const decisions = ints(items.filter((i) => i.type === 'close' || i.type === 'decision').map((i) => i.id));
  if (!numbers.length && !changes.length && !decisions.length) throw new Error('thread-moves: a split names what it moves');
  // A request takes the changes built for it along.
  if (numbers.length) {
    const { rows } = await db.query(
      `SELECT id FROM chat_sessions
        WHERE thread_id = $1 AND (linked_issues[1] = ANY($2::int[]) OR created_from_issue_number = ANY($2::int[]))`,
      [from, numbers]
    );
    for (const r of rows) if (!changes.includes(Number(r.id))) changes.push(Number(r.id));
  }
  let target: number | null = null;
  if (numbers.length) {
    const { rows: [own] } = await db.query('SELECT id FROM threads WHERE app_id = $1 AND number = $2', [appId, numbers[0]]);
    if (own && Number(own.id) !== from) target = Number(own.id);
  }
  if (!target) {
    let lead: number | null = numbers[0] || null;
    if (!lead && changes.length) {
      const { rows: [c] } = await db.query('SELECT pr_number FROM chat_sessions WHERE id = $1', [changes[0]]);
      lead = c && Number(c.pr_number) > 0 ? Number(c.pr_number) : null;
    }
    const { rows: [made] } = await db.query(
      `INSERT INTO threads (app_id, number, kind) VALUES ($1, $2, 'work')
       ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING RETURNING id`,
      [appId, lead]
    );
    if (made) target = Number(made.id);
    else {
      const { rows: [had] } = await db.query('SELECT id FROM threads WHERE app_id = $1 AND number = $2', [appId, lead]);
      target = Number(had.id);
    }
    if (target === from) throw new Error('thread-moves: a split cannot take a thread\'s lead');
  }
  await db.query(`UPDATE threads SET merged_into = NULL, state = 'open', closed_at = NULL WHERE id = $1`, [target]);
  if (numbers.length) {
    await db.query('UPDATE requests SET thread_id = $2 WHERE thread_id = $1 AND number = ANY($3::int[])', [from, target, numbers]);
    await db.query(
      `UPDATE issues SET thread_id = $2
        WHERE thread_id = $1 AND kind = 'general' AND github_issue_number = ANY($3::int[])`,
      [from, target, numbers]
    );
    await db.query(
      `UPDATE chat_messages SET thread_id = $2
        WHERE thread_id = $1 AND thread_type = 'issue' AND thread_ref = ANY($3::int[])`,
      [from, target, numbers]
    );
  }
  if (changes.length) {
    await db.query('UPDATE chat_sessions SET thread_id = $2 WHERE thread_id = $1 AND id = ANY($3::int[])', [from, target, changes]);
  }
  if (decisions.length) {
    await db.query('UPDATE issues SET thread_id = $2 WHERE thread_id = $1 AND id = ANY($3::int[])', [from, target, decisions]);
    await db.query(
      `UPDATE chat_messages SET thread_id = $2
        WHERE thread_id = $1 AND thread_type = 'governance' AND thread_ref = ANY($3::int[])`,
      [from, target, decisions]
    );
  }
  return target;
}

/**
 * Apply move `moveId` once: locked, and only while it is pending or being
 * voted on. Resolves the thread it left the work in, or null when it was
 * decided already.
 */
export async function applyMove(db: Db, moveId: number | string): Promise<number | null> {
  const { rows: [move] } = await db.query(
    `SELECT id, app_id, thread_id, kind, input, state FROM thread_moves WHERE id = $1 FOR UPDATE`,
    [Number(moveId)]
  );
  if (!move || (move.state !== 'pending' && move.state !== 'voting')) return null;
  const result = move.kind === 'merge' ? await applyMerge(db, move) : await applySplit(db, move);
  await db.query(
    `UPDATE thread_moves SET state = 'applied', decided_at = NOW(), result_thread_id = $2 WHERE id = $1`,
    [move.id, result]
  );
  return result;
}
