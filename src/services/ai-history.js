'use strict';

// The Homeroom bot tab's History card: the person's work in the past tense.
// services/ai-work.js lists the threads they are in while they are moving
// (Needs you, Waiting & in progress, Live this week); a thread leaves those
// lists when it closes with nothing merged, a week after its change went
// live, or (a private thread) a week after it was marked done. This reads the
// same threads once they have left, so nothing of theirs is lost and nothing
// is listed in both places. It replaces Me › Your work's three lists (Your
// changes, Your requests, Your votes), which read the person's work by
// authorship alone and so missed what Homeroom bot built from their requests.
//
// One row a thing, newest first:
//
//   change    a change they built, or Homeroom bot built from their request:
//             live (a week or more ago), or closed without merging;
//   request   a request they filed that somebody else built: shipped, or
//             closed with nothing built;
//   vote      a change they voted on, once merged or closed, or a group
//             decision they opened or voted on, once decided;
//   solo      a private thread with Homeroom bot: marked done, put away,
//             filed (or posted) as a request that has since finished, or
//             about a change that is live or closed.
//
// A thread they only wrote in or followed is not theirs to remember, so it
// is not listed. In a private project they are no longer in, only what they
// made themselves stays: their own changes and requests, never their votes
// or other people's decisions. `before` pages back (the `at` of the last row
// read), `project` narrows to one project, `kind` to one of the four.

const aiWork = require('./ai-work');

const LIMIT_MAX = 60;
const KINDS = new Set(['change', 'request', 'vote', 'solo']);

// $1 viewer, $2 show self-hosted, $3 admin, $4 the most rows, $5 before (or
// NULL), $6 a project's slug (or NULL), $7 the days a live change stays in
// Live this week.
const HISTORY_THREADS_SQL = `
WITH mine AS (${aiWork.threadsInSql('$1')})
SELECT * FROM (
SELECT t.id, t.app_id, mine.own, t.number, t.kind, t.title AS thread_title, t.closed_at,
       a.slug, a.name, a.icon_emoji, a.icon_image_id, a.repo_url,
       ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL) AS visible,
       req.id AS request_id, req.title AS request_title, req.state AS request_state,
       req.closed_at AS request_closed_at, req.mine AS request_mine,
       ch.id AS change_id, ch.pr_number, ch.status AS change_status, ch.user_id AS change_user,
       ch.title AS change_title, ch.live_at, ch.archived_at, ch.my_vote,
       dec.id AS decision_id, dec.mine AS decision_mine, dec.my_vote AS decision_vote,
       dec.outcome AS decision_outcome, dec.at AS decision_at,
       -- Homeroom bot built it from their own request.
       (t.number IS NOT NULL AND EXISTS (
          SELECT 1 FROM homeroom_bot_requesters b
           WHERE b.app_id = t.app_id AND b.issue_number = t.number AND b.user_id = $1)) AS asked_bot,
       CASE
         WHEN ch.status = 'merged' THEN ch.live_at
         WHEN dec.status = 'closed' THEN COALESCE(dec.at, t.closed_at)
         WHEN ch.status = 'archived' THEN COALESCE(ch.archived_at, t.closed_at)
         ELSE COALESCE(req.closed_at, t.closed_at)
       END AS at
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
  JOIN apps a ON a.id = t.app_id
  LEFT JOIN app_collaborators me ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
  LEFT JOIN LATERAL (
    SELECT r.id, r.title, r.state, r.closed_at, (r.created_by = $1) AS mine FROM requests r
     WHERE r.thread_id = t.id
     ORDER BY (r.number = t.number) DESC, r.number
     LIMIT 1
  ) req ON TRUE
  -- The change that finished it: a merged one before one closed unmerged.
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.pr_number, cs.status, cs.user_id, cs.live_at, cs.archived_at,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
           -- Their last vote on it, on any version: a vote cast is part of
           -- their history even when a later version asked for it again.
           (SELECT v.vote FROM pr_votes v WHERE v.session_id = cs.id AND v.user_id = $1
             ORDER BY v.created_at DESC NULLS LAST LIMIT 1) AS my_vote
      FROM chat_sessions cs
     WHERE cs.thread_id = t.id AND cs.is_headless = FALSE
       AND cs.status IN ('merged', 'archived')
       AND (cs.status = 'merged' OR cs.promoted_at IS NOT NULL OR cs.user_id = $1)
     ORDER BY (cs.status = 'merged') DESC, cs.id DESC
     LIMIT 1
  ) ch ON TRUE
  -- A group decision, once it is decided: passed, or withdrawn, refused or
  -- overtaken (the governance machine's audit on its payload).
  LEFT JOIN LATERAL (
    SELECT i.id, i.status, (i.created_by = $1) AS mine,
           (SELECT v.vote FROM issue_votes v WHERE v.issue_id = i.id AND v.user_id = $1 LIMIT 1) AS my_vote,
           CASE
             WHEN i.payload ? 'withdrawnAt' THEN 'withdrawn'
             WHEN i.payload ? 'supersededAt' THEN 'closed'
             WHEN i.payload->>'appliedBy' LIKE 'refused:%' THEN 'closed'
             WHEN i.payload ? 'appliedAt' THEN 'passed'
             ELSE 'closed'
           END AS outcome,
           COALESCE(NULLIF(i.payload->>'appliedAt', ''), NULLIF(i.payload->>'withdrawnAt', ''),
                    NULLIF(i.payload->>'supersededAt', ''))::timestamptz AS at
      FROM issues i
     WHERE t.kind = 'decision' AND i.thread_id = t.id AND i.status = 'closed'
     ORDER BY i.id DESC
     LIMIT 1
  ) dec ON TRUE
 WHERE t.merged_into IS NULL
   AND a.moderation_suspended_at IS NULL
   AND (NOT a.self_hosted OR $2::boolean)
   AND ($6::text IS NULL OR a.slug = $6)
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)
   -- Finished, and no longer on the live lists: live for more than the week
   -- Live this week keeps it, closed with nothing merged, or decided. A
   -- merged change still going live, or live this week, is the lists' own.
   AND (ch.status IS DISTINCT FROM 'merged'
        OR (ch.live_at IS NOT NULL AND ch.live_at <= NOW() - make_interval(days => $7)))
   AND (ch.status IN ('merged', 'archived') OR req.state = 'closed' OR dec.id IS NOT NULL)
) done
 WHERE at IS NOT NULL AND ($5::timestamptz IS NULL OR at < $5)
 ORDER BY at DESC, id DESC
 LIMIT $4`;

