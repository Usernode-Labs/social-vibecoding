'use strict';

// Threads (#6019): every request, change, governance row and message about
// a piece of work is attached to one thread (src/db/schema.sql, "Threads").
// The schema's triggers attach every new row; the backfill below attaches
// the rows that were there before, once. Who follows a thread is at the end
// (stage 2).
//
// It is idempotent by its predicates: every statement touches only rows
// with no thread yet, and makes a numbered thread with ON CONFLICT DO
// NOTHING, so running it again, or after a run cut short, attaches what is
// left and changes nothing else. A `platform_settings` marker records a
// completed pass so later boots cost one lookup. Deleting the marker runs it
// again, which is safe.
//
// Messages are the large table, so they go in id ranges, set-based per
// range: a numbered thread is made for each request a message names first,
// then the messages are joined to it. Nothing here fails the boot: a step
// that throws is logged, the marker stays unset, and the next boot retries.

const log = require('./logger');
const issueRefs = require('./issue-proposal-ref');
const { IN_PROGRESS_PAUSED_WINDOW_DAYS } = require('./issue-progress');

const MARKER_KEY = 'threads_backfilled_v1';
const MESSAGE_BATCH = 10000;
const SESSION_BATCH = 2000;

async function markerSet(pool) {
  const { rows } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [MARKER_KEY]);
  return rows.length > 0;
}

async function setMarker(pool) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description) VALUES ($1, 'true', $2)
     ON CONFLICT (key) DO NOTHING`,
    [
      MARKER_KEY,
      'Marker: every request, change, governance row and message that existed when threads arrived (#6019, stage 1) '
      + 'has been attached to its thread. Deleting it re-runs the pass on the next boot, which is safe: it only '
      + 'attaches rows that have no thread.',
    ]
  );
}

// Requests: one thread per request number.
async function attachRequests(pool) {
  await pool.query(
    `INSERT INTO threads (app_id, number)
     SELECT app_id, number FROM requests WHERE thread_id IS NULL
     ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING`
  );
  const { rowCount } = await pool.query(
    `UPDATE requests r SET thread_id = t.id
       FROM threads t
      WHERE r.thread_id IS NULL AND t.app_id = r.app_id AND t.number = r.number`
  );
  return rowCount;
}

// Governance rows: a request's twin and a proposal to close join a number's
// thread; any other kind gets a decision thread of its own (the schema's
// issue_thread_id, the same rule the trigger applies). A twin with no number
// and a proposal to close that names none have no thread to join, so they
// are left out rather than rewritten as unattached on every pass.
async function attachIssues(pool) {
  const { rowCount } = await pool.query(
    `UPDATE issues
        SET thread_id = issue_thread_id(app_id, kind, github_issue_number, payload, title)
      WHERE thread_id IS NULL AND app_id IS NOT NULL
        AND NOT (kind = 'general' AND github_issue_number IS NULL)
        AND NOT (kind = 'close_issue' AND COALESCE(payload ->> 'issueNumber', '') !~ '^[0-9]{1,9}$')`
  );
  return rowCount;
}

// Changes, in id ranges: the schema's session_thread_id, the trigger's rule.
// Each one that gets a thread carries its replies with it (the
// chat_sessions_carry_thread_messages trigger).
async function attachSessions(pool, { batch = SESSION_BATCH } = {}) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM chat_sessions');
  const max = Number(rows[0].max) || 0;
  let attached = 0;
  for (let lo = 0; lo <= max; lo += batch) {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions
          SET thread_id = session_thread_id(app_id, linked_issues, created_from_issue_number,
                                            pr_number, branch_name, pr_title)
        WHERE id > $1 AND id <= $2 AND thread_id IS NULL AND app_id IS NOT NULL
          AND (cardinality(COALESCE(linked_issues, '{}')) > 0
               OR created_from_issue_number IS NOT NULL OR pr_number IS NOT NULL)`,
      [lo, lo + batch]
    );
    attached += rowCount;
  }
  return attached;
}

