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
//                       it, or a request of theirs it handed back, for a
//                       person to decide or with a build that stopped
//                       (the feed carries no such card);
//              next     In progress: one of THEIRS (they asked for it, built
//                       it, or chose Notify me) being worked on: Homeroom bot
//                       reading it, a change being made or fixed, somebody
//                       who pressed Claim on it, merging, or merged and
//                       going live;
//              waiting  Waiting: one of theirs waiting on someone else: up
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
const repoRef = require('./repo-ref');
const { planWaitingSql, updateComingSql, updateAskSql } = require('./homeroom-bot-progress');

const THREADS_MAX = 80;
const PRIVATE_MAX = 30;
const LIVE_DAYS = 7;
// How long a claim holds, as the bot reads one (homeroom-bot.js CLAIM_TTL_DAYS).
const CLAIM_DAYS = 7;

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
    -- A request they pressed Claim on this week is theirs to build, as the
    -- Workshop counted it (AppView._issueIsMine), even with no change yet.
    UNION ALL SELECT t.id, TRUE FROM issue_claims ic
                JOIN threads t ON t.app_id = ic.app_id AND t.number = ic.github_issue_number
               WHERE ic.user_id = ${viewer} AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
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
SELECT t.id, t.app_id, mine.own, t.number, t.kind, t.title AS thread_title, t.state, t.created_at, t.closed_at,
       a.slug, a.name, a.icon_emoji, a.icon_image_id, a.repo_url,
       req.id AS request_id, req.title AS request_title, req.state AS request_state, req.updated_at AS request_at,
       ch.id AS change_id, ch.pr_number, ch.status AS change_status, ch.user_id AS change_user,
       ch.title AS change_title, ch.promoted_at, ch.merged_at, ch.live_at, ch.last_activity_at,
       ch.voted, ch.my_vote, ch.by_agent, ch.check_state, ch.needs_fix,
       -- #6282: an update on its way holds the vote the change would ask for.
       ch.update_coming, ch.update_ask,
       dec.id AS decision_id, dec.status AS decision_status, dec.mine AS decision_mine, dec.my_vote AS decision_vote,
       cl.username AS claimed_by, cl.mine AS claimed_mine,
       COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, req.updated_at, t.created_at) AS sort_at,
       -- 1 Nov 2026: their own private thread about its request holds the
       -- bot: it waits for their plan (rules/bot-loop.ts planHoldActiveSql).
       (t.number IS NOT NULL AND EXISTS (
          SELECT 1 FROM private_threads p
           WHERE p.app_id = t.app_id AND p.about_number = t.number AND p.user_id = $1
             AND ${require('../workflow/rules/bot-loop.ts').planHoldActiveSql('p')})) AS awaiting_plan,
       ROW_NUMBER() OVER (
         PARTITION BY COALESCE(ch.status = 'merged', FALSE)
         ORDER BY mine.own DESC,
                  COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, req.updated_at, t.created_at) DESC
       ) AS place
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
  JOIN apps a ON a.id = t.app_id
  LEFT JOIN app_collaborators me ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
  LEFT JOIN LATERAL (
    SELECT r.id, r.title, r.state, r.updated_at FROM requests r
     WHERE r.thread_id = t.id
     ORDER BY (r.number = t.number) DESC, r.number
     LIMIT 1
  ) req ON TRUE
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.pr_number, cs.status, cs.user_id, cs.promoted_at, cs.merged_at, cs.live_at,
           cs.last_activity_at, cs.check_state,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
           EXISTS (SELECT 1 FROM pr_votes v
                    WHERE v.session_id = cs.id AND v.user_id = $1
                      AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch) AS voted,
           (SELECT v.vote FROM pr_votes v
             WHERE v.session_id = cs.id AND v.user_id = $1
               AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch
             LIMIT 1) AS my_vote,
           (cs.external_agent IS NOT NULL) AS by_agent,
           -- Waits on its author for a fix, as the Workshop's Waiting on you
           -- read it (AppView._workshopNeedsFix): its checks failed, its
           -- preview did not build, or a merge attempt hit a conflict that
           -- a person has to resolve. Not a checks run the platform could
           -- not finish: that is nobody's to fix.
           (cs.check_state = 'failing'
            OR (cs.staging_url IS NULL AND cs.check_state = 'error' AND cs.check_error_detail IS NOT NULL)
            OR cs.merge_conflict_state = 'failed') AS needs_fix,
           -- #6282: 'running' while a turn updates it, 'queued' while an
           -- ask waits its turn, and what was asked, for the row's words.
           ${updateComingSql('cs')} AS update_coming,
           ${updateAskSql('cs')} AS update_ask
      FROM chat_sessions cs
     WHERE cs.thread_id = t.id AND cs.is_headless = FALSE
       -- A posted plan is no change (threads.js ITEMS_SQL says the same).
       AND NOT (cs.source IS NOT DISTINCT FROM 'request_spec' AND cs.branch_name IS NULL)
       AND cs.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       AND (cs.status NOT IN ('active', 'paused') OR cs.shared_at IS NOT NULL OR cs.user_id = $1)
     ORDER BY CASE cs.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END,
              cs.id DESC
     LIMIT 1
  ) ch ON TRUE
  -- A decision's group vote (a rename, a card picture, ...): whether it is
  -- still open, and whether the viewer filed it or has voted on it, so the
  -- row says it waits for votes, or leaves it to the Needs you feed when the
  -- viewer's own vote is owed (OWED_GOVERNANCE_WHERE). Its id is the
  -- address of its page (hrefOf).
  LEFT JOIN LATERAL (
    SELECT i.id, i.status, (i.created_by = $1) AS mine,
           (SELECT v.vote FROM issue_votes v WHERE v.issue_id = i.id AND v.user_id = $1 LIMIT 1) AS my_vote
      FROM issues i
     WHERE t.kind = 'decision' AND i.thread_id = t.id
     ORDER BY i.id DESC
     LIMIT 1
  ) dec ON TRUE
  -- Somebody pressed Claim on its request (issue_claims) this week, the
  -- bot's own reading of a live claim (homeroom-bot.js CLAIM_TTL_DAYS): who,
  -- so a request being built with no change up yet says who has it rather
  -- than "Nobody is building it yet".
  LEFT JOIN LATERAL (
    SELECT u.username, (ic.user_id = $1) AS mine
      FROM issue_claims ic JOIN users u ON u.id = ic.user_id
     WHERE t.number IS NOT NULL AND ic.app_id = t.app_id AND ic.github_issue_number = t.number
       AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
       AND u.is_synthetic IS NOT TRUE
     ORDER BY ic.claimed_at DESC
     LIMIT 1
  ) cl ON TRUE
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