// $1 viewer, $2 the most rows, $3 before (or NULL), $4 a project's slug (or
// NULL), $5 the days a done thread stays in Live this week. Their private
// threads that finished: marked done more than that week ago, put away,
// filed (or posted) as a request that has since closed or gone live, or
// about a change that is live or closed (ai-work.js ABOUT_CHANGE_END_SQL: at
// once, since the change's own row is the lists' and the thread is not).
const HISTORY_PRIVATE_SQL = `
SELECT * FROM (
SELECT p.id, p.root_message_id AS root_id, p.kind, p.state, p.result_ref, p.done_at, p.updated_at,
       a.slug, a.name, a.icon_emoji, a.icon_image_id, a.repo_url,
       m.content,
       p.about_kind, p.about_number,
       COALESCE((SELECT rq.title FROM requests rq
                  WHERE p.about_kind = 'request' AND rq.app_id = p.app_id AND rq.number = p.about_number),
                m.metadata->'homeroomBot'->>'aboutTitle') AS about_title,
       (SELECT d.title FROM design_threads d WHERE d.private_thread_id = p.id) AS design_title,
       m.metadata->'homeroomBot'->>'projectIdea' AS project_idea,
       m.metadata->'homeroomBot'->>'draftTitle' AS draft_title,
       -- A first version's thread by its project, the one its first message
       -- names when the project itself is gone (ai-work.js PRIVATE_SQL).
       m.metadata->'homeroomBot'->>'appName' AS root_app_name,
       (SELECT f.content FROM conversation_messages f
         WHERE f.thread_root_id = m.id AND f.sender_id = $1 AND f.deleted_at IS NULL
         ORDER BY f.id LIMIT 1) AS first_own,
       fin.at AS result_at, fin.outcome AS result_outcome, abt.outcome AS about_outcome,
       CASE
         WHEN p.state = 'done' THEN p.done_at
         WHEN p.state = 'dropped' THEN p.updated_at
         ELSE COALESCE(fin.at, abt.at)
       END AS at
  FROM private_threads p
  JOIN conversation_messages m ON m.id = p.root_message_id AND m.deleted_at IS NULL
  LEFT JOIN apps a ON a.id = p.app_id AND a.moderation_suspended_at IS NULL
  -- What became of the request it was filed as, or posted its plan on:
  -- live for longer than Live this week keeps it, or closed with nothing
  -- merged. A change of it still going live, or live this week, is that
  -- request's row on the lists, which the thread folds into (ai-work.js).
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT cs.live_at AS at, 'shipped' AS outcome FROM chat_sessions cs
       WHERE p.state IN ('filed', 'posted') AND p.result_ref > 0 AND cs.app_id = p.app_id
         AND p.result_ref = ANY(cs.linked_issues) AND cs.status = 'merged'
         AND cs.live_at <= NOW() - make_interval(days => $5)
      UNION ALL
      SELECT r.closed_at, 'closed' FROM requests r
       WHERE p.state IN ('filed', 'posted') AND p.result_ref > 0 AND r.app_id = p.app_id
         AND r.number = p.result_ref AND r.state = 'closed' AND r.closed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM chat_sessions m
                          WHERE m.app_id = r.app_id AND r.number = ANY(m.linked_issues) AND m.status = 'merged')
    ) f
    ORDER BY (f.outcome = 'shipped') DESC, f.at DESC
    LIMIT 1
  ) fin ON TRUE
  -- How the change it is about ended: live, or closed.
  LEFT JOIN LATERAL (${aiWork.ABOUT_CHANGE_END_SQL}) abt ON TRUE
 WHERE p.user_id = $1
   AND ($4::text IS NULL OR a.slug = $4)
   AND ((p.state = 'done' AND p.done_at <= NOW() - make_interval(days => $5))
        OR p.state = 'dropped'
        OR (p.state IN ('filed', 'posted') AND fin.at IS NOT NULL)
        OR abt.at IS NOT NULL)
) done
 WHERE at IS NOT NULL AND ($3::timestamptz IS NULL OR at < $3)
 ORDER BY at DESC, id DESC
 LIMIT $2`;