// Messages, in id ranges. A request's discussion names its number: make the
// threads those numbers need first, then join. A change's and a governance
// row's discussion join the thread their row already has.
async function attachMessages(pool, { batch = MESSAGE_BATCH } = {}) {
  await pool.query(
    `INSERT INTO threads (app_id, number)
     SELECT DISTINCT app_id, thread_ref FROM chat_messages
      WHERE thread_type = 'issue' AND thread_id IS NULL AND app_id IS NOT NULL AND thread_ref > 0
     ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING`
  );
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM chat_messages');
  const max = Number(rows[0].max) || 0;
  let attached = 0;
  for (let lo = 0; lo <= max; lo += batch) {
    const range = [lo, lo + batch];
    const issue = await pool.query(
      `UPDATE chat_messages m SET thread_id = t.id
         FROM threads t
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'issue'
          AND t.app_id = m.app_id AND t.number = m.thread_ref`,
      range
    );
    const session = await pool.query(
      `UPDATE chat_messages m SET thread_id = s.thread_id
         FROM chat_sessions s
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'session'
          AND s.id = m.thread_ref AND s.app_id = m.app_id AND s.thread_id IS NOT NULL`,
      range
    );
    const governance = await pool.query(
      `UPDATE chat_messages m SET thread_id = i.thread_id
         FROM issues i
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'governance'
          AND i.id = m.thread_ref AND i.app_id = m.app_id AND i.thread_id IS NOT NULL`,
      range
    );
    attached += issue.rowCount + session.rowCount + governance.rowCount;
  }
  return attached;
}

/**
 * Attach every row that existed before threads did. Requests and governance
 * rows first, then changes, then messages, so each message's anchor already
 * has its thread. Returns the counts, or `{ skipped }`.
 */
async function backfill(pool, { batch = {} } = {}) {
  try {
    if (await markerSet(pool)) return { skipped: 'done' };
  } catch (err) {
    log.warn('threads', 'Backfill not run: the marker could not be read', { err: err.message });
    return { skipped: 'unavailable' };
  }
  const started = Date.now();
  const counts = {};
  try {
    counts.requests = await attachRequests(pool);
    counts.issues = await attachIssues(pool);
    counts.sessions = await attachSessions(pool, { batch: batch.sessions });
    counts.messages = await attachMessages(pool, { batch: batch.messages });
    await setMarker(pool);
  } catch (err) {
    log.error('threads', 'Backfill stopped; the next boot carries on from where it got to', {
      err: err.message, ...counts,
    });
    return { failed: true, ...counts };
  }
  log.info('threads', 'Threads backfilled', { ...counts, ms: Date.now() - started });
  return counts;
}

