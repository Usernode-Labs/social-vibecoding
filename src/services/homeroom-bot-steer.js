'use strict';

// Homeroom bot parity, P5: steering one of the bot's builds while it runs.
//
// A NOTE INTO A RUNNING BUILD. Before, something said to the bot about a
// request it was building waited for the change's first follow-up, after
// the vote had started. Now the person who asked for the request, or the
// project's owner (or an admin), can send it to the build itself
// (homeroom-bot-thread-tools/steer.js add_to_build): a row here, waiting on
// the build's run and session. The build's Claude Code Stop hook
// (worker/build-stop-hook.js) asks for the notes waiting on its session
// each time the agent tries to end its turn (POST /api/internal/sessions/
// :id/build-notes/take, with the turn's worker token: takeNotes), and when
// there are some it sends the agent back once with them as the reason. Each
// note is delivered once, and its card under the bot's reply says so
// (homeroom-bot-cards setCardState). A note whose build ended before it
// asked is `missed` (settleNotes, run soon after the bot posts on the
// request and on its five-minute sweep), and its card offers to put it in
// the change's next update instead, the follow-up a revise_proposal Post it
// starts: one tap, since that is said in the change's public discussion.
//
// STOP AND REDO. The same people can have the build stopped and the request
// done again with their note (stop_and_redo). It is offered under the reply
// first, with Stop and redo and Keep going, and nothing stops until it is
// tapped (redo): the build is stopped as the session's Stop stops it (the
// bot-build machine, as that person), its note goes on the request's
// discussion under their name (homeroom-bot-dm.js postOnRequest, which puts
// the request first in the queue), and the lost build says nothing on the
// request (homeroom-bot.js recordLostLiveBuild: redoAsked). Keep going sends
// the note into the build instead.

const log = require('./logger');

const NOTE_CHARS = 2000;

function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function mayorModule(deps) { return deps.mayor || require('./homeroom-bot-mayor'); }
function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function cardsModule(deps) { return deps.cards || require('./homeroom-bot-cards'); }
function batchesModule(deps) { return deps.batches || require('./homeroom-bot-batches'); }
function wsModule(deps) { return deps.ws || require('./ws'); }
function workflowModule(deps) { return deps.replies || require('../workflow/platform.ts'); }

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pure: a note as it may be sent: trimmed, bounded, and at least two words. Null when it is not one. */
function noteText(value) {
  const text = clip(value, NOTE_CHARS);
  return text.split(/\s+/).filter(Boolean).length >= 2 ? text : null;
}

// The build of request n under way now: the newest live run, found ready,
// whose build waits its turn or runs in a session still open, not proposed,
// held, superseded or waiting for Build it.
const BUILD_SQL = `
  SELECT r.id AS run_id, r.build_session_id AS session_id, bs.status AS session_status
    FROM homeroom_bot_runs r
    LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
   WHERE r.app_id = $1 AND r.issue_number = $2 AND r.mode = 'live' AND r.verdict = 'ready'
     AND r.build_ok IS NULL AND r.proposal_session_id IS NULL AND r.cap_suppressed IS NULL
     AND r.awaiting_go_at IS NULL AND r.build_error IS NULL
     AND (r.live_build_waiting_at IS NOT NULL OR r.build_session_id IS NOT NULL)
     AND (bs.id IS NULL OR bs.status = 'active')
     AND r.created_at > NOW() - INTERVAL '7 days'
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_runs n
                      WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.mode = 'live' AND n.id > r.id)
   ORDER BY r.id DESC
   LIMIT 1`;

/** Request n's build under way: { runId, sessionId, running } (running: its session is open), or null. */
async function buildUnderWay(pool, appId, issueNumber) {
  const { rows } = await pool.query(BUILD_SQL, [Number(appId), Number(issueNumber)]);
  const r = rows[0];
  if (!r) return null;
  const sessionId = Number(r.session_id) || null;
  return { runId: Number(r.run_id), sessionId, running: !!sessionId && r.session_status === 'active' };
}

// #6684: a build that stopped coding and is in its last steps (reviewing its
// work, or putting its change up): its session ended within the last two
// hours, and the run has not said how it went yet. A note on it is queued
// straight for the change's next update instead of into a build that is no
// longer coding.
const LAST_STEPS_SQL = `
  SELECT r.id AS run_id, r.build_session_id AS session_id
    FROM homeroom_bot_runs r
    JOIN chat_sessions bs ON bs.id = r.build_session_id
   WHERE r.app_id = $1 AND r.issue_number = $2 AND r.mode = 'live' AND r.verdict = 'ready'
     AND r.build_ok IS NULL AND r.build_error IS NULL AND r.proposal_session_id IS NULL
     AND r.cap_suppressed IS NULL AND r.awaiting_go_at IS NULL
     AND bs.status <> 'active' AND bs.last_activity_at > NOW() - INTERVAL '2 hours'
     AND r.created_at > NOW() - INTERVAL '7 days'
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_runs n
                      WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.mode = 'live' AND n.id > r.id)
   ORDER BY r.id DESC
   LIMIT 1`;