// $1 viewer, $2 the bot, $3 the most rows, $4 days a done thread stays
// listed. A thread they started is one of their own messages in the chat
// with the bot that has replies; a draft the bot opened is a row of
// private_threads. Every private thread is listed except a done one (#6250,
// 4 Nov 2026: a filed, posted or dropped thread stays, so the way in is
// always the list, never Main Chat). #6153: with where it went (its state and
// the request's number), so the tab draws a filed or posted thread as that
// request's row rather than a second one when a row names it (model.ts
// needsYou). #6271: a done thread stays listed for $4 days after it was
// closed, where Live this week shows it.
const PRIVATE_SQL = `
SELECT m.id AS root_id, m.content, m.created_at, p.kind, p.state, p.result_ref, p.done_at, a.slug, a.name,
       a.icon_emoji, a.icon_image_id, a.repo_url,
       -- A thread started from the bot's "+" is named by their first words in it.
       (SELECT f.content FROM conversation_messages f
         WHERE f.thread_root_id = m.id AND f.sender_id = $1 AND f.deleted_at IS NULL
         ORDER BY f.id LIMIT 1) AS first_own,
       -- 1 Nov 2026 (C1): a thread about a request or a change is named by
       -- it ("#18 Dark mode"), and one holding a design by its screen.
       p.about_kind, p.about_number,
       COALESCE((SELECT rq.title FROM requests rq
                  WHERE p.about_kind = 'request' AND rq.app_id = p.app_id AND rq.number = p.about_number),
                m.metadata->'homeroomBot'->>'aboutTitle') AS about_title,
       (SELECT d.title FROM design_threads d WHERE d.private_thread_id = p.id) AS design_title,
       -- B08, B19 (audit 2 Nov 2026): a new project's thread is named by its
       -- idea, never by the person's latest words in it, and a draft's by
       -- what it drafts, never by the bot's line that opened it.
       m.metadata->'homeroomBot'->>'projectIdea' AS project_idea,
       m.metadata->'homeroomBot'->>'draftTitle' AS draft_title,
       (SELECT MAX(r.created_at) FROM conversation_messages r
         WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL) AS last_at,
       -- Filed (or posted) as a request that has finished: live for longer
       -- than Live this week keeps it, or closed with nothing merged. It is
       -- History's then (services/ai-history.js reads it by the same rule),
       -- not a Needs you row with nothing left to do.
       (p.state IN ('filed', 'posted') AND p.result_ref > 0 AND (
          EXISTS (SELECT 1 FROM chat_sessions cs
                   WHERE cs.app_id = p.app_id AND p.result_ref = ANY(cs.linked_issues) AND cs.status = 'merged'
                     AND cs.live_at <= NOW() - make_interval(days => $4))
          OR EXISTS (SELECT 1 FROM requests r
                      WHERE r.app_id = p.app_id AND r.number = p.result_ref AND r.state = 'closed'
                        AND NOT EXISTS (SELECT 1 FROM chat_sessions m
                                         WHERE m.app_id = r.app_id AND r.number = ANY(m.linked_issues) AND m.status = 'merged')))) AS result_done
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
   -- #6250: filed, posted and dropped threads stay listed. #6271: a done
   -- thread is finished, but stays findable for $4 days under Live this week
   -- (unless reopened).
   AND (COALESCE(p.state, 'open') <> 'done'
        OR p.done_at >= NOW() - make_interval(days => $4))
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
    // Where a change's number comes from: GitHub's own counter there, so a
    // change reads "PR 12"; Homeroom's git host shares one counter, so "#12".
    // The address itself does not ride along.
    changesOnGithub: repoRef.isGithub(row.repo_url),
  };
}

// The page a thread opens on: its request's, else its change's, else a
// decision's own page (1 Nov 2026: a Waiting row for a decision went to the
// project's Workshop, where the person had to find it), else the Workshop.
function hrefOf(row) {
  const slug = encodeURIComponent(row.slug);
  if (row.number != null && row.request_title != null) return `#app/${slug}/dev/issues/${Number(row.number)}`;
  if (row.pr_number != null) return `#app/${slug}/dev/changes/${Number(row.pr_number)}`;
  if (row.kind === 'decision' && row.decision_id != null) return `#app/${slug}/dev/governance/${Number(row.decision_id)}`;
  return `#app/${slug}/workshop`;
}

function firstLine(text, max = 90) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// #6306: the bot's first whole sentence, cut at `max` with "…" when it does
// not fit. The row says what it found in one sentence; the page keeps all.
function firstSentence(text, max = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0];
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