// ── Followers (stage 2) ─────────────────────────────────────────────
//
// A thread's followers are worked out from what is in it, never stored:
//   requested  whoever filed one of its requests (the request, its twin in
//              `issues`, the bot's requester row, the feedback pin) or
//              proposed one of its governance rows;
//   built      whoever owns one of its changes;
//   voted      whoever voted on one of its changes or governance rows;
//   replied    whoever posted in it before the new message (a live, human
//              post: the bot's status lines make nobody a follower);
//   notify_me  whoever chose Notify me (`thread_followers`, muted_at NULL);
// less whoever chose Mute. The request half is #4535's rule for a request's
// discussion, read across every request number in the thread rather than
// one, so a request's discussion reaches exactly the people it did, plus
// the builders and voters.
//
// $1 the thread, $2 its app, $3 the new message (0 for "everyone now"),
// $4/$5 the app's repository owner and name, for feedback filed against the
// repository rather than the app.
const FOLLOWERS_SQL = `
WITH numbers AS (
  SELECT number FROM threads WHERE id = $1 AND number IS NOT NULL
  UNION SELECT number FROM requests WHERE thread_id = $1
  UNION SELECT github_issue_number FROM issues
         WHERE thread_id = $1 AND kind = 'general' AND github_issue_number IS NOT NULL
), derived AS (
  SELECT i.created_by AS user_id FROM issues i
   WHERE i.app_id = $2 AND i.github_issue_number IN (SELECT number FROM numbers)
  UNION SELECT i.created_by FROM issues i WHERE i.thread_id = $1
  UNION SELECT r.created_by FROM requests r WHERE r.thread_id = $1
  UNION SELECT b.user_id FROM homeroom_bot_requesters b
   WHERE b.app_id = $2 AND b.issue_number IN (SELECT number FROM numbers)
  UNION SELECT f.user_id FROM feedback_reports f
   WHERE f.issue_number IN (SELECT number FROM numbers)
     AND (f.app_id = $2 OR ($4::text IS NOT NULL
          AND LOWER(f.issue_owner) = LOWER($4) AND LOWER(f.issue_repo) = LOWER($5)))
  UNION SELECT s.user_id FROM chat_sessions s
    JOIN users u ON u.id = s.user_id AND u.is_synthetic = FALSE
   WHERE s.thread_id = $1
  UNION SELECT v.user_id FROM pr_votes v
    JOIN chat_sessions s ON s.id = v.session_id
   WHERE s.thread_id = $1
  UNION SELECT v.user_id FROM issue_votes v
    JOIN issues i ON i.id = v.issue_id
   WHERE i.thread_id = $1
  UNION SELECT m.user_id FROM chat_messages m
    JOIN users u ON u.id = m.user_id AND u.is_synthetic = FALSE
   WHERE m.thread_id = $1 AND ($3::int = 0 OR m.id < $3) AND m.msg_type = 'message'
     AND m.deleted_at IS NULL
)
(SELECT user_id FROM derived WHERE user_id IS NOT NULL
 UNION
 SELECT user_id FROM thread_followers WHERE thread_id = $1 AND muted_at IS NULL)
EXCEPT
SELECT user_id FROM thread_followers WHERE thread_id = $1 AND muted_at IS NOT NULL`;

/** The thread a stored message belongs to, with what a notification about it needs. */
async function threadOfMessage(db, { appId, messageId }) {
  const { rows } = await db.query(
    `SELECT m.thread_id, m.thread_type, m.thread_ref, t.number, t.kind, a.repo_url,
            EXISTS (SELECT 1 FROM chat_sessions s
                     WHERE s.thread_id = t.id AND s.pr_number = t.number) AS change_led
       FROM chat_messages m
       JOIN apps a ON a.id = m.app_id
       LEFT JOIN threads t ON t.id = m.thread_id AND t.app_id = m.app_id
      WHERE m.id = $1 AND m.app_id = $2`,
    [messageId, appId]
  );
  return rows[0] || null;
}

/** Who follows `threadId` (see FOLLOWERS_SQL); only posts before `beforeMessageId` count. */
async function followerIds(db, { threadId, appId, beforeMessageId = 0, owner = null, repo = null }) {
  if (!threadId || !appId) return [];
  const { rows } = await db.query(FOLLOWERS_SQL, [threadId, appId, Number(beforeMessageId) || 0, owner, repo]);
  return [...new Set(rows.map((r) => Number(r.user_id)))].filter(Number.isInteger);
}

/**
 * One person's standing in a thread: `following` (derived or Notify me),
 * `muted`, or `none`; `chosen` says whether they picked it themselves.
 */
async function followState(db, { threadId, appId, userId, owner = null, repo = null }) {
  if (!threadId || !userId) return { state: 'none', chosen: false };
  const { rows } = await db.query(
    'SELECT muted_at FROM thread_followers WHERE thread_id = $1 AND user_id = $2',
    [threadId, userId]
  );
  if (rows[0]) return { state: rows[0].muted_at ? 'muted' : 'following', chosen: true };
  const ids = await followerIds(db, { threadId, appId, owner, repo });
  return { state: ids.includes(Number(userId)) ? 'following' : 'none', chosen: false };
}

