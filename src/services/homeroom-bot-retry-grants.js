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
  // #6776: "already" is said only when a round is really queued or running,
  // and then it names the truth: the place in line, or that it is running.
  already: 'A try is already queued for this change. Nothing more was queued.',
  already_place: 'A try is already queued for this change, {place} in line. Nothing more was queued.',
  already_running: 'A try is already queued for this change, and running now. Nothing more was queued.',
  requeued: 'Your earlier try never started, so I queued it again.',
  merged: 'This change has already merged, so there is nothing left to try. Nothing was queued.',
  closed: 'This change was closed, so there is nothing left to try. Nothing was queued.',
  bot_off: 'Homeroom bot is off for this project right now, so it cannot try again. Nothing was queued.',
  nothing_to_fix: 'There is no failing check left for me to try on this change right now. Nothing was queued.',
  infra: 'Its checks failed in a way that looks like Homeroom\'s own trouble, not the change\'s, so I am not trying again. Nothing was queued.',
});

const GRANT_DONE = 'Done: I try once more at getting its checks to pass. If it still does not pass, I stop again and say so.';

/** 1st, 2nd, 3rd, 11th; null when `n` is not a place in line. */
function ordinal(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) return null;
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  return `${v}${{ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th'}`;
}

/** Why a grant was refused, in words a person reads. */
function grantRefusalText(why, out = {}) {
  if (why === 'already') {
    if (out.running) return GRANT_WORDS.already_running;
    const place = ordinal(out.place);
    return place ? GRANT_WORDS.already_place.replace('{place}', place) : GRANT_WORDS.already;
  }
  return GRANT_WORDS[why] || 'I could not let myself try again this time. Nothing was queued.';
}

/** What the bot says when a try was granted: the ordinary line, or the re-queue. */
function grantDoneText(out = {}) {
  return out.requeued ? GRANT_WORDS.requeued : GRANT_DONE;
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

// #6776: how long a grant may sit with nothing behind it before the bot's
// own sweep queues its round again. The press re-queues at once; this is
// for a grant whose queueing failed, or whose round was dropped afterwards.
const STRANDED_GRANT_MS = 5 * 60 * 1000;

/**
 * #6776: whether the round a grant bought is really queued or running for
 * `sessionId`. Resolves one of:
 *   { state: 'running' }            a turn runs on the change, or its
 *                                   request's queue row has started
 *   { state: 'queued', place }      its request's queue row waits, `place`
 *                                   its position in the queue (null when the
 *                                   place is not known); or the fix is asked
 *                                   for and not picked up yet (wf_work's
 *                                   bot.queueFix, a pending FixAsked)
 *   { state: 'none' }               nothing is queued or running
 *   { state: 'unknown' }            a read failed: callers answer "already",
 *                                   so a database error never doubles a grant
 */
async function roundState(pool, sessionId, { settings = null } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return { state: 'unknown' };
  try {
    const { rows } = await pool.query(
      'SELECT app_id, linked_issues, status, active_turn FROM chat_sessions WHERE id = $1', [id],
    );
    const cs = rows[0];
    if (!cs) return { state: 'none' };
    if (cs.active_turn) return { state: 'running' };
    const issues = (Array.isArray(cs.linked_issues) ? cs.linked_issues : []).map(Number).filter(Number.isInteger);
    if (issues.length) {
      const { rows: q } = await pool.query(
        `SELECT id, started_at FROM homeroom_bot_queue
          WHERE app_id = $1 AND issue_number = ANY($2::int[])
          ORDER BY started_at DESC NULLS LAST, enqueued_at ASC
          LIMIT 1`,
        [cs.app_id, issues],
      );
      const row = q[0];
      if (row && row.started_at) return { state: 'running' };
      if (row) {
        // The same order the bot page draws (homeroom-bot-progress.js
        // queuePositions). No settings here means every project: a person's
        // press knows nothing about the lane's scope.
        let place = null;
        try {
          const position = await require('./homeroom-bot-progress').queuePositions(
            pool, [{ queue_id: Number(row.id), started_at: null }], settings || { pausedApps: [] },
          );
          place = position.get(Number(row.id)) || null;
        } catch { place = null; }
        return { state: 'queued', place };
      }
    }
    const { rows: work } = await pool.query(
      `SELECT 1 FROM wf_work
        WHERE kind = 'bot.queueFix' AND status IN ('queued', 'running')
          AND input->>'sessionId' = $1
        LIMIT 1`,
      [String(id)],
    );
    if (work.length) return { state: 'queued', place: null };
    const { rows: asked } = await pool.query(
      `SELECT 1 FROM wf_events
        WHERE type = 'FixAsked' AND status = 'pending'
          AND payload->>'sessionId' = $1
        LIMIT 1`,
      [String(id)],
    );
    if (asked.length) return { state: 'queued', place: null };
    return { state: 'none' };
  } catch (err) {
    log.warn('homeroom-bot', 'Could not tell whether a try is queued or running', { sessionId: id, err: err.message });
    return { state: 'unknown' };
  }
}

/** Why queueChecksFix would not queue the round, in grant words. */
function queueRefusal(why) {
  if (why === 'off' || why === 'not_live') return 'bot_off';
  if (why === 'not_due' || why === 'no_request') return 'nothing_to_fix';
  return 'infra';
}

/**
 * #6776: close an open grant with no run behind it. The table has no reason
 * column, so the reason goes to the log.
 */
async function closeGrant(pool, grantId, reason) {
  try {
    await pool.query(
      'UPDATE homeroom_bot_revision_grants SET used_at = now() WHERE id = $1 AND used_at IS NULL',
      [Number(grantId)],
    );
    log.info('homeroom-bot', 'Closed a try that could not be queued', { grantId: Number(grantId), reason });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not close a try that could not be queued', { grantId: Number(grantId), reason, err: err.message });
  }
}

/**
 * #6776: queue the round an open grant bought again. `again` makes the ask a
 * fresh one (queueChecksFix keys the FixAsked by it), so the earlier receipt
 * does not swallow it. Resolves { queued: true }, { queued: false, why } with
 * the grant now closed, or { queued: false, open: true } when queueing threw
 * (the grant stays open for the sweep).
 */
async function requeueGrant(pool, { grantId, sessionId, again = null, deps = {} }) {
  const id = Number(sessionId);
  const { rows: [cs] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id]);
  if (cs?.status === 'merged') {
    await closeGrant(pool, grantId, 'merged');
    return { queued: false, why: 'merged' };
  }
  if (cs?.status !== 'promoted') {
    await closeGrant(pool, grantId, 'closed');
    return { queued: false, why: 'closed' };
  }
  let out;
  try {
    const botModule = deps.homeroomBot || require('./homeroom-bot');
    out = await botModule.queueChecksFix(pool, { sessionId: id, head: null, again });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not queue a try that never started', { sessionId: id, grantId: Number(grantId), err: err.message });
    return { queued: false, open: true };
  }
  if (out?.queued) return { queued: true };
  const why = queueRefusal(out?.why);
  await closeGrant(pool, grantId, why);
  return { queued: false, why };
}