// #6282: one ask, as the row's one line of words: 80 characters at most,
// ending in "…" when cut (the way the bot's own lines are shortened,
// homeroom-bot-voice.js clip). Whitespace folds, so a tooltip stays one line.
function clip(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
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
  // Handed back to them (homeroom-bot-progress.js handedBack): nothing moves
  // until somebody decides, or asks it to try the build again.
  decide: { group: 'needs', what: 'decide' },
  // #6306: the ask is already there, so nothing is left to build: the row
  // offers Propose to close, never reads as a decision.
  already_works: { group: 'needs', what: 'already_works' },
  build_stopped: { group: 'needs', what: 'build_stopped' },
  // #6284: the bot stopped at its own limit on failing checks; somebody may
  // let it try once more.
  fix_stopped: { group: 'needs', what: 'fix_stopped' },
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

/**
 * Pure: a held build's reason, in the two the bot words apart (stageOf):
 * its turn among the project's builds (#6156: votes do not free that one),
 * or changes waiting for approval. 3 Nov 2026: there is no day's limit any
 * more, so every other hold waits for approvals.
 */
function heldBy(capSuppressed) {
  return capSuppressed === 'builds_per_app' ? 'turn' : 'approvals';
}

/**
 * Pure: where one thread stands for the viewer, or null when it is not
 * theirs to see in these lists (a vote they owe is Needs you's; a change
 * live more than a week ago is history; one in flight that they only voted
 * or wrote in asks nothing more of them). `now` is a Date; `botId` is
 * Homeroom bot's account, so a change it is making says so. `bot` is the
 * bot's stage for the thread's request when it works on it for them
 * (`{ stage, since, capSuppressed }`, botStages), which wins. `facts` is
 * what the bot's own records say of the request (requestFacts): its newest
 * live run, its queue place, its labels and whether the viewer decides on
 * its project.
 */
function standing(row, viewerId, now = new Date(), botId = null, bot = null, facts = null) {
  const status = row.change_status || null;
  const theirs = row.change_user != null && Number(row.change_user) === Number(viewerId);
  // In progress is their own work: asked for, built, or followed.
  const own = row.own === true || theirs;
  if (status === 'merged') {
    if (!row.live_at) return own ? { group: 'next', what: 'going_live', at: iso(row.merged_at) } : null;
    if (now - new Date(row.live_at) <= LIVE_DAYS * DAY_MS) {
      // #6233: merged_at and the change's id let the tab compare the change
      // with the build it loaded (the "reload to get it" wording).
      return { group: 'live', what: 'live', at: iso(row.live_at),
        mergedAt: iso(row.merged_at), changeId: Number(row.change_id) || null };
    }
    return null;
  }
  if (row.state !== 'open') return null;
  let said = bot && Object.prototype.hasOwnProperty.call(BOT_STANDING, bot.stage) ? BOT_STANDING[bot.stage] : undefined;
  // #6228: a read the bot started after somebody replied is reading that
  // reply, not the request again.
  if (said && bot.stage === 'reading' && bot.reply === true) said = { group: 'next', what: 'reading_reply' };
  // #6313: a read queued again after a plan that could not be written is
  // retrying the plan, not waiting for a free builder as if nothing happened.
  if (said && said.what === 'queued' && bot.retry === 'plan') said = { group: 'waiting', what: 'retrying_plan' };
  // 1 Nov 2026: Homeroom bot waits for their plan, which nothing it is
  // queued for overtakes: Waiting for your plan, until a change is up.
  if (row.awaiting_plan === true && !status && row.request_state === 'open' && (!said || said.group === 'waiting')) {
    return { group: 'waiting', what: 'awaiting_plan', at: iso(row.request_at || row.created_at) };
  }
  if (said === null) return null;
  // Handed back, and somebody has taken it up since (a change of theirs, or
  // a claim): that is where it stands now.
  if (said && (said.what === 'decide' || said.what === 'already_works' || said.what === 'build_stopped')
      && (status || row.claimed_by)) said = undefined;
  // #6282 (4 Nov 2026): an update on its way holds the vote. While a turn
  // runs on the change, or the bot holds an ask it took, the row reads
  // Updating; while an ask waits its turn, Update queued. It is listed for
  // the people who would have been asked to vote on it and for its own
  // people; somebody who already voted and only wrote in it still gets no
  // row. Any more particular stage of the bot's (fixing, fix_queued,
  // merging) still wins.
  const updateHeld = !said || said.what === 'revising' || said.what === 'followup_queued';
  if (status === 'promoted' && row.update_coming && updateHeld
      && (own || (!row.voted && (!theirs || row.by_agent)))) {
    const ask = row.update_ask ? clip(row.update_ask) : null;
    const at = iso((bot && bot.since) || row.last_activity_at || row.promoted_at);
    return row.update_coming === 'running'
      ? { group: 'next', what: 'updating', at, ...(ask ? { ask } : {}) }
      : { group: 'waiting', what: 'update_queued', at, ...(ask ? { ask } : {}) };
  }
  if (said) {
    // #6158: a queued or held build also says its place in line.
    const place = facts && said.what === 'queued' ? facts.queuePlace
      : facts && said.what === 'held' ? facts.heldPlace : null;
    // #6245: what the bot handed you is timed from when it began waiting on
    // you, not from the last thing that touched the change or its page.
    const at = iso(said.group === 'needs'
      ? (bot.since || row.request_at || row.created_at)
      : (bot.since || row.last_activity_at || row.request_at || row.created_at));
    return {
      ...said,
      at,
      ...(said.what === 'held' ? { heldBy: heldBy(bot.capSuppressed) } : {}),
      ...(place ? { place } : {}),
      // #6306: an already-done hand-back says why in the bot's own sentence.
      ...(said.what === 'already_works' && bot.reason ? { reason: bot.reason } : {}),
    };
  }
  if (status === 'merging') return own ? { group: 'next', what: 'merging', at: iso(row.merged_at || row.promoted_at) } : null;
  if (status === 'promoted') {
    // Owed by everyone but its author, and by its author too when a coding
    // agent submitted it for them: their yes is a tap (governance-rules.ts).
    if (!row.voted && (!theirs || row.by_agent)) return null;
    if (!own) return null;
    // Their own change (not Homeroom bot's, whose fixes are its own) that
    // waits on them: checks that failed, a preview that did not build, a
    // conflict to resolve. Needs you, with Fix it, not "Waiting for checks",
    // which it would wait on forever.
    if (theirs && row.needs_fix === true) {
      return { group: 'needs', what: 'fix_yours', at: iso(row.last_activity_at || row.promoted_at) };
    }
    // Checks that have not passed hold it: a vote cannot merge it yet, so the
    // row names the checks, not the votes (#6060).
    if (row.check_state !== 'passing' && row.check_state !== 'skipped') {
      return { group: 'waiting', what: 'checking', at: iso(row.promoted_at) };
    }
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
  // Claimed, with no change up yet: being built, by whoever pressed Claim.
  if (row.request_state === 'open' && row.claimed_by) {
    if (!own) return null;
    const at = iso(row.request_at || row.created_at);
    return row.claimed_mine === true
      ? { group: 'next', what: 'building', at, by: 'you' }
      : { group: 'next', what: 'building', at, by: 'someone', claimedBy: row.claimed_by };
  }
  if (row.request_state === 'open' || row.kind === 'decision') {
    const at = row.request_at || row.created_at;
    const quiet = at ? Math.floor((now - new Date(at)) / DAY_MS) : 0;
    const quietDays = quiet >= 7 ? quiet : 0;
    // #6158: what the request waits on, from the bot's own records, whoever
    // the request was filed by (botStages only covers the bot's requesters).
    const f = facts && row.number != null ? facts : null;
    if (f) {
      const base = { at: iso(at), quietDays };
      // #6246: a plan waiting for Build it is Needs you's, whatever else the
      // request has beside it: a reply, a held queue row or an older question.
      if (f.planWaits) return { group: 'needs', what: 'plan', at: iso(f.planAt), quietDays };
      // #6228: a person replied on a request the bot handed back, and the
      // bot has it to read: it leaves Needs you at once, not when the read
      // starts.
      if (f.replyWaits && f.handedBack) return { group: 'next', what: 'reading_reply', ...base };
      // In Homeroom bot's line on its project.
      if (f.queuePlace) return { group: 'waiting', what: 'queued', ...base, place: f.queuePlace };
      // Read and ready, but a limit on the project holds the build.
      if (f.run && f.run.held) {
        return { group: 'waiting', what: 'held', ...base, heldBy: heldBy(f.run.capSuppressed), ...(f.heldPlace ? { place: f.heldPlace } : {}) };
      }
      const reason = f.run ? firstLine(f.run.reason, 140) || null : null;
      // #6306: already there. The requester (and the project's deciders) are
      // offered to close it; anyone else waits on that, and it never reads
      // as a decision.
      if (f.run && (f.run.verdict === 'person' || f.run.verdict === 'empty') && f.run.alreadyDone) {
        return f.viewerDecides
          ? { group: 'needs', what: 'already_works', ...base, ...(reason ? { reason } : {}) }
          : { group: 'waiting', what: 'needs_person', ...base, ...(reason ? { reason } : {}) };
      }
      // Handed back: the requester's (and the project's deciders') to
      // decide, anyone else's to wait on.
      if (f.run && f.run.verdict === 'person') {
        return f.viewerDecides
          ? { group: 'needs', what: 'decide', ...base, ...(reason ? { reason } : {}) }
          : { group: 'waiting', what: 'needs_person', ...base, ...(reason ? { reason } : {}) };
      }
      if (f.run && f.run.verdict === 'empty') {
        return { group: 'waiting', what: 'nothing_to_build', ...base, ...(reason ? { reason } : {}) };
      }
      const title = row.request_title || row.thread_title || '';
      const labels = Array.isArray(f.labels) ? f.labels : [];
      if (/^operator:/i.test(String(title)) || labels.some((l) => /^(operator|infra)$/i.test(String(l)))) {
        return { group: 'waiting', what: 'operator', ...base };
      }
      if (!f.run) return { group: 'waiting', what: 'not_read', ...base };
    }
    return { group: 'waiting', what: 'not_picked_up', at: iso(at), quietDays };
  }
  return null;
}

// In progress is soonest first: going live, then merging, then a change
// being fixed or followed up, then made, then a request being read.
const NEXT_ORDER = { going_live: 0, merging: 1, fixing: 2, revising: 2, updating: 2, building: 3, reading: 4, reading_reply: 4 };
// Waiting is the nearest to live first: a vote or a change still waiting for
// its checks (the oldest has waited longest), a follow-up waiting its turn, a
// build waiting its turn or held back, a request waiting to be read, then one
// nobody has picked up.
const WAITING_ORDER = {
  awaiting_plan: 0, vote: 0, checking: 0, decision: 0, fix_queued: 1, followup_queued: 1, update_queued: 1, build_queued: 2, held: 3, stalled: 3, queued: 4, retrying_plan: 4, on_hold: 5,
  not_picked_up: 6, needs_person: 6, nothing_to_build: 6, operator: 6, not_read: 6,
};

// #6158: the Waiting rows nobody is moving, which the tab folds under one
// "Not moving" head. They sort last, newest first, as not_picked_up does.
const STILL_WHATS = new Set(['not_picked_up', 'needs_person', 'nothing_to_build', 'operator', 'not_read']);

/** The key a thread's request is matched to the bot's stage by. */
const botKey = (slug, number) => `${slug}#${Number(number)}`;

function shapeThread(row, viewerId, now, botId, bots, facts) {
  const bot = bots && row.slug && row.number != null ? bots.get(botKey(row.slug, row.number)) || null : null;
  const about = facts && row.slug && row.number != null ? facts.get(botKey(row.slug, row.number)) || null : null;
  const stand = standing(row, viewerId, now, botId, bot, about);
  if (!stand) return null;
  // A change's own thread with no number (its PR number is a request's) is
  // named by its change.
  const number = row.number != null ? Number(row.number) : row.pr_number != null ? Number(row.pr_number) : null;
  const title = row.request_title || row.change_title || row.thread_title || null;
  return {
    threadId: Number(row.id),
    number,
    // A thread with a change and no request of its own is led by the change:
    // its number is the PR's, which on GitHub reads "PR 12", never "#12"
    // (frontend/src/features/ai/model.ts changeOnGithub). A change built for
    // a request joins the request's thread and keeps its number.
    kind: row.change_id && row.request_id == null ? 'change' : row.kind,
    title,
    app: appOf(row),
    change: row.change_id ? { id: Number(row.change_id), number: row.pr_number == null ? null : Number(row.pr_number) } : null,
    href: hrefOf(row),
    ...stand,
  };
}

/**
 * Pure: the lists, in the order the view draws them. `bots` maps a request
 * (botKey) to Homeroom bot's stage for it (botStages); `facts` maps it to
 * what the bot's records say of it (requestFacts).
 */
function arrange(rows, viewerId, now = new Date(), botId = null, bots = null, facts = null) {
  const shaped = rows.map((row) => shapeThread(row, viewerId, now, botId, bots, facts)).filter(Boolean);
  const byAt = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  const oldest = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
  const next = shaped.filter((s) => s.group === 'next')
    .sort((a, b) => (NEXT_ORDER[a.what] - NEXT_ORDER[b.what]) || oldest(a, b));
  const waiting = shaped.filter((s) => s.group === 'waiting')
    .sort((a, b) => (WAITING_ORDER[a.what] - WAITING_ORDER[b.what])
      || (STILL_WHATS.has(a.what) ? byAt(a, b) : oldest(a, b)));
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
      // B03 (audit 2 Nov 2026): a project's first version is a request of
      // its creator's like any other here. Left out, one being built read
      // "Waiting · Nobody yet" while Main and its page said "Building it".
      if (!row.slug || row.issue_number == null) continue;
      // Not in progress, but handed back to them: Needs you's (handedBack).
      const stage = state ? state.stage : progress.handedBack(row);
      if (!stage) continue;
      stages.set(botKey(row.slug, row.issue_number), {
        stage, since: (state ? state.since : row.run_at) || null, capSuppressed: row.cap_suppressed || null,
        // #6228: only a read of a reply says so; every other stage keeps the
        // shape it had.
        ...(state && state.reply === true ? { reply: true } : {}),
        // #6313: and only a read queued after a plan that could not be
        // written says it is retrying the plan.
        ...(state && state.retry ? { retry: state.retry } : {}),
        // #6306: a request found already done brings the bot's reason with
        // it, so the row and the page say "Already works: …".
        ...(stage === 'already_works' ? { reason: firstSentence(row.run_reason, 140) || null } : {}),
      });
    }
  } catch (err) {
    log.warn('ai-work', 'Could not read Homeroom bot\'s stages', { message: err.message });
  }
  return stages;
}