const iso = (at) => (at ? new Date(at).toISOString() : null);

/**
 * Pure: what one finished thread is in the person's history, or null when
 * it is not theirs to remember. `botId` is Homeroom bot's account.
 */
function pastOf(row, viewerId, botId = null) {
  const me = Number(viewerId);
  const theirs = row.change_user != null && Number(row.change_user) === me;
  const forThem = row.asked_bot === true && botId != null && row.change_user != null
    && Number(row.change_user) === Number(botId);
  const asked = row.request_mine === true;
  const vote = row.my_vote === 'yes' || row.my_vote === 'no' ? row.my_vote : null;
  // A private project they are no longer in keeps only what they made.
  const keepsOnlyOwn = row.visible !== true;
  let past = null;
  if (row.decision_id != null) {
    const myVote = row.decision_vote === 'yes' || row.decision_vote === 'no' ? row.decision_vote : null;
    if (row.decision_mine === true || myVote) {
      past = { kind: 'vote', outcome: row.decision_outcome || 'closed', decision: true, ...(myVote ? { myVote } : {}) };
    }
  } else if (row.change_status === 'merged') {
    if (theirs || forThem) past = { kind: 'change', outcome: 'live', by: theirs ? 'you' : 'bot' };
    else if (asked) past = { kind: 'request', outcome: 'shipped' };
    else if (vote) past = { kind: 'vote', outcome: 'merged', myVote: vote };
  } else if (row.change_status === 'archived' && theirs) {
    past = { kind: 'change', outcome: 'closed', by: 'you' };
  } else if (row.request_state === 'closed' && asked) {
    past = { kind: 'request', outcome: 'closed' };
  } else if (row.change_status === 'archived' && vote) {
    past = { kind: 'vote', outcome: 'closed', myVote: vote };
  }
  if (!past) return null;
  if (keepsOnlyOwn && past.kind !== 'change' && past.kind !== 'request') return null;
  if (keepsOnlyOwn && past.kind === 'change' && !theirs) return null;
  const number = row.number != null ? Number(row.number) : row.pr_number != null ? Number(row.pr_number) : null;
  return {
    key: `thread:${Number(row.id)}`,
    threadId: Number(row.id),
    number: past.decision ? null : number,
    title: row.request_title || row.change_title || row.thread_title || null,
    app: aiWork.appOf(row),
    href: aiWork.hrefOf(row),
    at: iso(row.at),
    // A change without a request of its own is named by its PR (on GitHub, "PR 12").
    ...(row.change_id && row.request_id == null ? { change: true } : {}),
    ...past,
    ...(keepsOnlyOwn ? { left: true } : {}),
  };
}

