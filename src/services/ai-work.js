'use strict';

// The AI tab's main view (#6019 follow-up, plan v3: "what needs you comes
// first, then your private threads, with a lock on the tile, then Up next:
// what's moving without you, soonest first"). frontend/src/features/ai/ draws
// it; this reads what it lists, for one person, across every project they
// can see:
//
//   private  their private threads in the chat with Homeroom bot that have
//            gone nowhere yet: the threads they started (services/
//            private-threads.js) and the drafts the bot opened for them, each
//            with the project it is for, if it has one;
//   threads  the public threads they are in, by the rule a thread's
//            followers are worked out by (threads.js FOLLOWERS_SQL, read the
//            other way round; threadsInSql): they asked for it, built a
//            change in it, voted in it, wrote in it, or chose Notify me, and
//            did not choose Mute. Each says which list it is in:
//              needs    Needs you, beside the Needs you feed: a plan Homeroom
//                       bot wrote for their request, waiting for their Build
//                       it (the feed carries no such card);
//              next     In progress: one of THEIRS (they asked for it, built
//                       it, or chose Notify me) being worked on: Homeroom bot
//                       reading it, a change being made or fixed, merging, or
//                       merged and going live;
//              waiting  Up next: one of theirs waiting on someone else: up
//                       for a vote they have voted on (or that is theirs), a
//                       change's or a group decision's (which has nothing to
//                       build),
//                       waiting for a free builder or held back (as the bot
//                       says in Main), or a request nobody has picked up;
//              live     a change of it went live in the last week.
//            One they only voted or wrote in is listed only once it is live
//            or while nobody has picked it up: once they have voted there is
//            nothing left for them to do. A change up for a vote that still
//            owes their vote is the Needs you feed's (GET /api/workshop/
//            needs-feed?in=threads, the same threads), which the view puts
//            first, so it is not listed here twice.
//
// ONE STORY WITH MAIN (29 Oct 2026). Where Homeroom bot works on a request
// for them, the list it is in is the bot's own word on it: the stage its
// answer to "how far along are you?" reads (homeroom-bot-progress.js
// requestStates). Read off the request and its change alone, a plan waiting
// for Build it and a request held back for a build said "Not picked up
// yet", or nothing at all, while the bot said otherwise in Main.
//
// The projects are the ones the Workshop's own reads show the viewer
// (routes/workshop-overview.js VISIBLE_APP_WHERE): not suspended, a
// self-hosted one only for an admin or where public voting is on, and a
// private one only to its members.

const log = require('./logger');

const THREADS_MAX = 80;
const PRIVATE_MAX = 30;
const LIVE_DAYS = 7;

const VISIBLE_APP_WHERE = `a.moderation_suspended_at IS NULL
     AND (NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)`;

// The threads a person is in (`viewer` is the SQL parameter that names
// them, e.g. '$1'), one row each: `own` when the thread is theirs (they
// asked for it, built a change in it, or chose Notify me) rather than one
// they only voted or wrote in. Muting is the reader's to apply. The Homeroom
// bot tab's Needs you (routes/workshop-overview.js, ?in=threads) reads the
// same threads, so its two lists agree on what is yours.
function threadsInSql(viewer) {
  return `SELECT thread_id, bool_or(own) AS own FROM (
    SELECT thread_id, TRUE AS own FROM requests WHERE created_by = ${viewer} AND thread_id IS NOT NULL
    UNION ALL SELECT thread_id, TRUE FROM issues WHERE created_by = ${viewer} AND thread_id IS NOT NULL
    UNION ALL SELECT t.id, TRUE FROM homeroom_bot_requesters b
                JOIN threads t ON t.app_id = b.app_id AND t.number = b.issue_number
               WHERE b.user_id = ${viewer}
    UNION ALL SELECT thread_id, TRUE FROM chat_sessions
               WHERE user_id = ${viewer} AND thread_id IS NOT NULL AND is_headless = FALSE
    UNION ALL SELECT s.thread_id, FALSE FROM pr_votes v JOIN chat_sessions s ON s.id = v.session_id
               WHERE v.user_id = ${viewer} AND s.thread_id IS NOT NULL
    UNION ALL SELECT i.thread_id, FALSE FROM issue_votes v JOIN issues i ON i.id = v.issue_id
               WHERE v.user_id = ${viewer} AND i.thread_id IS NOT NULL
    UNION ALL SELECT thread_id, FALSE FROM chat_messages
               WHERE user_id = ${viewer} AND thread_id IS NOT NULL AND msg_type = 'message' AND deleted_at IS NULL
    UNION ALL SELECT thread_id, TRUE FROM thread_followers WHERE user_id = ${viewer} AND muted_at IS NULL
  ) why GROUP BY thread_id`;
}