// #6158: every thread's request, by the bot's own records, whoever filed it
// and whether or not the bot is switched on here. One row a request:
// its newest live run (verdict, reason, the limit that held it), whether it
// has any run at all, its unstarted queue row and place on its project, its
// place among the project's requests held for a slot, its labels, and
// whether the viewer decides on its project (homeroom-bot.js whoDecides).
// $1 viewer, $2/$3 the requests' app ids and numbers, $4 the window a held
// run still counts in (homeroom-bot.js ABANDONED_LIVE_WINDOW_DAYS).
const FACTS_SQL = `
WITH wanted AS (
  SELECT DISTINCT * FROM UNNEST($2::int[], $3::int[]) AS w(app_id, number)
),
live_run AS (
  SELECT DISTINCT ON (r.app_id, r.issue_number)
         r.app_id, r.issue_number, r.verdict, r.reason, r.already_done, r.cap_suppressed, r.created_at,
         r.build_ok, r.build_error, r.proposal_session_id,
         (r.created_at > NOW() - make_interval(days => $4)) AS fresh
    FROM homeroom_bot_runs r
   WHERE r.mode = 'live'
     AND (r.app_id, r.issue_number) IN (SELECT * FROM UNNEST($2::int[], $3::int[]))
   ORDER BY r.app_id, r.issue_number, r.id DESC
),
held AS (
  SELECT lr.app_id, lr.issue_number,
         ROW_NUMBER() OVER (PARTITION BY lr.app_id ORDER BY lr.created_at ASC, lr.issue_number ASC) AS place
    FROM live_run lr
   WHERE lr.verdict = 'ready' AND lr.fresh
     AND lr.cap_suppressed IN ('proposals_per_app', 'proposals_total', 'builds_per_app')
     AND lr.build_ok IS NULL AND lr.proposal_session_id IS NULL
),
queue AS (
  SELECT q.id, q.app_id, q.issue_number,
         ROW_NUMBER() OVER (PARTITION BY q.app_id ORDER BY q.priority, q.enqueued_at, q.id) AS place
    FROM homeroom_bot_queue q
   WHERE q.started_at IS NULL AND q.app_id = ANY($2::int[])
)
SELECT w.app_id, w.number, a.slug, rq.title, rq.labels,
       lr.verdict AS run_verdict, lr.reason AS run_reason, lr.already_done AS run_already_done,
       lr.cap_suppressed AS run_cap,
       lr.created_at AS run_at, lr.fresh AS run_fresh,
       lr.build_ok AS run_build_ok, lr.build_error AS run_build_error, lr.proposal_session_id AS run_proposal,
       -- #6228: the newest person's reply on the request after that run, and
       -- its queue row whether started or not (replyWaits).
       (SELECT MAX(cm.created_at) FROM chat_messages cm JOIN users ru ON ru.id = cm.user_id
         WHERE cm.app_id = w.app_id AND cm.thread_type = 'issue' AND cm.thread_ref = w.number
           AND cm.msg_type = 'message' AND cm.deleted_at IS NULL AND ru.is_synthetic IS NOT TRUE
           AND lr.created_at IS NOT NULL AND cm.created_at > lr.created_at) AS reply_at,
       qa.started_at AS queue_started, qa.held_until AS queue_held_until,
       -- #6246: a plan of theirs waiting for Build it, from the one fragment
       -- the Workshop reads too (homeroom-bot-progress.js planWaitingSql).
       ${planWaitingSql({ appId: 'w.app_id', issueNumber: 'w.number' })} AS plan_waiting_at,
       EXISTS (SELECT 1 FROM homeroom_bot_requesters br
                WHERE br.app_id = w.app_id AND br.issue_number = w.number
                  AND br.user_id = $1) AS plan_mine,
       EXISTS (SELECT 1 FROM homeroom_bot_runs ar
                WHERE ar.app_id = w.app_id AND ar.issue_number = w.number) AS any_run,
       q.id AS queue_id, q.place AS queue_place, h.place AS held_place,
       (rq.created_by = $1
        OR (a.self_hosted IS NOT TRUE
            AND (a.created_by = $1 OR EXISTS (
              SELECT 1 FROM app_admins aa WHERE aa.app_id = a.id AND aa.user_id = $1)))) AS viewer_decides
  FROM wanted w
  JOIN apps a ON a.id = w.app_id
  LEFT JOIN requests rq ON rq.app_id = w.app_id AND rq.number = w.number
  LEFT JOIN live_run lr ON lr.app_id = w.app_id AND lr.issue_number = w.number
  LEFT JOIN held h ON h.app_id = w.app_id AND h.issue_number = w.number
  LEFT JOIN queue q ON q.app_id = w.app_id AND q.issue_number = w.number
  LEFT JOIN homeroom_bot_queue qa ON qa.app_id = w.app_id AND qa.issue_number = w.number`;

