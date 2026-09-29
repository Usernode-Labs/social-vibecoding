'use strict';

/**
 * "Needs a conversation" gets a script (#1688).
 *
 * When No votes reach a third of the active users, the merge gate's clocks
 * stop (services/active-users.js isContested) and the proposal can only
 * merge by a straight majority. Until #1688 the only thing that happened
 * at that moment was a label change on the card. This posts a structured
 * prompt into the proposal's own thread — the proposer asked what problem
 * they were solving, each No voter asked what would unblock it, and the
 * lines the No voters left quoted under it — and pings everyone it names,
 * so a late reader sees a conversation and not just a score.
 *
 * ── Once per version, not once per crossing ────────────────────────────
 *
 * "Contested" is a fraction of the ACTIVE count, and the active count is a
 * rolling ten-day window that moves without anybody voting: a proposal can
 * cross the line and back purely because somebody's membership aged out. A
 * prompt on every crossing would fill the thread with repeats. So the
 * prompt is evaluated only when a No is cast (the one act that can push a
 * proposal over), and claimed on the session as
 * conversation_prompted_epoch = approval_epoch. A new authored push bumps
 * the epoch (services/vote-revision.js), and a fresh round of votes on the
 * new version can earn a fresh prompt — which is right, because it is a
 * different conversation.
 */

const log = require('./logger');

/** "@carol", "@carol and @dave", "@carol, @dave and @erin". */
function mentionList(names) {
  const list = names.map((n) => `@${n}`);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The line the thread gets. Exported so the wording is one place, and so a
 * test can pin it without a database.
 */
function promptText({ label, author, objectors }) {
  const asks = [];
  if (author) asks.push(`@${author}, what problem were you solving?`);
  const names = objectors.map((o) => o.username).filter(Boolean);
  if (names.length) asks.push(`${mentionList(names)}, what would unblock this for you?`);
  const said = objectors
    .filter((o) => o.username && o.reason)
    .map((o) => `${o.username}: “${o.reason}”`);
  return `${label} needs a conversation: a third of the group has said no, so it merges only on a straight majority now.`
    + (asks.length ? ` ${asks.join(' ')}` : '')
    + (said.length ? ` ${said.join(' · ')}` : '');
}

/**
 * After a No on `session`: if that No made the proposal contested and this
 * version has not had its prompt, post it. Returns what happened, so the
 * caller can log it and a test can assert on it.
 */
async function promptIfContested(pool, session) {
  const activeUsers = require('./active-users');
  const { active } = await activeUsers.getActiveUserStats(pool, session.app_id);
  const { rows: votes } = await pool.query(
    `SELECT pv.user_id, pv.vote, pv.reason, u.username
       FROM pr_votes pv
       JOIN users u ON u.id = pv.user_id
       JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1
        AND pv.approval_epoch = cs.approval_epoch
      ORDER BY pv.created_at ASC, pv.id ASC`,
    [session.id]
  );
  const objectors = votes.filter((v) => v.vote === 'no');
  if (!activeUsers.isContested(active, objectors.length)) {
    return { prompted: false, why: 'not_contested' };
  }
  const { rows: claimed } = await pool.query(
    `UPDATE chat_sessions
        SET conversation_prompted_epoch = approval_epoch
      WHERE id = $1
        AND conversation_prompted_epoch IS DISTINCT FROM approval_epoch
      RETURNING approval_epoch`,
    [session.id]
  );
  if (!claimed.length) return { prompted: false, why: 'already_prompted' };
  const epoch = parseInt(claimed[0].approval_epoch, 10);

  const { rows: authorRows } = session.user_id
    ? await pool.query('SELECT username FROM users WHERE id = $1', [session.user_id])
    : { rows: [] };
  const author = authorRows[0]?.username || null;
  const label = session.pr_title
    ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
    : `PR #${session.pr_number || session.id}`;
  const named = objectors.map((o) => ({ username: o.username, reason: o.reason || null }));
  const content = promptText({ label, author, objectors: named });

  const { sendSystemMessage } = require('./ws');
  const posted = await sendSystemMessage(
    pool, session.app_id, content, 'system',
    { conversation: { sessionId: session.id, epoch, author, objectors: named } },
    { type: 'session', ref: session.id }
  );

  // Everyone the prompt names is asked, through the ordinary mention row —
  // the prompt is addressed to them, and a mention is what "addressed to
  // you" already means here.
  try {
    const notifications = require('./notifications');
    const rows = await notifications.createMentionNotifications(pool, {
      appId: session.app_id,
      chatMessageId: posted?.id || null,
      senderId: null,
      content,
    });
    await Promise.all(rows.map((row) => notifications.hydrateAndPush(pool, row)));
  } catch (err) {
    log.warn('conversation-prompt', 'Mentions failed (prompt posted)', {
      sessionId: session.id, err: err.message,
    });
  }
  return { prompted: true, epoch, author, objectors: named };
}

module.exports = { promptIfContested, promptText, mentionList };