// $1 viewer, $2 show self-hosted, $3 admin, $4 the most rows of each kind,
// $5 days a closed thread stays listed (Live this week).
//
// THE MOST ROWS (30 Oct 2026). Up to $4 threads with a merged change (Live
// this week, Going live) and, apart, up to $4 of the rest, their own before
// those they only voted or wrote in. With one budget for both, newest first,
// a week of changes going live filled it and every request of the viewer's
// older than about a day was never read: a plan waiting for their Build it
// and requests nobody was building were on neither list while Main named
// them. Nor are threads read that standing() can never list: closed with
// nothing merged, live more than $5 days ago, or merged and not live yet in
// a thread that is not theirs.
const THREADS_SQL = `
WITH mine AS (${threadsInSql('$1')})
SELECT * FROM (
SELECT t.id, mine.own, t.number, t.kind, t.title AS thread_title, t.state, t.created_at, t.closed_at,
       a.slug, a.name, a.icon_emoji, a.icon_image_id,
       req.title AS request_title, req.state AS request_state, req.updated_at AS request_at,
       ch.id AS change_id, ch.pr_number, ch.status AS change_status, ch.user_id AS change_user,
       ch.title AS change_title, ch.promoted_at, ch.merged_at, ch.live_at, ch.last_activity_at,
       ch.voted, ch.my_vote, ch.by_agent,
       dec.status AS decision_status, dec.mine AS decision_mine, dec.my_vote AS decision_vote,
       COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, ch.last_activity_at, req.updated_at, t.created_at) AS sort_at,
       ROW_NUMBER() OVER (
         PARTITION BY COALESCE(ch.status = 'merged', FALSE)
         ORDER BY mine.own DESC,
                  COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, ch.last_activity_at, req.updated_at, t.created_at) DESC
       ) AS place
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
  JOIN apps a ON a.id = t.app_id
  LEFT JOIN app_collaborators me ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
  LEFT JOIN LATERAL (
    SELECT r.title, r.state, r.updated_at FROM requests r
     WHERE r.thread_id = t.id
     ORDER BY (r.number = t.number) DESC, r.number
     LIMIT 1
  ) req ON TRUE
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.pr_number, cs.status, cs.user_id, cs.promoted_at, cs.merged_at, cs.live_at,
           cs.last_activity_at,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
           EXISTS (SELECT 1 FROM pr_votes v
                    WHERE v.session_id = cs.id AND v.user_id = $1
                      AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch) AS voted,
           (SELECT v.vote FROM pr_votes v
             WHERE v.session_id = cs.id AND v.user_id = $1
               AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch
             LIMIT 1) AS my_vote,
           (cs.external_agent IS NOT NULL) AS by_agent
      FROM chat_sessions cs
     WHERE cs.thread_id = t.id AND cs.is_headless = FALSE
       AND cs.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       AND (cs.status NOT IN ('active', 'paused') OR cs.shared_at IS NOT NULL OR cs.user_id = $1)
     ORDER BY CASE cs.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END,
              cs.id DESC
     LIMIT 1
  ) ch ON TRUE
  -- A decision's group vote (a rename, a card picture, ...): whether it is
  -- still open, and whether the viewer filed it or has voted on it, so the
  -- row says it waits for votes, or leaves it to the Needs you feed when the
  -- viewer's own vote is owed (OWED_GOVERNANCE_WHERE).
  LEFT JOIN LATERAL (
    SELECT i.status, (i.created_by = $1) AS mine,
           (SELECT v.vote FROM issue_votes v WHERE v.issue_id = i.id AND v.user_id = $1 LIMIT 1) AS my_vote
      FROM issues i
     WHERE t.kind = 'decision' AND i.thread_id = t.id
     ORDER BY i.id DESC
     LIMIT 1
  ) dec ON TRUE
 WHERE t.merged_into IS NULL
   AND (t.state = 'open' OR (t.closed_at > NOW() - make_interval(days => $5) AND ch.status = 'merged'))
   AND (ch.status IS DISTINCT FROM 'merged'
        OR ch.live_at > NOW() - make_interval(days => $5)
        OR (ch.live_at IS NULL AND (mine.own OR ch.user_id = $1)))
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)
   -- A change in flight in a thread they only voted or wrote in is never
   -- listed (standing), so it is not read either: somebody who votes on
   -- everything filled the most rows with those, and their own requests
   -- further down were cut off before they could be listed.
   AND (mine.own OR ch.status IS NULL OR ch.status = 'merged' OR ch.user_id = $1)
   AND ${VISIBLE_APP_WHERE}
) listed
 WHERE place <= $4
 ORDER BY sort_at DESC`;

