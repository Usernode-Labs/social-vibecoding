'use strict';

// A promise the Homeroom bot made to tell one person when something about a
// change happens (issue #6264). A reply that agrees to "tell me when the
// update is made", the plan card's "Notify me when it's ready", and the
// bot's own offer when it queues work all store one row here. When that
// moment comes the change's own workflow work asks `fire`, which posts one
// line in the place it was asked and rings the person's bell as a mention.
//
// The row is the promise, not the model's memory: a release, a restart or a
// second turn neither loses it nor says it twice (a row is claimed with an
// UPDATE before its line goes out, and a fired row with no message is taken
// up again).
//
//   update ─▶ checks ─▶ vote ─▶ merged ─▶ live
//
// A later moment answers every follow-up still waiting on an earlier one, so
// nobody is left waiting for news that has been overtaken. A change that
// closes first cancels them, with one line saying so. A follow-up about a
// request whose change never came expires quietly after 30 days.

const log = require('./logger');
const repoRef = require('./repo-ref');
const { withoutEmDashes } = require('./em-dashes');

const EVENTS = Object.freeze(['update', 'checks', 'vote', 'merged', 'live']);
const ORDER = Object.freeze({ update: 0, checks: 1, vote: 2, merged: 3, live: 4 });
const PLACE_TYPES = Object.freeze(['issue', 'session', 'chat', 'category', 'message', 'dm']);
// Long enough for a change to be built and put up for a vote.
const EXPIRE_DAYS = 30;

const isEvent = (e) => EVENTS.includes(String(e));

/** Pure: the sentence the reply must contain when a follow-up is stored. */
function promiseFor(event) {
  switch (event) {
    case 'update': return 'I\'ll tell you here when it\'s in.';
    case 'checks': return 'I\'ll tell you here when its checks finish.';
    case 'vote': return 'I\'ll tell you here when it\'s ready to vote.';
    case 'merged': return 'I\'ll tell you here when it\'s merged.';
    case 'live': return 'I\'ll tell you here when it\'s live.';
    default: return null;
  }
}

/** Pure: what the bot says when the moment comes. English, no em dashes. */
function lineFor({ event, verdict = null, changeName = 'the change', username = 'there' }) {
  const name = `@${username}`;
  switch (event) {
    case 'update': return `${name}, the update to ${changeName} is in, and its checks are running.`;
    case 'checks':
      return verdict === 'failing'
        ? `${name}, the checks on ${changeName} have finished: some failed.`
        : `${name}, the checks on ${changeName} have finished: they all passed.`;
    case 'vote': return `${name}, ${changeName} is ready to vote on.`;
    case 'merged': return `${name}, ${changeName} was approved and merged. It goes live next.`;
    case 'live': return `${name}, ${changeName} is live.`;
    default: return `${name}, ${changeName} has news.`;
  }
}

/** Pure: the one line a change's close leaves a waiting person. */
function closedLine({ changeName = 'the change', username = 'there' }) {
  return `@${username}, ${changeName} was closed, so there's nothing more to tell you about it.`;
}

/** Pure: "PR 6249" on a GitHub repository, "change 6249" elsewhere. */
function nameOf(row, repoUrl) {
  const n = Number(row.pr_number) || Number(row.id);
  return repoRef.isGithub(repoUrl) ? `PR ${n}` : `change ${n}`;
}

function saying(text) {
  return withoutEmDashes(String(text || '')).replace(/\s+/g, ' ').trim();
}