/**
 * #6158: what the bot's records say of each thread's request, by botKey
 * (slug#number): the newest live run, its queue place and its place held for
 * a slot, its labels, and whether the viewer decides on its project. Unlike
 * botStages this is read on staging too (a preview never acts, but its
 * before and after copies must draw these rows). Queue rows count only on
 * projects the bot acts on in production; on staging every project does.
 * Empty on a read error, so the rows fall back to what they said before.
 */
async function requestFacts(pool, rows, viewerId, deps = {}) {
  const facts = new Map();
  const wanted = (rows || []).filter((r) => r.app_id != null && r.number != null && r.slug);
  if (!wanted.length) return facts;
  try {
    const live = deps.liveSvc || require('./homeroom-bot-live');
    const staging = !!live.isStaging();
    // A queue row is the bot's work only on a project it acts on for real.
    let scope = null;
    if (!staging) {
      const settings = deps.settings !== undefined
        ? deps.settings
        : await (deps.botSvc || require('./homeroom-bot')).readSettings(pool);
      if (settings && settings.mode !== 'off' && typeof live.appsScope === 'function') {
        scope = live.appsScope(settings);
        if (scope && typeof live.scopeIsEmpty === 'function' && live.scopeIsEmpty(scope)) scope = null;
        if (scope && typeof live.inScope !== 'function') scope = null;
      }
    }
    const inScope = (slug) => staging || (!!scope && live.inScope(scope, slug));
    const { ABANDONED_LIVE_WINDOW_DAYS } = require('./homeroom-bot');
    const { rows: found } = await pool.query(FACTS_SQL, [
      viewerId,
      wanted.map((r) => Number(r.app_id)),
      wanted.map((r) => Number(r.number)),
      ABANDONED_LIVE_WINDOW_DAYS,
    ]);
    for (const f of found) {
      if (!f.slug || f.number == null) continue;
      const run = f.run_verdict == null ? null : {
        verdict: f.run_verdict,
        reason: f.run_reason || null,
        alreadyDone: f.run_already_done === true,
        capSuppressed: f.run_cap || null,
        createdAt: f.run_at || null,
        buildOk: f.run_build_ok,
        buildError: f.run_build_error || null,
        held: f.run_verdict === 'ready' && f.run_fresh === true
          && !!f.run_cap && f.run_build_ok == null && f.run_proposal == null,
      };
      // #6228: handed back to a person (homeroom-bot-progress.js handedBack),
      // and a reply on it the bot has yet to read (replyWaits).
      const handedBack = !!run && (run.verdict === 'person'
        || (run.verdict === 'ready' && run.buildOk === false
          && !/^(?:skipped|blocked):/.test(String(run.buildError || ''))));
      const waits = !!run && require('./homeroom-bot-progress').replyWaits({
        reply_at: f.reply_at,
        run_at: run.createdAt,
        started_at: f.queue_started,
        queue_id: f.queue_started == null && f.queue_id != null ? f.queue_id : null,
        held_until: f.queue_held_until,
      });
      const scoped = inScope(f.slug);
      const planAt = f.plan_waiting_at || null;
      facts.set(botKey(f.slug, f.number), {
        run,
        anyRun: f.any_run === true,
        // #6246: a plan of theirs waits for Build it (planWaitingSql), the
        // one wait this page and the Workshop read alike.
        planWaits: planAt != null && f.plan_mine === true,
        planAt,
        // #6228: a reply waiting to be read, and whether the run handed the
        // request back (the two sides of the same wait).
        replyWaits: waits,
        handedBack,
        queue: scoped && f.queue_id != null ? { place: Number(f.queue_place) || null } : null,
        queuePlace: scoped && f.queue_id != null ? Number(f.queue_place) || null : null,
        heldPlace: f.held_place == null ? null : Number(f.held_place),
        labels: Array.isArray(f.labels) ? f.labels : [],
        viewerDecides: f.viewer_decides === true,
      });
    }
  } catch (err) {
    log.warn('ai-work', 'Could not read Homeroom bot\'s request facts', { message: err.message });
    return new Map();
  }
  return facts;
}