// $1 viewer, $2 the bot, $3 the most rows. A thread they started is one of
// their own messages in the chat with the bot that has replies; a draft the
// bot opened is a row of private_threads. Only those still open: a filed or
// posted one is a public thread now, and listed there.
const PRIVATE_SQL = `
SELECT m.id AS root_id, m.content, m.created_at, p.kind, a.slug, a.name,
       a.icon_emoji, a.icon_image_id,
       (SELECT MAX(r.created_at) FROM conversation_messages r
         WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL) AS last_at
  FROM conversations c
  JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
  JOIN conversation_members bot ON bot.conversation_id = c.id AND bot.user_id = $2
  JOIN conversation_messages m ON m.conversation_id = c.id AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
  LEFT JOIN private_threads p ON p.root_message_id = m.id AND p.user_id = $1
  LEFT JOIN apps a ON a.id = p.app_id AND a.moderation_suspended_at IS NULL
 WHERE c.kind = 'direct'
   AND (p.id IS NOT NULL
        OR (m.sender_id = $1 AND EXISTS (SELECT 1 FROM conversation_messages r
                                          WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL)))
   AND COALESCE(p.state, 'open') = 'open'
 ORDER BY COALESCE((SELECT MAX(r.created_at) FROM conversation_messages r
                     WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL), m.created_at) DESC
 LIMIT $3`;

// The project as the Needs you feed names it (routes/workshop-overview.js),
// so one tile draws both (features/apps/app-card-view.tsx AppIconContent).
function appOf(row) {
  if (!row.slug) return null;
  return {
    slug: row.slug,
    name: row.name || row.slug,
    icon_url: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
    icon_emoji: row.icon_emoji || null,
  };
}

// The page a thread opens on: its request's, else its change's, else the
// project's Workshop (a decision filed as a governance row has no number).
function hrefOf(row) {
  const slug = encodeURIComponent(row.slug);
  if (row.number != null && row.request_title != null) return `#app/${slug}/dev/issues/${Number(row.number)}`;
  if (row.pr_number != null) return `#app/${slug}/dev/changes/${Number(row.pr_number)}`;
  return `#app/${slug}/workshop`;
}

function firstLine(text, max = 90) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const iso = (at) => (at ? new Date(at).toISOString() : null);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where Homeroom bot's stage for a request it works on puts it
 * (homeroom-bot-progress.js stageOf), or undefined where the request's
 * change says it as well (its tests, its vote, its merge). Null: listed
 * elsewhere already, as the bot's question is (the Needs you feed's Answer).
 */
const BOT_STANDING = Object.freeze({
  question: null,
  plan: { group: 'needs', what: 'plan' },
  reading: { group: 'next', what: 'reading' },
  starting: { group: 'next', what: 'building', by: 'bot' },
  planning: { group: 'next', what: 'building', by: 'bot' },
  building: { group: 'next', what: 'building', by: 'bot' },
  reviewing: { group: 'next', what: 'building', by: 'bot' },
  proposing: { group: 'next', what: 'building', by: 'bot' },
  fixing: { group: 'next', what: 'fixing' },
  revising: { group: 'next', what: 'revising' },
  queued: { group: 'waiting', what: 'queued' },
  on_hold: { group: 'waiting', what: 'on_hold' },
  build_queued: { group: 'waiting', what: 'build_queued' },
  held: { group: 'waiting', what: 'held' },
  stalled: { group: 'waiting', what: 'stalled' },
  fix_queued: { group: 'waiting', what: 'fix_queued' },
  followup_queued: { group: 'waiting', what: 'followup_queued' },
});

/** Pure: a held build's reason, in the two the bot words apart (stageOf). */
function heldBy(capSuppressed) {
  return capSuppressed === 'proposals_per_app' || capSuppressed === 'proposals_total' ? 'approvals' : 'daily';
}