/**
 * #6684: a build of request n a comment may be sent to: the one under way,
 * or one in its last steps whose session has ended (`lastSteps`, a note on
 * it goes straight to the change's next update). Null when neither.
 */
async function buildForRequest(pool, appId, issueNumber) {
  const under = await buildUnderWay(pool, appId, issueNumber);
  if (under) return { ...under, lastSteps: false };
  const { rows } = await pool.query(LAST_STEPS_SQL, [Number(appId), Number(issueNumber)]);
  const r = rows[0];
  if (!r) return null;
  return {
    runId: Number(r.run_id), sessionId: Number(r.session_id) || null, running: false, lastSteps: true,
  };
}

/**
 * Whether `user` may steer the bot's build of request n on `app`: they asked
 * for it, or they manage the project (its owner, an admin of it, a platform
 * admin who may write). { ok, theirs, manages }. Never throws.
 */
async function maySteer(pool, { app, user, issueNumber, deps = {} }) {
  try {
    if (!app || !user?.id) return { ok: false, theirs: false, manages: false };
    const requester = await dmModule(deps).requesterOf(pool, app.id, Number(issueNumber)).catch(() => null);
    const theirs = !!requester && Number(requester.userId) === Number(user.id);
    const manages = theirs ? false : await batchesModule(deps).managesApp(pool, app, user);
    return { ok: theirs || manages, theirs, manages };
  } catch {
    return { ok: false, theirs: false, manages: false };
  }
}

/** A note row, waiting on `build` (or offered, for a redo). Resolves its id. */
async function addNote(pool, {
  app, issueNumber, build, user, note, kind = 'note', state = 'waiting', conversationId = null,
  // #6684: 'request' when the note is a comment on the request itself, with
  // the comment's id. Nothing is posted a second time: the comment is there.
  origin = null, commentId = null,
}) {
  // One note per comment: a turn retried after a restart finds the note it
  // made before, not a second copy.
  if (commentId) {
    const { rows: had } = await pool.query(
      'SELECT id FROM homeroom_bot_build_notes WHERE app_id = $1 AND issue_number = $2 AND comment_id = $3 LIMIT 1',
      [Number(app.id), Number(issueNumber), Number(commentId)],
    );
    if (had[0]) return Number(had[0].id);
  }
  const { rows: [row] } = await pool.query(
    `INSERT INTO homeroom_bot_build_notes
       (app_id, issue_number, run_id, session_id, user_id, conversation_id, note, kind, state, origin, comment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [Number(app.id), Number(issueNumber), build?.runId || null, build?.sessionId || null, Number(user.id),
      Number(conversationId) || null, note, kind, state, origin, Number(commentId) || null],
  );
  return Number(row.id);
}

// A COMMENT ON THE REQUEST'S OWN DISCUSSION (#6684). The request's
// discussion reaches a running build the same way the private chat does: the
// requester's (or the project's owner's) correction is the note add_to_build
// sends, Stop and redo is offered under the reply, and a second piece of work
// is offered as its own request. It lives here, not in
// homeroom-bot-thread-tools/steer.js, because the request's discussion is a
// public surface and loads no thread-tool module but pictures
// (tests/homeroom-bot-prod-debug.test.js): the note, its card and the gate
// are the service's own, and the tools are a thin wrapper over them.

function cardOf({ id, state, app, n, note, title = null }) {
  return {
    type: 'build_note', v: 1, state, noteId: id,
    project: app.slug, projectName: app.name || app.slug, number: n, ...(title ? { title } : {}), note,
  };
}

async function titleOf(pool, appId, n) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE((SELECT NULLIF(BTRIM(title), '') FROM issues WHERE app_id = $1 AND github_issue_number = $2 ORDER BY id DESC LIMIT 1),
                       (SELECT NULLIF(BTRIM(issue_title), '') FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2)) AS title`,
      [Number(appId), Number(n)],
    );
    return rows[0]?.title ? String(rows[0].title).slice(0, 160) : null;
  } catch {
    return null;
  }
}

