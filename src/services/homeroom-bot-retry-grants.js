'use strict';

// #6284: a person lets the Homeroom bot try once more at a change it stopped
// fixing on its own. The bot makes at most MAX_REVISIONS fixes by itself;
// when it stops, its message, the change's Testing card and the Homeroom bot
// page offer Let it try again. One grant buys exactly one round: the round is
// recorded as asked, and the grant is marked used.
//
// Who may grant: the person who asked for the request, or an admin. That is
// the answer the plan carried when it was built, so a voter who is neither
// sees the line and no button.

const log = require('./logger');

const GRANT_WORDS = Object.freeze({
  not_allowed: 'Only the person who asked for it or an admin can let me try again. Nothing was queued.',
  not_stopped: 'I am not stopped on this change right now, so there is nothing to let me try again. Nothing was queued.',
  already: 'A try is already waiting for this change. Nothing more was queued.',
});

/** Why a grant was refused, in words a person reads. */
function grantRefusalText(why) {
  return GRANT_WORDS[why] || 'I could not let myself try again this time. Nothing was queued.';
}

/**
 * Whether `user` may let the bot try again on `sessionId`: the request's
 * requester, or an admin. Never throws (a read that fails answers no).
 */
async function mayGrant(pool, { sessionId, user }) {
  if (!user?.id) return false;
  if (user.isAdmin || user.is_admin) return true;
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    const { rows: [cs] } = await pool.query(
      'SELECT id, app_id, linked_issues FROM chat_sessions WHERE id = $1', [id],
    );
    if (!cs) return false;
    const issueNumber = Array.isArray(cs.linked_issues) ? Number(cs.linked_issues[0]) : null;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return false;
    const requester = await require('./homeroom-bot-dm')
      .requesterOf(pool, cs.app_id, issueNumber).catch(() => null);
    return !!(requester && Number(requester.userId) === Number(user.id));
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read whether a person may let the bot try again', { sessionId: id, err: err.message });
    return false;
  }
}

/**
 * Let the bot try once more on `sessionId`, as `user`. Resolves
 * { ok: true, grantId } or { ok: false, why } with why one of
 * 'not_allowed', 'not_stopped', 'already'. Never throws.
 */
async function grant(pool, { sessionId, user, deps = {} }) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, why: 'not_stopped' };
  if (!(await mayGrant(pool, { sessionId: id, user }))) return { ok: false, why: 'not_allowed' };
  try {
    // One open grant at a time: pressing again while a round waits or runs
    // does nothing new.
    const { rows: open } = await pool.query(
      'SELECT id FROM homeroom_bot_revision_grants WHERE session_id = $1 AND used_at IS NULL LIMIT 1', [id],
    );
    if (open.length) return { ok: false, why: 'already' };
    const progress = require('./homeroom-bot-progress');
    const fix = await progress.changeBotFix(pool, id, { viewer: user });
    if (!fix || fix.state !== 'stopped') return { ok: false, why: 'not_stopped' };
    const { rows: [cs] } = await pool.query('SELECT app_id FROM chat_sessions WHERE id = $1', [id]);
    if (!cs) return { ok: false, why: 'not_stopped' };
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_revision_grants (app_id, session_id, granted_by, head_sha)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [cs.app_id, id, user?.id || null, fix.head || null],
    );
    // The fix is due again on this head now a grant is open (homeroom-bot.js
    // queueChecksFix keys it by the grant, so an earlier refusal does not
    // swallow it).
    try {
      const botModule = deps.homeroomBot || require('./homeroom-bot');
      await botModule.queueChecksFix(pool, { sessionId: id, head: fix.head || null });
    } catch (err) {
      log.warn('homeroom-bot', 'Granted a try, but could not queue the fix', { sessionId: id, err: err.message });
    }
    log.info('homeroom-bot', 'Somebody let it try again at a change it stopped fixing', {
      sessionId: id, userId: user?.id || null, grantId: row?.id || null,
    });
    return { ok: true, grantId: row?.id || null };
  } catch (err) {
    log.warn('homeroom-bot', 'Could not let the bot try again', { sessionId: id, err: err.message });
    return { ok: false, why: 'not_stopped' };
  }
}

/** Mark the open grant on `sessionId` used by `runId`, once. */
async function useGrant(pool, sessionId, runId = null) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_revision_grants
          SET used_at = now(), run_id = $2
        WHERE session_id = $1 AND used_at IS NULL
        RETURNING id, granted_by`,
      [id, runId || null],
    );
    return rows[0] || null;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not mark a try as used', { sessionId: id, err: err.message });
    return null;
  }
}

module.exports = { mayGrant, grant, useGrant, grantRefusalText, GRANT_WORDS };