/**
 * Pure: where one thread stands for the viewer, or null when it is not
 * theirs to see in these lists (a vote they owe is Needs you's; a change
 * live more than a week ago is history; one in flight that they only voted
 * or wrote in asks nothing more of them). `now` is a Date; `botId` is
 * Homeroom bot's account, so a change it is making says so. `bot` is the
 * bot's stage for the thread's request when it works on it for them
 * (`{ stage, since, capSuppressed }`, botStages), which wins.
 */
function standing(row, viewerId, now = new Date(), botId = null, bot = null) {
  const status = row.change_status || null;
  const theirs = row.change_user != null && Number(row.change_user) === Number(viewerId);
  // In progress is their own work: asked for, built, or followed.
  const own = row.own === true || theirs;
  if (status === 'merged') {
    if (!row.live_at) return own ? { group: 'next', what: 'going_live', at: iso(row.merged_at) } : null;
    if (now - new Date(row.live_at) <= LIVE_DAYS * DAY_MS) return { group: 'live', what: 'live', at: iso(row.live_at) };
    return null;
  }
  if (row.state !== 'open') return null;
  const said = bot && Object.prototype.hasOwnProperty.call(BOT_STANDING, bot.stage) ? BOT_STANDING[bot.stage] : undefined;
  if (said === null) return null;
  if (said) {
    return {
      ...said,
      at: iso(bot.since || row.last_activity_at || row.request_at || row.created_at),
      ...(said.what === 'held' ? { heldBy: heldBy(bot.capSuppressed) } : {}),
    };
  }
  if (status === 'merging') return own ? { group: 'next', what: 'merging', at: iso(row.merged_at || row.promoted_at) } : null;
  if (status === 'promoted') {
    // Owed by everyone but its author, and by its author too when a coding
    // agent submitted it for them: their yes is a tap (governance-rules.ts).
    if (!row.voted && (!theirs || row.by_agent)) return null;
    if (!own) return null;
    // Waiting on other people's votes: Up next, not In progress.
    const myVote = row.my_vote === 'yes' || row.my_vote === 'no' ? row.my_vote : null;
    return { group: 'waiting', what: 'vote', at: iso(row.promoted_at), myVote };
  }
  if (status === 'active' || status === 'paused') {
    if (!own) return null;
    const bot = botId != null && row.change_user != null && Number(row.change_user) === Number(botId);
    return { group: 'next', what: 'building', at: iso(row.last_activity_at), by: bot ? 'bot' : theirs ? 'you' : 'someone' };
  }
  // A decision up for the group's vote (a rename, a card picture, ...) has
  // nothing to build: it waits for votes, as a change up for one does. Not
  // "Nobody is building it yet", which it said before (30 Oct 2026).
  if (row.kind === 'decision' && row.decision_status != null) {
    if (row.decision_status !== 'open' || !own) return null;
    const myVote = row.decision_vote === 'yes' || row.decision_vote === 'no' ? row.decision_vote : null;
    // Their vote still owed: the Needs you feed's, as a change's is.
    if (!myVote && row.decision_mine !== true) return null;
    return { group: 'waiting', what: 'decision', at: iso(row.created_at), myVote };
  }
  if (row.request_state === 'open' || row.kind === 'decision') {
    const at = row.request_at || row.created_at;
    const quiet = at ? Math.floor((now - new Date(at)) / DAY_MS) : 0;
    return { group: 'waiting', what: 'not_picked_up', at: iso(at), quietDays: quiet >= 7 ? quiet : 0 };
  }
  return null;
}

// In progress is soonest first: going live, then merging, then a change
// being fixed or followed up, then made, then a request being read.
const NEXT_ORDER = { going_live: 0, merging: 1, fixing: 2, revising: 2, building: 3, reading: 4 };
// Up next is the nearest to live first: a vote (the oldest has waited
// longest), a follow-up waiting its turn, a build waiting its turn or held
// back, a request waiting to be read, then one nobody has picked up.
const WAITING_ORDER = {
  vote: 0, decision: 0, fix_queued: 1, followup_queued: 1, build_queued: 2, held: 3, stalled: 3, queued: 4, on_hold: 5, not_picked_up: 6,
};

/** The key a thread's request is matched to the bot's stage by. */
const botKey = (slug, number) => `${slug}#${Number(number)}`;