function shapePrivate(row) {
  // 1 Nov 2026 (C1): a thread about a request or a change by its title (its
  // number rides in `about`, and the tab draws it as a request's row is
  // drawn); a "+" thread by their first words; a design by its screen.
  const about = row.about_kind && Number(row.about_number) > 0
    ? { kind: row.about_kind, number: Number(row.about_number) } : null;
  const named = about && row.about_title ? row.about_title
    : row.project_idea ? row.project_idea
      : row.draft_title ? row.draft_title
        : row.kind === 'ask' && row.first_own ? row.first_own
          : row.design_title || row.content;
  return {
    rootId: Number(row.root_id),
    title: firstLine(named),
    kind: row.kind || 'idea',
    app: appOf(row),
    at: iso(row.last_at || row.created_at),
    ...(about ? { about } : {}),
    // #6153: a design thread filed as a request, or posted on one as its
    // plan, and that request's number: its row is the request's.
    ...(row.state ? { state: row.state } : {}),
    ...(Number(row.result_ref) > 0 ? { resultRef: Number(row.result_ref) } : {}),
    // #6271: the day it was closed, for Live this week.
    ...(row.done_at ? { doneAt: iso(row.done_at) } : {}),
    // Filed as a request that has finished: History's, not Needs you's.
    ...(row.result_done === true ? { resultDone: true } : {}),
  };
}

/**
 * Pure (#6153): the request a private thread was filed as, or posted its
 * plan on, on a project, as `slug#number`; null for any other thread.
 */
function filedKey(p) {
  if ((p?.state !== 'filed' && p?.state !== 'posted') || !p.app?.slug || !(Number(p.resultRef) > 0)) return null;
  return `${p.app.slug}#${Number(p.resultRef)}`;
}

/**
 * Pure (#6153): the private threads Needs you still lists. A thread filed as
 * a request (or posted on one) whose request has a row of its own, in any
 * list, is that row now: the newest such thread for each request is left
 * out. One whose request is in no list stays, as it was. The tab does the
 * same (frontend/src/features/ai/model.ts needsYou).
 */
function unfiledPrivate(privates, listed) {
  const folded = new Set();
  return (privates || []).filter((p) => {
    // #6271: a done thread is closed; it is not Needs you's, but Live's.
    if (p.state === 'done') return false;
    // Filed as a request that has finished: History's.
    if (p.resultDone === true) return false;
    const key = filedKey(p);
    if (!key || folded.has(key)) return true;
    folded.add(key);
    return !listed.has(key);
  });
}