async function changeOf(pool, sessionId) {
  const { rows: [row] } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.pr_number, cs.status, cs.linked_issues, cs.reviewed_head_sha,
            cs.imported_pr_head_sha, cs.checks_commit_sha, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`, [Number(sessionId)]);
  return row || null;
}

// Whether `event` has already happened to the change, so that promising it
// would be a promise about the past. Resolves null (still to come) or the
// sentence that says where it stands.
function passed(row, event) {
  if (!row) return 'That change is gone, so there is nothing to tell you about it.';
  const status = String(row.status || '');
  if (status === 'closed') return 'That change was closed, so there is nothing more to tell you about it.';
  if (status === 'live' || row.live_at) {
    if (event !== 'live') return 'That change is live already, so there is nothing more to tell you about it.';
  }
  if (status === 'merged' && ORDER[event] < ORDER.merged) {
    return 'That change was approved and merged already. It goes live next.';
  }
  return null;
}

/**
 * Store one follow-up: `{ id, promise }`, or `{ ok: false, error }` when the
 * ask cannot be kept (the moment has passed) or is malformed.
 */
async function register(pool, {
  user, app, sessionId = null, issueNumber = null, event, place,
  conversationId = null, threadRootId = null, head = null, deps = {},
}) {
  if (!isEvent(event)) return { ok: false, error: `Unknown event: ${event}.` };
  const placeType = place?.type;
  if (!PLACE_TYPES.includes(placeType)) return { ok: false, error: 'I cannot tell where to tell you that.' };
  const sid = sessionId == null ? null : Number(sessionId);
  const num = issueNumber == null ? null : Number(issueNumber);
  if (!sid && !(Number.isInteger(num) && num > 0)) {
    return { ok: false, error: 'Which change or request: I need one to tell you about it.' };
  }
  let row = null;
  if (sid) {
    row = await changeOf(pool, sid);
    const why = passed(row, event);
    if (why) return { ok: false, error: why };
  }
  const appId = Number(app?.id ?? row?.app_id);
  if (!appId) return { ok: false, error: 'That is not a project I can see.' };
  const userId = Number(user?.id);
  if (!userId) return { ok: false, error: 'I can only tell you yourself.' };

  const client = await pool.connect();
  let id = null;
  try {
    await client.query('BEGIN');
    // A second ask about the same thing replaces the first: one promise.
    await client.query(
      `UPDATE homeroom_bot_followups SET state = 'replaced', settled_at = now()
        WHERE user_id = $1 AND app_id = $2 AND state = 'waiting'
          AND COALESCE(session_id, 0) = $3 AND COALESCE(issue_number, 0) = $4`,
      [userId, appId, sid || 0, num || 0]);
    const { rows } = await client.query(
      `INSERT INTO homeroom_bot_followups
         (user_id, app_id, session_id, issue_number, event, place_type, place_ref,
          conversation_id, thread_root_id, head_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [userId, appId, sid, Number.isInteger(num) && num > 0 ? num : null, event, placeType,
        place?.ref == null ? null : Number(place.ref), conversationId == null ? null : Number(conversationId),
        threadRootId == null || threadRootId === false ? null : Number(threadRootId),
        typeof head === 'string' && /^[0-9a-f]{40}$/i.test(head) ? head.toLowerCase() : row?.reviewed_head_sha || null]);
    id = Number(rows[0].id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.warn('thread-followups', 'Could not store a follow-up', { appId, sessionId: sid, event, err: err.message });
    return { ok: false, error: 'I could not keep that just now. Ask me again in a minute.' };
  } finally {
    client.release();
  }
  return { ok: true, id, promise: promiseFor(event) };
}

// ── Posting ─────────────────────────────────────────────────────────────

async function appOf(pool, appId) {
  const { rows: [app] } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [Number(appId)]);
  return app || null;
}

async function usernameOf(pool, userId) {
  const { rows: [row] } = await pool.query('SELECT username FROM users WHERE id = $1', [Number(userId)]);
  return row?.username || 'there';
}

/**
 * One line, where it was asked. In a request or a change it is the bot's own
 * message in that thread; in a project's chat or a reply thread it is a
 * message in the reply thread under the ask; in a DM it is a message there.
 * Everyone but a DM rings the person's bell as any mention does.
 * Resolves the message's id, or null. A line that could not be sent throws
 * (bot-post.js post, its row left pending), so the work that fired it is
 * retried and tells it then.
 */