function shapeThread(row, viewerId, now, botId, bots) {
  const bot = bots && row.slug && row.number != null ? bots.get(botKey(row.slug, row.number)) || null : null;
  const stand = standing(row, viewerId, now, botId, bot);
  if (!stand) return null;
  // A change's own thread with no number (its PR number is a request's) is
  // named by its change.
  const number = row.number != null ? Number(row.number) : row.pr_number != null ? Number(row.pr_number) : null;
  const title = row.request_title || row.change_title || row.thread_title || null;
  return {
    threadId: Number(row.id),
    number,
    kind: row.kind,
    title,
    app: appOf(row),
    change: row.change_id ? { id: Number(row.change_id), number: row.pr_number == null ? null : Number(row.pr_number) } : null,
    href: hrefOf(row),
    ...stand,
  };
}

/**
 * Pure: the lists, in the order the view draws them. `bots` maps a request
 * (botKey) to Homeroom bot's stage for it (botStages).
 */
function arrange(rows, viewerId, now = new Date(), botId = null, bots = null) {
  const shaped = rows.map((row) => shapeThread(row, viewerId, now, botId, bots)).filter(Boolean);
  const byAt = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  const oldest = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
  const next = shaped.filter((s) => s.group === 'next')
    .sort((a, b) => (NEXT_ORDER[a.what] - NEXT_ORDER[b.what]) || oldest(a, b));
  const waiting = shaped.filter((s) => s.group === 'waiting')
    .sort((a, b) => (WAITING_ORDER[a.what] - WAITING_ORDER[b.what])
      || (a.what === 'not_picked_up' ? byAt(a, b) : oldest(a, b)));
  return {
    needs: shaped.filter((s) => s.group === 'needs').sort(byAt),
    next,
    waiting,
    live: shaped.filter((s) => s.group === 'live').sort(byAt),
  };
}

/**
 * Homeroom bot's stage for each request it works on for `user`
 * (homeroom-bot-progress.js requestStates: the records its answer in Main
 * reads), by botKey. Empty while it is switched off, on a staging copy
 * (which never acts, so its queue is nobody's work), and when the read
 * fails: the lists then say what the requests and changes say.
 */
async function botStages(pool, user, deps = {}) {
  const stages = new Map();
  try {
    const live = deps.liveSvc || require('./homeroom-bot-live');
    if (live.isStaging()) return stages;
    const settings = deps.settings !== undefined
      ? deps.settings
      : await (deps.botSvc || require('./homeroom-bot')).readSettings(pool);
    if (!settings || settings.mode === 'off') return stages;
    const progress = deps.progress || require('./homeroom-bot-progress');
    for (const { row, state } of await progress.requestStates(pool, { userId: user.id, settings })) {
      if (!state || row.first_version || !row.slug || row.issue_number == null) continue;
      stages.set(botKey(row.slug, row.issue_number), {
        stage: state.stage, since: state.since || null, capSuppressed: row.cap_suppressed || null,
      });
    }
  } catch (err) {
    log.warn('ai-work', 'Could not read Homeroom bot\'s stages', { message: err.message });
  }
  return stages;
}

function shapePrivate(row) {
  return {
    rootId: Number(row.root_id),
    title: firstLine(row.content),
    kind: row.kind || 'idea',
    app: appOf(row),
    at: iso(row.last_at || row.created_at),
  };
}

/**
 * Everything the AI tab's main view lists for `user` beside the Needs you
 * feed: { private, needs, next, waiting, live }.
 */
async function workFor(pool, { user, showSelfHosted = false, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot || await dm.botAccount(pool);
  const [{ rows: threadRows }, privateRows, bots] = await Promise.all([
    pool.query(THREADS_SQL, [user.id, !!showSelfHosted, !!user.isAdmin, THREADS_MAX, LIVE_DAYS]),
    bot ? pool.query(PRIVATE_SQL, [user.id, bot.id, PRIVATE_MAX]).then((r) => r.rows) : Promise.resolve([]),
    botStages(pool, user, deps),
  ]);
  return {
    private: privateRows.map(shapePrivate),
    ...arrange(threadRows, user.id, new Date(), bot ? bot.id : null, bots),
  };
}

module.exports = {
  THREADS_SQL,
  PRIVATE_SQL,
  threadsInSql,
  THREADS_MAX,
  PRIVATE_MAX,
  LIVE_DAYS,
  BOT_STANDING,
  standing,
  arrange,
  botStages,
  workFor,
};