/** The note a comment on the request itself sends into its build. { ok, card, sent, shown } or { ok: false, error }. */
async function noteFromRequest(pool, { app, n, user, note, commentId = null, conversationId = null, deps = {} }) {
  const number = Number(n);
  const name = app?.name || app?.slug || 'the project';
  const text = noteText(note);
  if (!text) return { ok: false, error: 'Say what they want added or changed. If they have not said, ask them. Nothing was sent.' };
  if (!app || !Number.isInteger(number) || number <= 0) return { ok: false, error: 'No such request. Nothing was sent.' };
  const gate = await maySteer(pool, { app, user, issueNumber: number, deps });
  if (!gate.ok) {
    return { ok: false, error: `Only whoever asked for ${name} request #${number}, or the project's owner, can change its build while it runs. Nothing was sent.` };
  }
  const build = await buildForRequest(pool, app.id, number);
  if (!build) {
    return { ok: false, error: `You are not building ${name} request #${number} right now, so there is no build to send it to. Nothing was sent.` };
  }
  const id = await addNote(pool, {
    app, issueNumber: number, build, user, note: text, conversationId, origin: 'request', commentId,
  });
  return {
    ok: true,
    card: cardOf({ id, state: 'waiting', app, n: number, note: text, title: await titleOf(pool, app.id, number) }),
    sent: build.lastSteps
      ? `The build of ${name} request #${number} has already stopped coding, so their note goes into the change's next update by itself. Nothing more is needed from them.`
      : `Their note waits for the build of ${name} request #${number}: it is handed it at its next step, before it finishes, and works it in then.`,
    shown: 'A card under your reply shows the note and says when the build has it. It has not read it yet, so never say it has, or that the change is made.',
  };
}

/** Stop and redo, offered under a reply on the request: nothing stops until it is tapped (redo). */
async function redoFromRequest(pool, { app, n, user, note, commentId = null, conversationId = null, deps = {} }) {
  const number = Number(n);
  const name = app?.name || app?.slug || 'the project';
  const text = noteText(note);
  if (!text) return { ok: false, error: 'Say what they want done instead. If they have not said, ask them. Nothing was stopped.' };
  if (!app || !Number.isInteger(number) || number <= 0) return { ok: false, error: 'No such request. Nothing was stopped.' };
  const gate = await maySteer(pool, { app, user, issueNumber: number, deps });
  if (!gate.ok) {
    return { ok: false, error: `Only whoever asked for ${name} request #${number}, or the project's owner, can change its build while it runs. Nothing was stopped.` };
  }
  const build = await buildForRequest(pool, app.id, number);
  if (!build) {
    return { ok: false, error: `You are not building ${name} request #${number} right now, so there is nothing to stop. Nothing was stopped.` };
  }
  if (!build.running) {
    return {
      ok: false,
      error: build.lastSteps
        ? 'Its build has already stopped coding, so there is nothing to stop: send the note with add_to_build and it goes into the change\'s next update. Nothing was stopped.'
        : 'Its build has not started yet, so there is nothing to stop: send the note with add_to_build and the build reads it as it works. Nothing was stopped.',
    };
  }
  const id = await addNote(pool, {
    app, issueNumber: number, build, user, note: text, conversationId,
    kind: 'redo', state: 'offered', origin: 'request', commentId,
  });
  return {
    ok: true,
    card: cardOf({ id, state: 'offer_redo', app, n: number, note: text, title: await titleOf(pool, app.id, number) }),
    offered: 'Stop and redo and Keep going are under your reply, for them to tap. Nothing is stopped until they tap Stop and redo: then the build stops, their note is the comment already on the request, and you read the request again first. Keep going sends the note into the running build instead. Never say it was stopped.',
  };
}

async function noteRow(pool, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { rows } = await pool.query('SELECT * FROM homeroom_bot_build_notes WHERE id = $1', [n]);
  return rows[0] || null;
}