/**
 * Notify me (`notify` true), Mute (false), or back to the derived rule
 * (null). Resolves what is stored now.
 */
async function setFollow(db, { threadId, userId, notify }) {
  if (notify === null) {
    await db.query('DELETE FROM thread_followers WHERE thread_id = $1 AND user_id = $2', [threadId, userId]);
    return null;
  }
  await db.query(
    `INSERT INTO thread_followers (thread_id, user_id, muted_at)
     VALUES ($1, $2, CASE WHEN $3::boolean THEN NULL ELSE NOW() END)
     ON CONFLICT (thread_id, user_id) DO UPDATE
       SET muted_at = EXCLUDED.muted_at, updated_at = NOW()`,
    [threadId, userId, !!notify]
  );
  return !!notify;
}

// Posting in a thread you muted follows it again, as replying does on
// GitHub: the person is taking part, and an answer to what they just said
// should reach them. Notify me stays.
async function unmuteOnPost(db, { messageId, userId }) {
  if (!messageId || !userId) return 0;
  const { rowCount } = await db.query(
    `DELETE FROM thread_followers f
      USING chat_messages m
      WHERE m.id = $1 AND m.thread_id IS NOT NULL AND f.thread_id = m.thread_id
        AND f.user_id = $2 AND f.muted_at IS NOT NULL`,
    [messageId, userId]
  );
  return rowCount || 0;
}

// ── The thread page (stage 3) ───────────────────────────────────────

// How many merges a thread's number is followed through to where it went.
const MERGE_HOPS = 8;
// How many of an item's newest replies its row folds under it.
const FOLDED_REPLIES = 3;

/**
 * The thread a number names in `appId`: the number's own (a request's, or a
 * change's that leads one), else the thread of the change whose pull
 * request has that number, which may lead a request's thread; then wherever
 * a merge took it. Numbers are one sequence per app, so a number is at most
 * one of these. Null when there is none.
 */
async function threadForNumber(db, { appId, number }) {
  const n = Number(number);
  if (!appId || !Number.isSafeInteger(n) || n <= 0) return null;
  let { rows } = await db.query(
    'SELECT id, app_id, number, kind, title, state, merged_into FROM threads WHERE app_id = $1 AND number = $2',
    [appId, n]
  );
  if (!rows[0]) {
    ({ rows } = await db.query(
      `SELECT t.id, t.app_id, t.number, t.kind, t.title, t.state, t.merged_into
         FROM chat_sessions s JOIN threads t ON t.id = s.thread_id
        WHERE s.app_id = $1 AND s.pr_number = $2
        ORDER BY s.id DESC LIMIT 1`,
      [appId, n]
    ));
  }
  return followMerges(db, rows[0] || null);
}

/** The thread `id`, through any merges, or null. */
async function threadById(db, id) {
  if (!/^[1-9][0-9]{0,15}$/.test(String(id))) return null;
  const { rows } = await db.query(
    'SELECT id, app_id, number, kind, title, state, merged_into FROM threads WHERE id = $1',
    [id]
  );
  return followMerges(db, rows[0] || null);
}

async function followMerges(db, thread) {
  let at = thread;
  for (let hop = 0; at && at.merged_into && hop < MERGE_HOPS; hop += 1) {
    const { rows } = await db.query(
      `SELECT id, app_id, number, kind, title, state, merged_into
         FROM threads WHERE id = $1 AND app_id = $2`,
      [at.merged_into, at.app_id]
    );
    if (!rows[0]) break;
    at = rows[0];
  }
  return at;
}