/** Pure: a finished private thread as a History row. */
function privatePastOf(row) {
  // A thread about a change ends as its change did: "Live Oct 24", or "Closed".
  const outcome = row.state === 'done' ? 'done'
    : row.state === 'dropped' ? 'put_away'
      : row.about_outcome === 'live' || row.about_outcome === 'closed' ? row.about_outcome
        : row.result_outcome === 'shipped' ? 'filed_shipped' : 'filed_closed';
  const shaped = aiWork.shapePrivate(row);
  return {
    key: `private:${Number(row.root_id)}`,
    rootId: Number(row.root_id),
    number: null,
    title: shaped.title,
    app: shaped.app,
    href: null,
    at: iso(row.at),
    kind: 'solo',
    outcome,
    ...(Number(row.result_ref) > 0 && (row.state === 'filed' || row.state === 'posted')
      ? { resultRef: Number(row.result_ref) } : {}),
  };
}

/** Pure: a request's `?before=` as a moment, or null (absent, or not one). */
function parseBefore(value) {
  if (value == null || value === '') return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The person's History, newest first: `{ rows, next }`, where `next` is the
 * `before` that reads the page after this one (null at the end). `kind`
 * narrows to change, request, vote or solo; `project` to one project's slug.
 */
async function historyFor(pool, { user, showSelfHosted = false, before = null, project = null, kind = null, limit = 40, deps = {} }) {
  const n = Math.max(1, Math.min(LIMIT_MAX, Number(limit) || 40));
  const want = kind && KINDS.has(kind) ? kind : null;
  const slug = project ? String(project).slice(0, 120) : null;
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot !== undefined ? deps.bot : await dm.botAccount(pool);
  // Read more than a page, so a kind or a project that narrows the rows
  // still fills one; what is left over is the next page's.
  const read = n * 3;
  const wantsThreads = want !== 'solo';
  const wantsPrivate = !want || want === 'solo';
  const [threads, privates] = await Promise.all([
    wantsThreads
      ? pool.query(HISTORY_THREADS_SQL, [user.id, !!showSelfHosted, !!user.isAdmin, read, before, slug, aiWork.LIVE_DAYS])
        .then((r) => r.rows)
      : Promise.resolve([]),
    wantsPrivate
      ? pool.query(HISTORY_PRIVATE_SQL, [user.id, read, before, slug, aiWork.LIVE_DAYS]).then((r) => r.rows)
      : Promise.resolve([]),
  ]);
  const shaped = [
    ...threads.map((row) => pastOf(row, user.id, bot ? bot.id : null)).filter(Boolean),
    ...privates.map(privatePastOf),
  ].filter((row) => !want || row.kind === want)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // Either read may have more past what it returned: the page ends at the
  // newer of the two full reads' last rows, so neither skips a row.
  const fullThreads = threads.length >= read;
  const fullPrivate = privates.length >= read;
  const floor = [
    fullThreads ? iso(threads[threads.length - 1].at) : null,
    fullPrivate ? iso(privates[privates.length - 1].at) : null,
  ].filter(Boolean).sort().pop() || null;
  const inPage = floor ? shaped.filter((row) => row.at >= floor) : shaped;
  const rows = inPage.slice(0, n);
  const more = rows.length < inPage.length || fullThreads || fullPrivate;
  const next = more && rows.length ? rows[rows.length - 1].at : (more ? floor : null);
  return { rows, next };
}

module.exports = {
  HISTORY_THREADS_SQL,
  HISTORY_PRIVATE_SQL,
  LIMIT_MAX,
  KINDS,
  pastOf,
  privatePastOf,
  parseBefore,
  historyFor,
};