// $1 viewer, $2 the app. The threads of one project the viewer is in, by
// the same rule the lists above read them (threadsInSql), less the ones they
// muted: what All items' Yours filter keeps (public/js/app-view.js
// _devCardIsYours). Each with its request's number, its changes' ids and its
// decisions' ids, which is how the board's cards are named.
const YOURS_SQL = `
WITH mine AS (${threadsInSql('$1')})
SELECT t.number, t.kind,
       ARRAY(SELECT cs.id FROM chat_sessions cs WHERE cs.thread_id = t.id) AS sessions,
       ARRAY(SELECT i.id FROM issues i WHERE i.thread_id = t.id) AS issues
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
 WHERE t.app_id = $2 AND t.merged_into IS NULL
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)`;

/**
 * Pure: one project's threads of the viewer's, as the board names its cards:
 * request numbers, change (session) ids and decision (governance issue) ids.
 */
function yoursOf(rows) {
  const requests = new Set();
  const sessions = new Set();
  const decisions = new Set();
  for (const row of rows || []) {
    if (row.kind === 'decision') {
      for (const id of row.issues || []) if (Number(id) > 0) decisions.add(Number(id));
    } else if (row.number != null && Number(row.number) > 0) {
      requests.add(Number(row.number));
    }
    for (const id of row.sessions || []) if (Number(id) > 0) sessions.add(Number(id));
  }
  return { requests: [...requests], sessions: [...sessions], decisions: [...decisions] };
}

/** The viewer's threads on one project, for All items' Yours filter. */
async function yoursOn(pool, { user, appId }) {
  const { rows } = await pool.query(YOURS_SQL, [user.id, appId]);
  return yoursOf(rows);
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
    bot ? pool.query(PRIVATE_SQL, [user.id, bot.id, PRIVATE_MAX, LIVE_DAYS]).then((r) => r.rows) : Promise.resolve([]),
    botStages(pool, user, deps),
  ]);
  const facts = await requestFacts(pool, threadRows, user.id, deps);
  const lists = arrange(threadRows, user.id, new Date(), bot ? bot.id : null, bots, facts);
  // #6262: how many messages in each listed thread are new to the viewer.
  // Private threads are not `threads` rows and keep no cursor here: Main
  // Chat's own "N new" covers them.
  const listed = [...lists.needs, ...lists.next, ...lists.waiting, ...lists.live];
  const unread = await (deps.threadReads || require('./thread-reads'))
    .unreadFor(pool, user.id, listed.map((t) => t.threadId));
  for (const t of listed) t.unread = unread.get(t.threadId) || 0;
  return {
    private: privateRows.map(shapePrivate),
    ...lists,
  };
}

// ── The tab's lists, for Homeroom bot's answer (30 Oct 2026) ─────────────
//
// "Where do things stand?" asked in Main is answered from what the tab
// draws, so the answer and the page name the same items in the same lists:
// Needs you (the Needs you feed's cards for the threads they are in, then
// the bot's plans and the requests it handed back, then their private
// threads), In progress, Waiting and Live this week, each less what Needs
// you already holds (frontend/src/features/ai/model.ts needsYou, inProgress,
// upNext). The bot's answer before read its own record of each request's
// stage, which named closed requests the page left out and missed the
// votes, decisions and requests nobody had picked up that the page shows.

/** What a Needs you row waits for, in the words my_work hands the bot. */
const NEED_SAYS = Object.freeze({
  proposal: 'waits for their vote',
  governance: 'waits for their vote',
  ballot: 'waits for them to pick one of its changes',
  question: 'waits for their answer',
  bot_question: 'waits for their answer',
  plan: 'its plan waits for their Build it',
  decide: 'Homeroom bot handed it back: a person needs to decide',
  // #6306: nothing left to build; it only waits to be closed.
  already_works: 'already works, so Homeroom bot offered to close it (Propose to close)',
  build_stopped: 'Homeroom bot\'s build of it stopped: it waits for them to ask it to try again',
  fix_stopped: 'its checks are failing, and Homeroom bot stopped fixing them: it waits for them to let it try again',
  fix_yours: 'their own change waits for their fix: its checks failed, its preview did not build, or it conflicts',
});

/** What an In progress or Waiting row says, by what it waits on (the tab's tooltips, model.ts nextWords). */
const THREAD_SAYS = Object.freeze({
  going_live: 'going live',
  merging: 'merging',
  fixing: 'Homeroom bot is fixing what its tests found',
  revising: 'Homeroom bot is following up on the replies',
  reading: 'Homeroom bot is reading it',
  reading_reply: 'Homeroom bot is reading the newest reply',
  // #6313: queued again after a plan that could not be written.
  retrying_plan: 'Homeroom bot is trying the plan again',
  building: 'being built',
  vote: 'waiting for votes',
  decision: 'waiting for votes',
  fix_queued: 'a test failed; waiting for a free builder to fix it',
  followup_queued: 'waiting for a free builder to follow up on the replies',
  build_queued: 'ready to build; waiting its turn',
  held: 'ready to build; waits until a change up for a vote is decided',
  stalled: 'ready to build; its build has not started',
  queued: 'waiting for a free builder',
  on_hold: 'on hold until Monday',
  // #6158: what a request nobody is moving waits on, in the bot's words.
  not_picked_up: 'nobody is on it',
  needs_person: 'Homeroom bot left it for a person to decide',
  nothing_to_build: 'Homeroom bot found nothing to build in it',
  not_read: 'Homeroom bot has not read it yet',
  operator: 'an operator task: nobody can do it from Homeroom',
  awaiting_plan: 'waiting for their plan: they are working on it with Homeroom bot in a private thread',
});

/** Pure: one In progress or Waiting row's words. `slotVotes` counts the votes they owe that free a held one's slot. */
function threadSays(t, slotVotes = 0) {
  const says = (() => {
    if (t.what === 'building' && t.by === 'bot') return 'Homeroom bot is building it';
    if (t.what === 'building' && t.by === 'you') return 'they are building it';
    if (t.what === 'building' && t.claimedBy) return `${t.claimedBy} is building it`;
    if ((t.what === 'vote' || t.what === 'decision') && t.myVote) return `waiting for votes; they voted ${t.myVote === 'yes' ? 'Yes' : 'No'}`;
    if (t.what === 'held' && t.heldBy === 'turn') return 'ready to build; waiting for Homeroom bot\'s turn on this project';
    if (t.what === 'held' && slotVotes) {
      return `ready to build; ${slotVotes === 1 ? 'a vote they owe' : `${slotVotes} votes they owe`} on Homeroom bot's changes can free its slot`;
    }
    return THREAD_SAYS[t.what] || 'waiting';
  })();
  // #6158: its place in line, as the tab's rows say it.
  if (t.what === 'queued' && t.place) return `#${t.place} in line; ${says}`;
  if (t.what === 'held' && t.place) return `#${t.place} ${t.heldBy === 'turn' ? 'in line' : 'for a slot'}; ${says}`;
  return says;
}