// Everything in a thread, oldest first, with how many people's replies are
// anchored to each. A change is listed by the rule the request page's
// "Addressed by" already uses (issue-proposal-ref.js): proposed work is
// public, a live chat only to its owner until they share it.
const ITEMS_SQL = `
SELECT 'request' AS type, r.id::bigint AS id, r.number, r.title, r.state AS status,
       NULL::int AS user_id, NULL::timestamptz AS shared_at, r.created_at,
       (SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = r.number
           AND m.msg_type = 'message' AND m.deleted_at IS NULL)::int AS replies,
       NULL::int AS epoch, NULL::text AS my_vote
  FROM requests r WHERE r.thread_id = $1
UNION ALL
SELECT 'change', cs.id::bigint, cs.pr_number,
       COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''), NULLIF(cs.branch_name, '')),
       cs.status, cs.user_id, cs.shared_at, cs.created_at,
       (SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type = 'session' AND m.thread_ref = cs.id
           AND m.msg_type = 'message' AND m.deleted_at IS NULL)::int,
       cs.approval_epoch,
       (SELECT v.vote::text FROM pr_votes v
         WHERE v.session_id = cs.id AND v.user_id = $3
           AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch)
  FROM chat_sessions cs
 WHERE cs.thread_id = $1 AND cs.is_headless = FALSE
   AND (cs.status IN ('active', 'promoted', 'merging', 'merged')
        OR (cs.status = 'paused' AND cs.last_activity_at > NOW() - make_interval(days => $2)))
UNION ALL
SELECT CASE WHEN i.kind = 'close_issue' THEN 'close' ELSE 'decision' END, i.id::bigint, NULL::int,
       i.title, i.status, i.created_by, NULL::timestamptz, i.created_at,
       (SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type = 'governance' AND m.thread_ref = i.id
           AND m.msg_type = 'message' AND m.deleted_at IS NULL)::int,
       NULL::int, NULL::text
  FROM issues i WHERE i.thread_id = $1 AND i.kind <> 'general'
 ORDER BY created_at, type, id`;

// The newest few replies anchored to each change and governance row, for
// the fold under its row; nobody the viewer blocked, or who blocked them.
const FOLDED_SQL = `
SELECT f.thread_type, f.thread_ref, f.id, f.content, f.created_at, u.username, u.is_synthetic
  FROM (SELECT m.id, m.thread_type, m.thread_ref, m.content, m.created_at, m.user_id,
               ROW_NUMBER() OVER (PARTITION BY m.thread_type, m.thread_ref ORDER BY m.id DESC) AS k
          FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type IN ('session', 'governance')
           AND m.msg_type = 'message' AND m.deleted_at IS NULL AND m.user_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = $2 AND b.blocked_user_id = m.user_id)
                 OR (b.blocker_id = m.user_id AND b.blocked_user_id = $2))) f
  JOIN users u ON u.id = f.user_id
 WHERE f.k <= $3
 ORDER BY f.id`;

/**
 * What a thread page draws: the thread (what leads it, by kind), every item
 * in it the viewer may open, the newest replies folded under each change and
 * governance row, and the viewer's Notify me / Mute standing.
 */