// The reply whose card a note is: kept on the row once found. The card is
// sent with the reply after the tool that made the note returns, so a note
// delivered within that second finds none yet; settleNotes finds it later.
async function cardMessageOf(pool, row) {
  if (row.message_id) return Number(row.message_id);
  if (!row.conversation_id) return null;
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL
        AND metadata->'homeroomBot'->'card'->>'type' = 'build_note'
        AND metadata->'homeroomBot'->'card'->>'noteId' = $2
      ORDER BY id DESC LIMIT 1`,
    [Number(row.conversation_id), String(row.id)],
  );
  const id = Number(rows[0]?.id) || null;
  if (id) await pool.query('UPDATE homeroom_bot_build_notes SET message_id = $2 WHERE id = $1 AND message_id IS NULL', [row.id, id]);
  return id;
}

// #6684: a note's card on a request is a `chat_messages` row's
// `metadata.homeroomBot.buildNote` (homeroom-bot-voice.js say), not a
// conversation message. Its patch is merged in and broadcast, as an offer's
// message is (homeroom-bot-voice.js markOfferMessage).
async function patchChatCard(pool, messageId, patch, deps = {}) {
  const { rows } = await pool.query('SELECT id, app_id, metadata, thread_type, thread_ref FROM chat_messages WHERE id = $1', [Number(messageId)]);
  if (!rows[0]) return false;
  const m = rows[0];
  const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
  const bot = meta.homeroomBot && typeof meta.homeroomBot === 'object' ? meta.homeroomBot : {};
  const next = { ...meta, homeroomBot: { ...bot, buildNote: { ...(bot.buildNote || {}), ...patch } } };
  await pool.query('UPDATE chat_messages SET metadata = $2 WHERE id = $1', [Number(messageId), JSON.stringify(next)]);
  try {
    const ws = wsModule(deps);
    if (typeof ws.broadcast === 'function') {
      ws.broadcast(Number(m.app_id), {
        type: 'chat_message_updated', id: Number(m.id), metadata: next,
        thread: m.thread_type ? { type: m.thread_type, ref: Number(m.thread_ref) } : null,
      });
    }
  } catch { /* the next read draws it */ }
  return true;
}

// The reply on the request carrying a note's card, found by the note's id
// in its metadata when `chat_message_id` was not set (the reply is posted
// after the tool that made the note returns).
async function chatCardMessageOf(pool, row) {
  if (row.chat_message_id) return Number(row.chat_message_id);
  if (row.origin !== 'request') return null;
  const { rows } = await pool.query(
    `SELECT id FROM chat_messages
      WHERE app_id = $1 AND metadata->'homeroomBot'->'buildNote'->>'noteId' = $2
      ORDER BY id DESC LIMIT 1`,
    [Number(row.app_id), String(row.id)],
  );
  const id = Number(rows[0]?.id) || null;
  if (id) await pool.query('UPDATE homeroom_bot_build_notes SET chat_message_id = $2 WHERE id = $1 AND chat_message_id IS NULL', [row.id, id]);
  return id;
}

/** Patch a note's card, wherever it is. Never throws. */
async function patchCard(pool, row, patch, deps = {}) {
  try {
    const chatId = await chatCardMessageOf(pool, row);
    if (chatId) return await patchChatCard(pool, chatId, patch, deps);
    const messageId = await cardMessageOf(pool, row);
    if (!messageId) return false;
    return await cardsModule(deps).setCardState(pool, messageId, patch, { userId: Number(row.user_id) || null, ws: deps.ws || null });
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not update a build note\'s card', { noteId: row?.id, err: err.message });
    return false;
  }
}

// The notes waiting on a build's session, taken once each: notes on the
// session, on its run, and a note carried to the request's next build (one
// whose redo could not be posted on the request: run_id NULL).
const TAKE_SQL = `
  UPDATE homeroom_bot_build_notes n SET state = 'delivered', delivered_at = NOW(), session_id = COALESCE(n.session_id, $1)
   WHERE n.id IN (
     SELECT w.id FROM homeroom_bot_build_notes w
      WHERE w.state = 'waiting'
        AND (w.session_id = $1
          OR w.run_id IN (SELECT r.id FROM homeroom_bot_runs r WHERE r.build_session_id = $1)
          OR (w.run_id IS NULL AND w.session_id IS NULL AND EXISTS (
                SELECT 1 FROM homeroom_bot_runs r
                 WHERE r.build_session_id = $1 AND r.app_id = w.app_id AND r.issue_number = w.issue_number)))
      ORDER BY w.id
      LIMIT 10
      FOR UPDATE SKIP LOCKED)
  RETURNING n.*, (SELECT username FROM users u WHERE u.id = n.user_id) AS username`;

/**
 * The Stop hook's ask (routes/internal.js): the notes waiting on build
 * session `sessionId`, marked delivered as they are handed over, and their
 * cards told. Resolves [{ id, note, username }] oldest first.
 */
async function takeNotes(pool, sessionId, { deps = {} } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const { rows } = await pool.query(TAKE_SQL, [id]);
  const taken = rows.sort((a, b) => a.id - b.id);
  for (const row of taken) {
    await patchCard(pool, row, { state: 'delivered', deliveredAt: new Date().toISOString() }, deps);
  }
  if (taken.length) log.info('homeroom-bot-steer', 'Build notes delivered', { sessionId: id, notes: taken.length });
  return taken.map((r) => ({ id: Number(r.id), note: r.note, username: r.username || null }));
}

// Waiting notes whose build ended before it asked for them: the run built,
// failed, was replaced or let go, or its session is no longer open. A note
// carried to a request's next build (no run yet) waits a week for one.
const ENDED_SQL = `
  UPDATE homeroom_bot_build_notes n SET state = 'missed', settled_at = NOW()
    FROM homeroom_bot_build_notes w
    LEFT JOIN homeroom_bot_runs r ON r.id = w.run_id
    LEFT JOIN chat_sessions bs ON bs.id = COALESCE(w.session_id, r.build_session_id)
   WHERE n.id = w.id AND w.state = 'waiting'
     AND ($1::int IS NULL OR w.app_id = $1)
     AND (w.created_at < NOW() - INTERVAL '7 days'
          OR (w.run_id IS NOT NULL
              AND (r.id IS NULL OR r.build_ok IS NOT NULL OR r.proposal_session_id IS NOT NULL OR r.build_error IS NOT NULL
                   OR (bs.id IS NOT NULL AND bs.status <> 'active')
                   OR (r.build_session_id IS NULL AND r.live_build_waiting_at IS NULL))))
  RETURNING n.*, r.proposal_session_id AS change_id`;

// Settled notes whose card was not found when they settled (it had not been
// sent yet): told now, within a day.
const UNTOLD_SQL = `
  SELECT n.* FROM homeroom_bot_build_notes n
   WHERE n.message_id IS NULL AND n.conversation_id IS NOT NULL
     AND n.state IN ('delivered', 'missed', 'redone')
     AND COALESCE(n.settled_at, n.delivered_at, n.created_at) > NOW() - INTERVAL '1 day'
     AND ($1::int IS NULL OR n.app_id = $1)
   ORDER BY n.id
   LIMIT 50`;

// The bot's change for the request, up for a vote: where a missed note's
// next update would go.
const OPEN_CHANGE_SQL = `
  SELECT cs.id FROM chat_sessions cs JOIN users b ON b.id = cs.user_id AND b.username = 'homeroom_bot' AND b.is_synthetic
   WHERE cs.app_id = $1 AND $2 = ANY(cs.linked_issues) AND cs.status = 'promoted' AND cs.is_headless = FALSE
   ORDER BY cs.id DESC LIMIT 1`;

async function openChangeOf(pool, appId, issueNumber, hint = null) {
  if (hint) {
    const { rows } = await pool.query("SELECT id FROM chat_sessions WHERE id = $1 AND status = 'promoted'", [Number(hint)]);
    if (rows[0]) return Number(rows[0].id);
  }
  const { rows } = await pool.query(OPEN_CHANGE_SQL, [Number(appId), Number(issueNumber)]);
  return Number(rows[0]?.id) || null;
}

// #6684: notes from a request still waiting to go into a change's next
// update, without a tap (the words are already public on the request). A
// row left missed because its change was still being put up is tried again
// on the next sweep.
const MISSED_REQUEST_SQL = `
  SELECT n.* FROM homeroom_bot_build_notes n
   WHERE n.origin = 'request' AND n.state = 'missed'
     AND n.created_at > NOW() - INTERVAL '7 days'
     AND ($1::int IS NULL OR n.app_id = $1)
   ORDER BY n.id
   LIMIT 50`;

async function userRow(pool, id) {
  const { rows } = await pool.query('SELECT id, username FROM users WHERE id = $1', [Number(id)]);
  return rows[0] || null;
}

// The run a note was written on: how its build ended, if it has.
async function runRow(pool, runId) {
  if (!runId) return null;
  const { rows } = await pool.query(
    'SELECT id, build_ok, build_error, proposal_session_id FROM homeroom_bot_runs WHERE id = $1', [Number(runId)],
  );
  return rows[0] || null;
}

/** One line from the bot on the request, said once per mark. Never throws. */
async function sayOnRequest(pool, config, row, text, key, deps = {}) {
  try {
    const app = await appOf(pool, row.app_id, deps);
    const bot = await dmModule(deps).botAccount(pool);
    if (!app || !bot) return false;
    const say = deps.say || require('./homeroom-bot-voice').say;
    const out = await say(pool, {
      app, place: { type: 'issue', ref: Number(row.issue_number) }, bot, text,
      answer: [], suggest: false, mark: { key }, deps,
    });
    return !!out;
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not say where a note from a request went', { noteId: row?.id, err: err.message });
    return false;
  }
}

/**
 * #6684: a missed note that came from a request's discussion goes into the
 * change's next update by itself (no tap: the words are already public on
 * the request), or, when its build ended with no change, the request is read
 * again with it. Resolves true when it moved the note, false when the change
 * is still being put up (left missed for the next sweep) or it could not.
 * Never throws.
 */
async function forwardFromRequest(pool, config, row, deps = {}) {
  try {
    if (!row || row.origin !== 'request' || row.state !== 'missed') return false;
    const app = await appOf(pool, row.app_id, deps);
    const user = row.user_id ? await userRow(pool, row.user_id) : null;
    const bot = await dmModule(deps).botAccount(pool);
    if (!app || !user || !bot) return false;
    // They may have lost the right to steer since they commented.
    if (!(await maySteer(pool, { app, user, issueNumber: Number(row.issue_number), deps })).ok) {
      await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'missed'", [row.id]);
      await patchCard(pool, row, { state: 'gone' }, deps);
      return true;
    }
    const changeId = await openChangeOf(pool, row.app_id, row.issue_number).catch(() => null);
    if (changeId) {
      const settings = deps.settings || await botModule(deps).readSettings(pool);
      const ctx = {
        user, settings, config, deps: { ...(deps.reviseDeps || {}) }, bot: { id: Number(bot.id) },
        userText: row.note, cards: [], revised: false, appIds: new Set([Number(app.id)]), inPublic: true,
        conversationId: null,
      };
      const revise = deps.reviseProposal || mayorModule(deps).reviseProposal;
      const out = await revise(pool, ctx, { proposal: changeId, change: row.note });
      if (!out?.ok) {
        await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'missed'", [row.id]);
        await patchCard(pool, { ...row, state: 'missed' }, missedPatch(changeId), deps);
        await sayOnRequest(pool, config, row,
          `Your note stayed on the request: I could not put it in the change's next update. ${clip(out?.error || '', 200)}`.trim(),
          `build-note-refused:${row.id}`, deps);
        return true;
      }
      await pool.query("UPDATE homeroom_bot_build_notes SET state = 'forwarded', settled_at = NOW() WHERE id = $1 AND state = 'missed'", [row.id]);
      await patchCard(pool, row, { state: 'forwarded', auto: true }, deps);
      await sayOnRequest(pool, config, row,
        'The build finished before it read your note, so I put it in the change\'s next update. Nothing more is needed from you.',
        `build-note-forwarded:${row.id}`, deps);
      return true;
    }
    // No change up: did the build end without putting one up?
    const run = await runRow(pool, row.run_id).catch(() => null);
    if (!run || run.build_error != null || run.build_ok === false) {
      await workflowModule(deps).botOwedAndWait({
        appId: Number(row.app_id), issueNumber: Number(row.issue_number), reason: 'changed', priority: 2,
        changedBy: 'voice', key: `build-note-reread:${row.id}`, source: 'voice',
      });
      await pool.query("UPDATE homeroom_bot_build_notes SET state = 'forwarded', settled_at = NOW() WHERE id = $1 AND state = 'missed'", [row.id]);
      await patchCard(pool, row, { state: 'forwarded', reread: true }, deps);
      await sayOnRequest(pool, config, row,
        'The build ended before it read your note, so I read the request again with it: it goes into the next build.',
        `build-note-reread:${row.id}`, deps);
      return true;
    }
    // Its change is still being put up: the next sweep tries again.
    return false;
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not forward a note from a request', { noteId: row?.id, err: err.message });
    return false;
  }
}