async function deliver(pool, row, text, { deps = {} } = {}) {
  const body = saying(text);
  if (!body) return null;
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot || await dm.botAccount(pool);
  if (!bot) return null;
  if (row.place_type === 'dm') {
    const sent = await dm.sendDm(pool, {
      bot, userId: Number(row.user_id), content: body,
      idempotencyKey: `followup:${Number(row.id)}`,
      threadRootId: row.thread_root_id == null ? undefined : Number(row.thread_root_id),
    });
    // homeroom-bot-dm.js sendDm answers { messageId }: reading `id` alone
    // left every DM follow-up owed, so it was sent again on each pass.
    const id = sent?.messageId ?? sent?.id;
    return id ? Number(id) : null;
  }
  const app = await appOf(pool, row.app_id);
  if (!app) return null;
  const ws = deps.ws || require('./ws');
  const thread = row.place_type === 'issue' ? { type: 'issue', ref: Number(row.place_ref) }
    : row.place_type === 'session' ? { type: 'session', ref: Number(row.place_ref) }
      : { type: 'message', ref: Number(row.place_ref) };
  if (!thread.ref) return null;
  // Step 4: one post (bot-post.js), once per follow-up: an answer to the
  // person who asked to be told.
  const out = await require('./bot-post').post(pool, {
    place: thread, appId: app.id, kind: 'followup_told', words: body, author: bot,
    ...(thread.type === 'issue' ? { issueNumber: thread.ref } : {}),
    version: `followup-${Number(row.id)}`, record: false,
  }, { ws });
  if (out.outcome === 'again') return out.messageId ? Number(out.messageId) : null;
  const sent = out.outcome === 'said' ? { id: out.messageId } : null;
  if (!sent?.id) return null;
  const username = await usernameOf(pool, row.user_id);
  try {
    const notify = deps.notifications || require('./notifications');
    const rows = await notify.createMentionNotifications(pool, {
      appId: app.id, chatMessageId: sent.id, senderId: bot.id, content: `@${username}`,
    });
    await Promise.all((rows || []).map((r) => notify.hydrateAndPush(pool, r)));
  } catch (err) {
    log.warn('thread-followups', 'Could not ring the person (line kept)', { appId: app.id, err: err.message });
  }
  return Number(sent.id);
}

// The one line a claimed row owes, posted and its message recorded. Throws
// so the caller's work item retries instead of reporting success.
async function tell(pool, row, { event, verdict, deps }) {
  const change = row.session_id ? await changeOf(pool, row.session_id) : null;
  const username = await usernameOf(pool, row.user_id);
  const changeName = change ? nameOf(change, change.repo_url) : `request #${row.issue_number}`;
  const text = lineFor({ event, verdict, changeName, username });
  const messageId = await deliver(pool, row, text, { deps });
  if (messageId == null) {
    // They blocked the bot or left: nothing more to say, and never a retry
    // loop that says nothing. The row stays fired with no message.
    log.info('thread-followups', 'Follow-up fired but could not be told', { id: Number(row.id), place: row.place_type });
    return null;
  }
  await pool.query('UPDATE homeroom_bot_followups SET message_id = $2 WHERE id = $1', [Number(row.id), messageId]);
  return messageId;
}

// ── Moments ─────────────────────────────────────────────────────────────

/**
 * The change's own moment: post one line to everyone waiting on it, once.
 * `event` is one of the five; `verdict` is the checks' ('passing', 'skipped',
 * 'failing'). `head` is the change's head now (an 'update' fires only on a
 * newer one). Resolves how many lines went out.
 */
async function fire(pool, { sessionId, event, head = null, verdict = null, deps = {} }) {
  if (!isEvent(event)) return 0;
  const sid = Number(sessionId);
  if (!Number.isInteger(sid) || sid <= 0) return 0;
  const change = await changeOf(pool, sid);
  if (!change) return 0;
  const issues = Array.isArray(change.linked_issues) ? change.linked_issues.map(Number).filter((n) => n > 0) : [];
  const { rows } = await pool.query(
    `SELECT * FROM homeroom_bot_followups
      WHERE (session_id = $1 AND (state = 'waiting' OR (state = 'fired' AND message_id IS NULL)))
         OR ($2::int[] <> '{}' AND session_id IS NULL AND app_id = $3 AND issue_number = ANY($2::int[])
             AND (state = 'waiting' OR (state = 'fired' AND message_id IS NULL)))
      ORDER BY id`, [sid, issues, Number(change.app_id)]);
  const now = head || change.reviewed_head_sha || null;
  let told = 0;
  for (const row of rows) {
    const late = ORDER[row.event] < ORDER[event];
    if (row.state === 'waiting' && row.event !== event && !((event === 'merged' || event === 'live') && late)) continue;
    // An ask made when the head was this one is asking about a newer update.
    if (row.event === 'update' && row.state === 'waiting' && row.head_sha && now && String(row.head_sha) === String(now)) continue;
    const { rows: claimed } = await pool.query(
      `UPDATE homeroom_bot_followups SET state = 'fired', settled_at = now(),
              session_id = COALESCE(session_id, $2)
        WHERE id = $1 AND (state = 'waiting' OR (state = 'fired' AND message_id IS NULL))
        RETURNING *`, [Number(row.id), sid]);
    if (!claimed.length) continue;
    if (await tell(pool, claimed[0], { event, verdict, deps })) told += 1;
  }
  return told;
}