/**
 * Let the bot try once more on `sessionId`, as `user`. Resolves
 * { ok: true, grantId, requeued? } or { ok: false, why } with why one of
 * 'not_allowed', 'not_stopped', 'already', 'merged', 'closed', 'bot_off',
 * 'nothing_to_fix', 'infra'. Never throws.
 */
async function grant(pool, { sessionId, user, deps = {} }) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, why: 'not_stopped' };
  if (!(await mayGrant(pool, { sessionId: id, user }))) return { ok: false, why: 'not_allowed' };
  try {
    // One open grant at a time. #6776: "already" is said only when the round
    // it bought is really queued or running; a grant with nothing behind it
    // has its round queued again.
    const { rows: open } = await pool.query(
      'SELECT id FROM homeroom_bot_revision_grants WHERE session_id = $1 AND used_at IS NULL LIMIT 1', [id],
    );
    if (open.length) {
      const grantId = Number(open[0].id);
      const round = await roundState(pool, id, { settings: deps.settings || null });
      if (round.state !== 'none') {
        return { ok: false, why: 'already', running: round.state === 'running', place: round.place ?? null };
      }
      const again = `press:${Date.now()}`;
      const requeued = await requeueGrant(pool, { grantId, sessionId: id, again, deps });
      if (requeued.queued) {
        log.info('homeroom-bot', 'Queued a try that never started again', { sessionId: id, grantId });
        return { ok: true, grantId, requeued: true };
      }
      if (requeued.open) return { ok: false, why: 'already' };
      log.info('homeroom-bot', 'A try that never started could not be queued', { sessionId: id, grantId, why: requeued.why });
      return { ok: false, why: requeued.why };
    }
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
    // swallow it). #6776: a refusal closes the grant it could not queue; a
    // throw leaves it open for the sweep.
    try {
      const botModule = deps.homeroomBot || require('./homeroom-bot');
      const queued = await botModule.queueChecksFix(pool, { sessionId: id, head: fix.head || null });
      if (!queued?.queued) {
        const why = queueRefusal(queued?.why);
        await closeGrant(pool, row?.id, why);
        log.info('homeroom-bot', 'Granted a try that could not be queued', { sessionId: id, grantId: row?.id || null, why });
        return { ok: false, why };
      }
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

/**
 * #6776: the bot's own sweep of grants left open with nothing behind them.
 * A grant older than STRANDED_GRANT_MS whose round is not queued or running
 * has it queued again (at most once per window, `again` naming the window),
 * or is closed with the reason it could not be. A change whose checks are
 * still settling is left alone: its round is asked for when they fail.
 * Sends no message; closing is quiet and logged. Resolves { requeued, closed }
 * when either happened, else null.
 */
async function sweepStrandedGrants(pool, settings = null, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const { rows } = await pool.query(
    `SELECT g.id, g.session_id, g.created_at, cs.status, cs.check_state
       FROM homeroom_bot_revision_grants g
       JOIN chat_sessions cs ON cs.id = g.session_id
      WHERE g.used_at IS NULL AND g.created_at < now() - interval '5 minutes'
      ORDER BY g.created_at, g.id
      LIMIT 200`,
  );
  let requeued = 0;
  let closed = 0;
  const again = `sweep:${Math.floor(now / STRANDED_GRANT_MS)}`;
  for (const g of rows) {
    // The query filters by age; a row a mock hands back is filtered here too.
    if (g.created_at && now - new Date(g.created_at).getTime() < STRANDED_GRANT_MS) continue;
    // Its checks are still running: bot-change asks for the fix when they fail.
    if (g.status === 'promoted' && g.check_state !== 'failing') continue;
    const round = await roundState(pool, g.session_id, { settings });
    if (round.state !== 'none') continue;
    const out = await requeueGrant(pool, { grantId: g.id, sessionId: g.session_id, again, deps });
    if (out.queued) requeued += 1;
    else if (!out.open) closed += 1;
  }
  if (!requeued && !closed) return null;
  return { requeued, closed };
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

module.exports = {
  mayGrant, grant, useGrant, grantRefusalText, grantDoneText, GRANT_WORDS,
  // #6776: what is behind an open grant.
  roundState, requeueGrant, closeGrant, sweepStrandedGrants, STRANDED_GRANT_MS, ordinal,
};