async function threadPage(db, { thread, viewerId = null, owner = null, repo = null }) {
  const { rows } = await db.query(ITEMS_SQL, [thread.id, IN_PROGRESS_PAUSED_WINDOW_DAYS, viewerId || 0]);
  const { rows: folded } = await db.query(FOLDED_SQL, [thread.id, viewerId || 0, FOLDED_REPLIES]);
  const foldOf = new Map();
  for (const f of folded) {
    const key = `${f.thread_type === 'session' ? 'change' : 'governance'}:${f.thread_ref}`;
    if (!foldOf.has(key)) foldOf.set(key, []);
    foldOf.get(key).push({
      id: Number(f.id),
      username: f.username,
      bot: !!f.is_synthetic,
      text: String(f.content || '').slice(0, 280),
      at: f.created_at,
    });
  }
  const items = [];
  for (const row of rows) {
    if (row.type === 'change' && !issueRefs.isNavigable(row, viewerId)) continue;
    const item = {
      type: row.type,
      id: Number(row.id),
      number: row.number == null ? null : Number(row.number),
      title: row.title || null,
      status: row.status,
      at: row.created_at,
      replies: Number(row.replies) || 0,
    };
    if (row.type === 'change') {
      item.state = issueRefs.stateOf(row.status);
      item.folded = foldOf.get(`change:${row.id}`) || [];
      // Stage 6: what the ballot casts with, and the viewer's own vote.
      item.epoch = row.epoch == null ? null : Number(row.epoch);
      item.myVote = row.my_vote === 'yes' || row.my_vote === 'no' ? row.my_vote : null;
    } else if (row.type === 'close' || row.type === 'decision') {
      item.folded = foldOf.get(`governance:${row.id}`) || [];
    }
    items.push(item);
  }
  const number = thread.number == null ? null : Number(thread.number);
  const leadsChange = number != null
    && items.some((i) => i.type === 'change' && i.number === number)
    && !items.some((i) => i.type === 'request' && i.number === number);
  const lead = number == null ? 'decision' : leadsChange ? 'change' : 'request';
  const follow = viewerId
    ? await followState(db, { threadId: thread.id, appId: thread.app_id, userId: viewerId, owner, repo })
    : null;
  return {
    thread: {
      id: Number(thread.id),
      number,
      kind: thread.kind,
      lead,
      title: thread.title || null,
      state: thread.state,
    },
    items,
    follow,
  };
}

// ── Ballots (stage 6) ────────────────────────────────────────────────
//
// Two or more changes in one thread up for a vote are one ballot on its page
// (features/dev-board/topic/thread-ballot.tsx); underneath each keeps its
// own vote, pinned to its own revision. The first to pass goes live, and the
// merge closes the others ('superseded', reversible like any close,
// session-lifecycle.js archiveSession), each saying why in its discussion.
// Called from the merge's own pass over its requests
// (issue-close-watcher.js closeAfterMerge). Never throws: a rival left open
// is still a proposal anyone can withdraw, and the merge must not wait on it.
async function closeRivals(db, { appId, prNumber, deps = {} }) {
  try {
    const { rows: [won] } = await db.query(
      `SELECT id, thread_id FROM chat_sessions
        WHERE app_id = $1 AND pr_number = $2 AND status = 'merged' AND thread_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [appId, prNumber]
    );
    if (!won) return [];
    const { rows: rivals } = await db.query(
      `SELECT id, status FROM chat_sessions
        WHERE thread_id = $1 AND id <> $2 AND status = 'promoted' AND is_headless = FALSE`,
      [won.thread_id, won.id]
    );
    const lifecycle = deps.lifecycle || require('./session-lifecycle');
    const ws = deps.ws || require('./ws');
    const closed = [];
    for (const rival of rivals) {
      try {
        const out = await lifecycle.archiveSession({ pool: db, sessionId: Number(rival.id), reason: 'superseded', from: rival.status });
        if (!out.archived) continue;
        closed.push(Number(rival.id));
        await ws.sendSystemMessage(db, appId, `Change #${prNumber} went live first, so this one closes.`,
          'system', null, { type: 'session', ref: Number(rival.id) }).catch(() => {});
      } catch (err) {
        log.warn('threads', 'A rival change could not be closed', { sessionId: Number(rival.id), err: err.message });
      }
    }
    if (closed.length) log.info('threads', 'Closed the rivals of a change that went live', { appId, prNumber, closed });
    return closed;
  } catch (err) {
    log.warn('threads', 'Could not look for a merged change\'s rivals', { appId, prNumber, err: err.message });
    return [];
  }
}

module.exports = {
  closeRivals,
  threadForNumber,
  threadById,
  threadPage,
  FOLDED_REPLIES,
  FOLLOWERS_SQL,
  threadOfMessage,
  followerIds,
  followState,
  setFollow,
  unmuteOnPost,
  MARKER_KEY,
  MESSAGE_BATCH,
  SESSION_BATCH,
  attachRequests,
  attachIssues,
  attachSessions,
  attachMessages,
  backfill,
};