/** The change closed: every waiting person gets one line saying so. */
async function cancel(pool, { sessionId, deps = {} }) {
  const sid = Number(sessionId);
  if (!Number.isInteger(sid) || sid <= 0) return 0;
  const change = await changeOf(pool, sid);
  if (!change) return 0;
  const issues = Array.isArray(change.linked_issues) ? change.linked_issues.map(Number).filter((n) => n > 0) : [];
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_followups SET state = 'cancelled', settled_at = now()
      WHERE (session_id = $1 OR ($2::int[] <> '{}' AND session_id IS NULL AND app_id = $3 AND issue_number = ANY($2::int[])))
        AND state = 'waiting'
      RETURNING *`, [sid, issues, Number(change.app_id)]);
  let told = 0;
  for (const row of rows) {
    const username = await usernameOf(pool, row.user_id);
    const text = closedLine({ changeName: nameOf(change, change.repo_url), username });
    try {
      await deliver(pool, { ...row, session_id: row.session_id ?? sid }, text, { deps });
      told += 1;
    } catch (err) {
      log.warn('thread-followups', 'Could not say a follow-up was called off', { id: Number(row.id), err: err.message });
    }
  }
  return told;
}

/**
 * The bot is already telling this person this news itself (its "Done" report
 * after an update they asked for, its ready card): that message keeps the
 * promise, so the waiting row is done and says nothing more.
 */
async function satisfiedBy(pool, { sessionId, userId = null, place = null, event, messageId = null }) {
  const sid = Number(sessionId);
  if (!Number.isInteger(sid) || sid <= 0 || !isEvent(event)) return 0;
  // A promise made while the request's first version was still being built
  // (#6255) is stored with no session: it is about the request, and the
  // change that links it is the one that keeps it. Same match `fire` uses.
  const change = await changeOf(pool, sid);
  if (!change) return 0;
  const issues = Array.isArray(change.linked_issues) ? change.linked_issues.map(Number).filter((n) => n > 0) : [];
  const values = [sid, event, messageId == null ? null : Number(messageId), Number(change.app_id), issues];
  let sql = `UPDATE homeroom_bot_followups
                SET state = 'fired', settled_at = now(), message_id = $3,
                    session_id = COALESCE(session_id, $1)
              WHERE (session_id = $1
                     OR ($5::int[] <> '{}' AND session_id IS NULL AND app_id = $4 AND issue_number = ANY($5::int[])))
                AND event = $2 AND state = 'waiting'`;
  if (userId != null) { values.push(Number(userId)); sql += ` AND user_id = $${values.length}`; }
  if (place?.type) { values.push(place.type); sql += ` AND place_type = $${values.length}`; }
  const { rowCount } = await pool.query(sql, values);
  return rowCount || 0;
}

/** A promise about a change that never came is dropped after 30 days, quietly. */
async function expireOld(pool) {
  const { rowCount } = await pool.query(
    `UPDATE homeroom_bot_followups SET state = 'expired', settled_at = now()
      WHERE state = 'waiting' AND created_at < now() - ($1::int * interval '1 day')`, [EXPIRE_DAYS]);
  return rowCount || 0;
}

module.exports = {
  EVENTS, promiseFor, lineFor, closedLine, nameOf,
  register, fire, cancel, satisfiedBy, expireOld, deliver,
};