/** Pure: what a missed note's card says: where it can go now. */
function missedPatch(changeId) {
  return { state: 'missed', change: changeId ? { sessionId: Number(changeId) } : null };
}

/**
 * Notes whose build ended first, marked missed and their cards told (with
 * the change their next update would go to), and cards not told before.
 * `appId` null: every project. Resolves how many moved. Never throws.
 */
async function settleNotes(pool, { appId = null, deps = {} } = {}) {
  try {
    if (!pool || typeof pool.query !== 'function') return 0;
    const app = appId == null ? null : Number(appId);
    const ended = await pool.query(ENDED_SQL, [app]);
    const rows = Array.isArray(ended?.rows) ? ended.rows : [];
    for (const row of rows) {
      // #6684: a note from a request forwards itself below, with no tap.
      if (row.origin === 'request') continue;
      const changeId = await openChangeOf(pool, row.app_id, row.issue_number, row.change_id).catch(() => null);
      await patchCard(pool, row, missedPatch(changeId), deps);
    }
    // #6684: request notes that just ended, and ones an earlier sweep left
    // missed because their change was still being put up.
    const missed = await pool.query(MISSED_REQUEST_SQL, [app]);
    const requestNotes = new Map();
    for (const row of [...rows, ...(Array.isArray(missed?.rows) ? missed.rows : [])]) {
      if (row.origin === 'request') requestNotes.set(Number(row.id), row);
    }
    for (const row of requestNotes.values()) {
      const moved = await forwardFromRequest(pool, null, row, deps);
      if (!moved) {
        const changeId = await openChangeOf(pool, row.app_id, row.issue_number).catch(() => null);
        await patchCard(pool, row, missedPatch(changeId), deps);
      }
    }
    const untold = await pool.query(UNTOLD_SQL, [app]);
    for (const row of Array.isArray(untold?.rows) ? untold.rows : []) {
      const patch = row.state === 'missed'
        ? missedPatch(await openChangeOf(pool, row.app_id, row.issue_number).catch(() => null))
        : { state: row.state, ...(row.delivered_at ? { deliveredAt: new Date(row.delivered_at).toISOString() } : {}) };
      await patchCard(pool, row, patch, deps);
    }
    if (rows.length) log.info('homeroom-bot-steer', 'Build notes missed: their builds ended first', { notes: rows.length, appId: app });
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not settle build notes', { appId, err: err.message });
    return 0;
  }
}