/**
 * Pure (#6250): what Homeroom bot's answer says of a private thread, by where
 * it went. A filed or posted one names the request; a put-away draft says so;
 * an open one is not posted yet.
 */
function privateSays(p) {
  const n = Number(p?.resultRef);
  if (p?.state === 'filed' && n > 0) return `their private thread with Homeroom bot, filed as #${n}`;
  if (p?.state === 'posted' && n > 0) return `their private thread with Homeroom bot, posted on #${n}`;
  if (p?.state === 'dropped') return 'their private thread with Homeroom bot, put away';
  return 'their private thread with Homeroom bot, not posted yet';
}

/**
 * Pure: the tab's four lists from the Needs you feed (`needs`, its items)
 * and workFor's lists (`work`), as my_work hands them to the bot: each row
 * `{ project, projectName, number?, title, says }`. `botUsername` is
 * Homeroom bot's: its changes up for a vote hold its build slots.
 */
function listsOf(needs, work, { botUsername = null } = {}) {
  const items = Array.isArray(needs) ? needs : [];
  // A feed card names a change by its request, as the tab does (model.ts shownNumber).
  const needNumber = (item) => (item.kind === 'ballot' ? item.ballot?.number || item.number : item.number) || null;
  const shownNumber = (item) => (item.kind === 'proposal' && item.request?.number) || needNumber(item);
  const owed = new Set();
  for (const item of items) {
    for (const n of [needNumber(item), shownNumber(item)]) if (item.app && n) owed.add(`${item.app.slug}#${n}`);
  }
  const isOwed = (t) => !!t.app && ((!!t.number && owed.has(`${t.app.slug}#${t.number}`))
    || (!!t.change?.number && owed.has(`${t.app.slug}#${t.change.number}`)));
  const row = (app, number, title, says) => ({
    project: app?.slug || null,
    projectName: app?.name || app?.slug || null,
    ...(number ? { number: Number(number) } : {}),
    title: title || null,
    says,
  });
  const bot = String(botUsername || '').toLowerCase();
  const slotVotes = (t) => (t.what === 'held' && t.heldBy !== 'turn' && t.app && bot
    ? items.filter((item) => item.kind === 'proposal' && item.app?.slug === t.app.slug
      && String(item.author || '').toLowerCase() === bot).length
    : 0);
  // #6153: a private thread filed as a request whose request has a row is that row.
  const listed = new Set(owed);
  for (const t of [...(work?.needs || []), ...(work?.next || []), ...(work?.waiting || []), ...(work?.live || [])]) {
    if (t.app && t.number) listed.add(`${t.app.slug}#${t.number}`);
  }
  const privates = unfiledPrivate(work?.private, listed);
  // #6271: a private thread marked done this week is Live this week's, under
  // its project (Only you when it has none), unless its filed request
  // already has a row of its own: that row stays the one row.
  const closed = (work?.private || []).filter((p) => p.state === 'done'
    && !(p.app && Number(p.resultRef) > 0 && listed.has(`${p.app.slug}#${Number(p.resultRef)}`)));
  const lists = {
    needsYou: [
      ...items.map((item) => row(item.app, shownNumber(item), (item.kind === 'ballot' && item.ballot?.title) || item.title,
        NEED_SAYS[item.kind] || 'waits for them')),
      ...(work?.needs || []).filter((t) => !isOwed(t)).map((t) => row(t.app, t.number, t.title,
        t.what === 'already_works' && t.reason
          ? `${NEED_SAYS.already_works}: ${t.reason}`
          : (NEED_SAYS[t.what] || 'waits for them'))),
      ...privates.map((p) => row(p.app, null, p.title, privateSays(p))),
    ],
    inProgress: (work?.next || []).filter((t) => !isOwed(t)).map((t) => row(t.app, t.number, t.title, threadSays(t))),
    waiting: (work?.waiting || []).filter((t) => !isOwed(t)).map((t) => row(t.app, t.number, t.title, threadSays(t, slotVotes(t)))),
    liveThisWeek: [
      ...(work?.live || []).map((t) => row(t.app, t.number, t.title, 'live')),
      ...closed.map((p) => row(p.app, null, p.title, 'closed: their private thread, marked done')),
    ],
  };
  // The tab's headings count Needs you's rows that ask something (a private
  // thread asks nothing), and every row of the others.
  return {
    ...lists,
    counts: {
      needsYou: lists.needsYou.length - privates.length,
      inProgress: lists.inProgress.length,
      waiting: lists.waiting.length,
      liveThisWeek: lists.liveThisWeek.length,
    },
  };
}

/**
 * The Homeroom bot tab's lists for `user`, as listsOf words them: what
 * Homeroom bot's my_work answers "where do things stand?" from. Reads the
 * Needs you feed for the threads they are in and workFor, as the tab does.
 */
async function pageLists(pool, { user, showSelfHosted = false, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot !== undefined ? deps.bot : await dm.botAccount(pool);
  const feed = deps.needsFeedFor || require('../routes/workshop-overview').needsFeedFor;
  const [needs, work] = await Promise.all([
    feed(pool, { user, showSelfHosted, inThreads: true }),
    workFor(pool, { user, showSelfHosted, deps: { ...deps, bot } }),
  ]);
  return listsOf(needs, work, { botUsername: bot?.username || null });
}

module.exports = {
  // Shared with services/ai-history.js, which reads the same threads once they are finished.
  appOf,
  hrefOf,
  firstLine,
  VISIBLE_APP_WHERE,
  CLAIM_DAYS,
  THREADS_SQL,
  YOURS_SQL,
  yoursOf,
  yoursOn,
  PRIVATE_SQL,
  FACTS_SQL,
  threadsInSql,
  THREADS_MAX,
  PRIVATE_MAX,
  LIVE_DAYS,
  BOT_STANDING,
  standing,
  arrange,
  shapePrivate,
  filedKey,
  unfiledPrivate,
  botStages,
  requestFacts,
  workFor,
  threadSays,
  listsOf,
  pageLists,
};