/** The five-minute sweep's part (homeroom-bot.js sweep). */
async function sweep(pool, deps = {}) {
  const n = await settleNotes(pool, { deps });
  return n || null;
}

/**
 * Whether `user` may stop the bot's build in session `sessionId` (routes/
 * sessions.js requestSessionStop, beside the session's owner and admins):
 * the build of a request they asked for, or of one on a project they
 * manage. Never throws.
 */
async function mayStopBotBuild(pool, sessionId, user, deps = {}) {
  try {
    if (!user?.id) return false;
    const { rows } = await pool.query(
      `SELECT r.app_id, r.issue_number
         FROM homeroom_bot_runs r
         JOIN chat_sessions cs ON cs.id = r.build_session_id
         JOIN users b ON b.id = cs.user_id AND b.username = 'homeroom_bot' AND b.is_synthetic
        WHERE r.build_session_id = $1 AND r.mode = 'live'
        ORDER BY r.id DESC LIMIT 1`,
      [Number(sessionId)],
    );
    if (!rows[0]) return false;
    const app = await appOf(pool, rows[0].app_id, deps);
    if (!app) return false;
    return (await maySteer(pool, { app, user, issueNumber: rows[0].issue_number, deps })).ok;
  } catch {
    return false;
  }
}

/** Whether run `runId`'s build was stopped to be redone (homeroom-bot.js recordLostLiveBuild). Never throws. */
async function redoAsked(pool, runId) {
  try {
    const { rows } = await pool.query(
      "SELECT 1 FROM homeroom_bot_build_notes WHERE run_id = $1 AND kind = 'redo' AND state = 'redone' LIMIT 1",
      [Number(runId)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function appOf(pool, appId, deps = {}) {
  const { rows } = await pool.query('SELECT slug FROM apps WHERE id = $1', [Number(appId)]);
  return rows[0] ? mayorModule(deps).findApp(pool, rows[0].slug) : null;
}

/** The workflow's Stop of a session's turn, as the session's Stop route asks it. */
async function stopBuildTurn({ sessionId, by }) {
  return require('../workflow/platform.ts').stopWorkflowTurn({ sessionId: Number(sessionId), by: by || null });
}

/**
 * Stop and redo, tapped on its card: the build of the note's request is
 * stopped, its note posted on the request's discussion as theirs (which
 * queues the request first), and the lost build stays quiet. Resolves
 * { ok, patch } or { ok: false, status, error }.
 */
async function redo(pool, config, { row, user, message = null, deps = {} }) {
  if (!row || row.kind !== 'redo' || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (row.state !== 'offered') return { ok: false, status: 409, error: 'That was decided already.' };
  const app = await appOf(pool, row.app_id, deps);
  if (!app || !(await mayorModule(deps).canView(pool, app, user))) return { ok: false, status: 404, error: 'No such card' };
  const n = Number(row.issue_number);
  if (!(await maySteer(pool, { app, user, issueNumber: n, deps })).ok) {
    return { ok: false, status: 403, error: 'Only whoever asked for it, or the project\'s owner, can have its build stopped.' };
  }
  if (message?.id) await pool.query('UPDATE homeroom_bot_build_notes SET message_id = $2 WHERE id = $1 AND message_id IS NULL', [row.id, Number(message.id)]);
  const build = await buildUnderWay(pool, app.id, n);
  if (!build?.running || (row.run_id && Number(row.run_id) !== build.runId)) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'offered'", [row.id]);
    return { ok: true, gone: true, patch: { state: 'gone' } };
  }
  // The claim, before the stop: the lost build reads it and says nothing.
  const { rows: [claimed] } = await pool.query(
    `UPDATE homeroom_bot_build_notes SET state = 'redone', settled_at = NOW(), run_id = $2, session_id = $3
      WHERE id = $1 AND state = 'offered' RETURNING id`,
    [row.id, build.runId, build.sessionId],
  );
  if (!claimed) return { ok: false, status: 409, error: 'That was decided already.' };
  let stopped = null;
  try {
    stopped = await (deps.stopTurn || stopBuildTurn)({ sessionId: build.sessionId, by: user.username || null });
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not stop a build to redo it', { sessionId: build.sessionId, err: err.message });
  }
  // 2 Nov 2026: a Stop that found no turn to stop (the build's coding turn
  // ended: it is in its tests, or done) is the build finishing first, as
  // with no build at all above, never a stop to try again in a minute.
  if (stopped?.body && stopped.body.stopped === false) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'redone'", [row.id]);
    return { ok: true, gone: true, patch: { state: 'gone' } };
  }
  if (!stopped?.body?.stopped) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'offered', settled_at = NULL WHERE id = $1 AND state = 'redone'", [row.id]);
    return { ok: false, status: 503, error: 'I could not stop it just now. Try again in a minute.' };
  }
  const steer = await maySteer(pool, { app, user, issueNumber: n, deps });
  const dm = dmModule(deps);
  // #6684: a note from a request is the person's comment there already: it
  // is never posted a second time.
  const posted = row.origin === 'request'
    ? { ok: true, onRequest: true }
    : await dm.postOnRequest(pool, {
      user, target: { app_id: app.id, issue_number: n, question_status: null, kind: null }, text: row.note, reason: 'dm_redo', deps,
    }).catch((err) => ({ ok: false, why: err.message }));
  if (!posted?.ok) {
    // Not on the request (they cannot post there): the next build of the
    // request is handed the note at its first stop instead.
    await pool.query(
      `INSERT INTO homeroom_bot_build_notes (app_id, issue_number, user_id, conversation_id, note, kind, state)
       VALUES ($1, $2, $3, $4, $5, 'note', 'waiting')`,
      [Number(app.id), n, Number(user.id), Number(row.conversation_id) || null, row.note],
    );
  }
  // Whoever asks pays, as start_request: the requester for their own.
  await botModule(deps).enqueueFront(pool, {
    appId: app.id, issueNumber: n, userId: user.id, reason: 'dm_redo', payerId: steer.theirs ? null : user.id,
  }).catch((err) => log.warn('homeroom-bot-steer', 'Could not queue a redo', { app: app.slug, issueNumber: n, err: err.message }));
  try { require('./bot-work-changed').noteWorkChanged(user.id, deps); } catch { /* the tray reads again on its own */ }
  log.info('homeroom-bot-steer', 'A build was stopped to be redone with its note', {
    app: app.slug, issueNumber: n, runId: build.runId, userId: user.id, posted: !!posted?.ok,
  });
  return { ok: true, patch: { state: 'redone', posted: !!posted?.ok } };
}

/**
 * Keep going, tapped under a Stop and redo offer: nothing stops, and the
 * note goes into the build at its next stop instead.
 */
async function keep(pool, { row, user, message = null }) {
  if (!row || row.kind !== 'redo' || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (row.state !== 'offered') return { ok: false, status: 409, error: 'That was decided already.' };
  const build = await buildUnderWay(pool, row.app_id, row.issue_number);
  if (!build || (row.run_id && Number(row.run_id) !== build.runId)) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'offered'", [row.id]);
    return { ok: true, gone: true, patch: { state: 'gone' } };
  }
  const { rows: [kept] } = await pool.query(
    `UPDATE homeroom_bot_build_notes SET kind = 'note', state = 'waiting', run_id = $2, session_id = $3,
            message_id = COALESCE(message_id, $4)
      WHERE id = $1 AND state = 'offered' RETURNING id`,
    [row.id, build.runId, build.sessionId, Number(message?.id) || null],
  );
  if (!kept) return { ok: false, status: 409, error: 'That was decided already.' };
  return { ok: true, patch: { state: 'waiting', kept: true } };
}

/**
 * Put it in the next update, tapped on a missed note: the note goes on the
 * change's public discussion as theirs, with revise_proposal's gates (who
 * may ask, its revisions, the week's building time), which queues its
 * follow-up. Resolves { ok, patch } or { ok: false, status, error }.
 */
async function forward(pool, config, { row, user, card, message = null, deps = {} }) {
  if (!row || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (row.state !== 'missed') return { ok: false, status: 409, error: 'That was decided already.' };
  const changeId = await openChangeOf(pool, row.app_id, row.issue_number, card?.change?.sessionId || null);
  if (!changeId) return { ok: false, status: 409, error: 'Its change is not up for a vote any more, so there is no next update to put it in.' };
  const settings = deps.settings || await botModule(deps).readSettings(pool);
  const ctx = {
    user, settings, config, deps: { ...(deps.reviseDeps || {}) }, bot: deps.bot || { id: Number(message?.botId) || null },
    userText: row.note, cards: [], revised: false, appIds: new Set(), inPublic: true,
    conversationId: Number(row.conversation_id) || null,
  };
  const revise = deps.reviseProposal || mayorModule(deps).reviseProposal;
  const out = await revise(pool, ctx, { proposal: changeId, change: row.note });
  if (!out?.ok) return { ok: false, status: 409, error: clip(out?.error || 'It could not be sent just now.', 400) };
  await pool.query("UPDATE homeroom_bot_build_notes SET state = 'forwarded', settled_at = NOW() WHERE id = $1 AND state = 'missed'", [row.id]);
  return { ok: true, patch: { state: 'forwarded' } };
}

module.exports = {
  NOTE_CHARS,
  noteText,
  buildUnderWay,
  buildForRequest,
  maySteer,
  addNote,
  cardOf,
  titleOf,
  noteFromRequest,
  redoFromRequest,
  patchCard,
  forwardFromRequest,
  noteRow,
  cardMessageOf,
  takeNotes,
  settleNotes,
  missedPatch,
  sweep,
  mayStopBotBuild,
  redoAsked,
  redo,
  keep,
  forward,
};
