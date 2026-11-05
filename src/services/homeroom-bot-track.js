'use strict';

// One track per request (16 Oct 2026; 5 Nov 2026).
//
// A request's place in its work is its stored work state
// (services/work-state.js: ten stages, the same words on every screen). A
// track is that state with what a request's card draws around it: the step
// of the five its bar lights, which try it is on and since when, its place
// in a line, who has it, who shipped it, the links to it. Every surface that
// draws a request's progress (its page, the slots page, a private thread's
// bar, a project's week) reads it from here.
//
// What a track carries is codes, never words: the client words them
// (lib/work-state.ts for the stage, messages.json bot.track.* for the rest).

const log = require('./logger');
const repoRef = require('./repo-ref');
const { requestClosedSql, requestRecordJoinsSql } = require('./homeroom-bot-progress');
const workState = require('./work-state');
const { changeHref } = require('./change-destination');

// The five steps a track's bar draws, in order. A stage lights one.
const STEPS = Object.freeze(['plan', 'build', 'checks', 'vote', 'live']);

// The stages that are over: the chat folds them into "finished today".
const ENDED = new Set(['live', 'stopped', 'closed']);

// The step each stage lights (none before the work starts, or once it ended
// some other way than live).
const STEP_OF_STAGE = Object.freeze({
  reading: 'plan', planning: 'plan', waiting_for_you: 'plan', building: 'build', checking: 'checks',
  up_for_vote: 'vote', going_live: 'live', live: 'live', stopped: null, closed: null,
});
// A line that says nobody is at it yet, or that it waits its turn.
const NOT_STARTED = new Set(['queued', 'waiting', 'on_hold']);
const READY = new Set(['queued', 'held_builds', 'held_waiting']);

// The limits a request can be held at. `builds`: the project's builds
// waiting or under way (homeroom-bot.js BUILDS_PER_APP, #6156), so it waits
// for the bot's turn; `slots`: the project's changes waiting for votes
// (WAITING_PER_APP), so it waits for votes on the bot's other changes;
// `bot_wide`: the bot's ceiling across projects;
// `allowance`: whoever pays for it is out of building time this week.
const CAP_LIMITS = Object.freeze({
  builds_per_app: 'builds',
  proposals_per_app: 'slots',
  proposals_total: 'bot_wide',
});

/**
 * Pure: why a build that did not succeed stopped, as a code, from its run's
 * build_error (the same reading homeroom-bot-dm.js buildFailedCause makes
 * for the DM) and, for a build that changed nothing, what its turns said of
 * it (noChangeWhy). Never the agent's words themselves.
 */
function buildStopWhy(buildError, noChange = null) {
  const r = String(buildError || '').split(/; (?:last activity|it last said):/)[0];
  if (/restarted in the middle of each of its last/.test(r)) return 'restarts';
  if (/ran past its time limit/.test(r)) return 'time';
  if (/restarted|by a restart/.test(r)) return 'restart';
  if (/built but could not be proposed/.test(r)) return 'unproposed';
  if (/couldn't push the build's commit/.test(r)) return 'not_pushed';
  if (/produced no change/.test(r)) return noChangeWhy(noChange);
  if (/could not start|would not start|could not open a session|could not create its branch/.test(r)) return 'no_start';
  return 'build_failed';
}

/**
 * Pure (H2): why a build changed nothing, as a code, from what its last
 * turn said (`said`, the agent's last message, which is never shown to
 * anybody but admins) and whether it was asked once more (`nudged`).
 * 'no_change_already' when it says the change is already there,
 * 'no_change_unclear' when it was not sure what to change,
 * 'no_change_could_not' when it says it could not, else 'no_change'.
 */
function noChangeWhy(noChange) {
  const said = String(noChange?.said || '');
  if (/\balready\b[^.]{0,60}\b(?:exists?|there|implemented|in place|done|works?|does|has|handles|shows|supports)\b|\bno (?:code )?changes? (?:is |are |were )?(?:needed|required|necessary)\b|\bnothing (?:needs|needed) to change\b/i.test(said)) {
    return 'no_change_already';
  }
  if (/\b(?:unclear|ambiguous|not sure|unsure|clarif\w*|which (?:one|of)|need(?:s)? more detail)\b/i.test(said)) return 'no_change_unclear';
  if (/\b(?:can'?t|cannot|could ?n[o']t|unable|not possible|impossible|no access|not allowed|permission)\b/i.test(said)) {
    return 'no_change_could_not';
  }
  return 'no_change';
}


/**
 * Pure: how many tries a request's work has had, from its live runs (the
 * tray's pastRuns rows, newest first): every build of it that was not held
 * or only a plan, and every update of its change (a revision, or one that
 * failed), plus the one `under way` now when no run records it yet. At
 * least 1.
 */
function isTry(run) {
  if (run.verdict === 'ready') return !run.cap_suppressed && run.plan_only !== true && !run.awaiting_go_at;
  if (run.verdict === 'revise') return !!run.proposal_session_id;
  return run.verdict === 'failed' && /^revise:/.test(String(run.error || ''));
}

/** Pure (B23): whether a run's change of the bot's is merged and live (pastRuns' proposal_status). */
function wentLive(run) {
  return run.verdict === 'ready' && !!run.proposal_session_id && run.proposal_status === 'merged';
}

function triesOf(runs = [], { underWay = false } = {}) {
  const tries = runs.filter(isTry).length;
  return Math.max(1, tries + (underWay ? 1 : 0));
}

/**
 * Pure: when each of a request's tries began, oldest first (the runs that
 * triesOf counts, and the try under way when no run records it yet): where
 * a thread marks "Try 2". Empty for a request with one try.
 */
function tryStartsOf(runs = [], { underWay = null } = {}) {
  const starts = runs.filter(isTry).map((run) => iso(run.created_at)).filter(Boolean);
  if (underWay) starts.push(iso(underWay));
  const sorted = [...new Set(starts.filter(Boolean))].sort();
  return sorted.length > 1 ? sorted : [];
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pure: where an entry's links go: its request, its change, or (with no
 * request) its project.
 */
function linksFor(slug, issueNumber, proposalId, prNumber = null) {
  const request = Number(issueNumber) ? `#app/${encodeURIComponent(slug)}/dev/issues/${Number(issueNumber)}` : null;
  return {
    request,
    proposal: proposalId ? changeHref(slug, proposalId, prNumber) : null,
    project: request ? null : `#app/${encodeURIComponent(slug)}/app`,
  };
}

/**
 * Pure: one request's track, from its stored work state.
 *
 *   job      who it is (key, project, number, title, links, its change)
 *   work     its work state (work-state.js fromRow; a fresh request with
 *            none yet reads as not started)
 *   runs     its live runs, newest first, for its tries and a stop's cause
 *   held     its place among the project's held requests ({ position })
 *   doneBy   who shipped it, when somebody else's change closed it
 *            ({ username, prNumber, sessionId })
 *   until    when a hold on the week's building time lifts (limits.weeklyResetAt)
 */
function trackOf({ job, work = null, runs = [], held = null, doneBy = null, until = null }) {
  const state = work || { stage: 'reading', why: null, reason: null, line: { code: 'waiting' }, whoseMove: 'bot', since: null };
  const code = state.line?.code || null;
  let step = STEP_OF_STAGE[state.stage] ?? null;
  if (state.stage === 'reading' && NOT_STARTED.has(code)) step = null;
  // The bot is at it this minute: reading, planning, building, putting it live.
  const busy = (state.stage === 'reading' && !NOT_STARTED.has(code))
    || (state.stage === 'planning' && code !== 'retry_plan' && code !== 'planning_with_you')
    || (state.stage === 'building' && !READY.has(code) && code !== 'claimed')
    || state.stage === 'going_live';
  const waitingOn = state.whoseMove === 'requester' ? 'you' : state.whoseMove === 'group' ? 'group' : null;
  const since = iso(state.since) || iso(job.at);
  // A change being fixed or updated is its next try, until a run records it.
  const loop = code === 'fixing' || code === 'revising';
  const underWay = loop && !runs.some((run) => run.verdict === 'revise' && Date.parse(run.created_at) >= Date.parse(since || 0));
  const lead = runs[0] || null;
  const lastBuild = runs.find((run) => Number(run.build_session_id) > 0);
  const track = {
    key: job.key,
    appSlug: job.appSlug || null,
    appName: job.appName || null,
    iconUrl: job.iconUrl || null,
    iconEmoji: job.iconEmoji || null,
    issueNumber: Number(job.issueNumber) || null,
    title: job.title || null,
    firstVersion: !!job.firstVersion,
    work: { stage: state.stage, why: state.why || null, reason: state.reason || null, line: state.line || null, since },
    step,
    waitingOn,
    busy,
    try: triesOf(runs, { underWay }),
    // This try's clock: when the work under way began, never the wait
    // before it nor an earlier try (#5210 read "16h 31m so far" on a build
    // fifteen minutes old).
    tryStartedAt: busy && (state.stage === 'building' || state.stage === 'planning') ? since : null,
    since,
    rootId: Number(job.cardId) || Number(job.ask?.messageId) || null,
    askId: Number(job.ask?.messageId) || null,
    askThreadId: Number(job.ask?.threadRootId) || null,
    proposalId: Number(job.proposalId) || null,
    // The session its plan and change live in: the change, else its build.
    sessionId: Number(job.proposalId) || Number(lastBuild?.build_session_id) || null,
    tryStarts: tryStartsOf(runs, { underWay: underWay ? since : null }),
    links: job.links || null,
    ...(job.release ? { release: job.release } : {}),
  };
  // Held for one of the project's builds, or for its changes up for a vote:
  // its place in that line. On hold for the week's building time: until when.
  if (code === 'held_builds' || code === 'held_waiting') {
    track.held = { limit: code === 'held_builds' ? 'builds' : 'slots', position: held?.position || null, until: null };
  }
  if (code === 'on_hold') track.held = { limit: 'allowance', position: null, until: iso(until) };
  if (state.stage === 'reading' && code === 'queued' && Number(state.line.place) > 0) {
    track.queue = { ahead: Number(state.line.place) - 1 };
  }
  // A build that did not finish says why, in a code (buildStopWhy).
  if (state.stage === 'stopped' && state.reason === 'build_failed' && lead) {
    track.cause = buildStopWhy(lead.build_error, lead.no_change_said ? { said: lead.no_change_said } : null);
  }
  if (state.stage === 'closed' && doneBy) {
    track.doneBy = { username: doneBy.username || null, prNumber: Number(doneBy.prNumber) || null };
  }
  return track;
}

/**
 * Pure: where Homeroom bot is on a request, from its track, in the terms a
 * design filed as one is told (design-threads.js filedNext, design-bot.js
 * filedLine): `builds` (it has it in hand: reading, planning or building
 * it), `held` at a limit ({ limit, position }), `person` (a person has
 * taken it on, `by`, or the bot handed it to the people on the project to
 * decide), `ended` (live, stopped or closed), or `other` (it waits on its
 * requester's answer, its checks or its vote). Null for no track.
 */
function standingOf(track) {
  if (!track) return null;
  const work = track.work || {};
  const code = work.line?.code || null;
  if (ENDED.has(work.stage)) return { say: 'ended' };
  if (code === 'claimed') return { say: 'person', by: work.line.by || null };
  if (work.stage === 'waiting_for_you' && work.why === 'decide') return { say: 'person', by: null };
  if (track.held?.limit) return { say: 'held', limit: track.held.limit, position: Number(track.held.position) || null };
  if (work.stage === 'reading' || work.stage === 'planning' || work.stage === 'building') return { say: 'builds' };
  return { say: 'other' };
}

// ── Reads ──────────────────────────────────────────────────────

// Each project's held requests, in the order the bot takes them back up
// (homeroom-bot.js refreshApp: oldest hold first, each limit apart): the
// newest live run of each request, held by a limit, on a request still
// open. `$1` the projects.
const HELD_QUEUE_SQL = `
  SELECT h.app_id, h.issue_number, h.cap_suppressed, h.created_at
    FROM (
      SELECT DISTINCT ON (r.app_id, r.issue_number) r.app_id, r.issue_number, r.cap_suppressed, r.created_at
        FROM homeroom_bot_runs r
       WHERE r.app_id = ANY($1::int[]) AND r.mode = 'live'
       ORDER BY r.app_id, r.issue_number, r.id DESC
    ) h
   WHERE h.cap_suppressed IS NOT NULL
     AND COALESCE((SELECT i.status <> 'closed' FROM issues i
                    WHERE i.app_id = h.app_id AND i.github_issue_number = h.issue_number
                    ORDER BY i.id DESC LIMIT 1), TRUE)
     -- 16 Oct 2026: nor one the bot has recorded closed, which a request
     -- with no row of ours can only be (homeroom-bot-closed-requests.js).
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_closed_requests c
                      WHERE c.app_id = h.app_id AND c.issue_number = h.issue_number
                        AND c.closed_at IS NOT NULL)
   ORDER BY h.app_id, h.cap_suppressed, h.created_at, h.issue_number`;

/**
 * Each held request's place in its project's line: Map `${appId}#${n}` →
 * { position, limit, since } (`since`: when it was held). 16 Oct 2026: the
 * line counts only what really waits for the bot. `open` (Map appId → Set of open numbers, from a whole
 * fresh list where the caller has one) drops a request that closed since it
 * was held; `takenBy` (Map appId → issueHolders' Map) answers a request a
 * person has now as { limit: 'taken', by } with no place, since the bot
 * leaves it alone (homeroom-bot.js classifyIssue: in_progress). On 16
 * October the platform's slots page listed 25 held requests "waiting for a
 * slot" with no slot in use: all but one had closed, and that one was
 * claimed.
 */
async function heldQueue(pool, appIds, { open = null, takenBy = null } = {}) {
  const ids = [...new Set((appIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await pool.query(HELD_QUEUE_SQL, [ids]);
  const counts = new Map();
  for (const row of rows) {
    const appId = Number(row.app_id);
    const n = Number(row.issue_number);
    const openHere = open?.get(appId);
    if (openHere && !openHere.has(n)) continue;
    const base = { since: iso(row.created_at), appId, issueNumber: n };
    const holds = takenBy?.get(appId)?.get(n);
    if (holds && holds.length) {
      // `since`, for one a person has: when they took it.
      const who = holds.find((h) => h.username) || holds[0];
      out.set(`${appId}#${n}`, { ...base, since: iso(who.since) || base.since, position: null, limit: 'taken', by: who.username || null });
      continue;
    }
    const line = `${appId}:${row.cap_suppressed}`;
    const position = (counts.get(line) || 0) + 1;
    counts.set(line, position);
    out.set(`${appId}#${n}`, { ...base, position, limit: CAP_LIMITS[row.cap_suppressed] || 'slots' });
  }
  return out;
}

/**
 * Pure: one line of what a request asks, from its body, for a row that has
 * room for little more than its title: the first line that is the person's
 * own words, not the lines Homeroom writes around them (**Source:**, the
 * screenshot, where a comment pin was made). Null when there is none.
 */
function requestExcerpt(body, max = 140) {
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(\*\*[^*]+:\*\*|!\[|<|---|Pinned with |```)/.test(line)) continue;
    const plain = line.replace(/^#+\s*|^[-*>]\s+/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    if (!plain) continue;
    return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}\u2026` : plain;
  }
  return null;
}

// Who shipped a closed request: the newest merged change linked to it that
// is not the bot's. `$1`/`$2` the requests as parallel arrays of project
// and number, `$3` the bot's username.
const DONE_BY_SQL = `
  SELECT DISTINCT ON (w.app_id, w.n) w.app_id, w.n, cs.id AS session_id, cs.pr_number, u.username
    FROM UNNEST($1::int[], $2::int[]) AS w(app_id, n)
    JOIN chat_sessions cs ON cs.app_id = w.app_id AND cs.status = 'merged'
         AND (w.n = ANY(cs.linked_issues) OR cs.created_from_issue_number = w.n)
    JOIN users u ON u.id = cs.user_id
   WHERE u.username <> $3
   ORDER BY w.app_id, w.n, cs.merged_at DESC NULLS LAST, cs.id DESC`;

async function doneByFor(pool, pairs) {
  const out = new Map();
  if (!pairs.length) return out;
  const { rows } = await pool.query(DONE_BY_SQL, [pairs.map((p) => p.appId), pairs.map((p) => p.n), 'homeroom_bot']);
  for (const row of rows) {
    out.set(`${row.app_id}#${row.n}`, { username: row.username, prNumber: row.pr_number, sessionId: row.session_id });
  }
  return out;
}


// ── One project's requests, whoever asked (the request page, the slots) ──

// Of `$2`, the requests of project `$1` the bot has a live run or a queue
// entry for: the only ones with a track (tracksForRequests). 16 Oct 2026: a
// run in the background (mode 'shadow', the bot's trial before it went on
// for everyone) is not one: nobody saw it, and a trial build read as a
// change up for a vote on the request's own page.
const TOUCHED_SQL = `
  SELECT w.n FROM UNNEST($2::int[]) AS w(n)
   WHERE EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.app_id = $1 AND r.issue_number = w.n AND r.mode = 'live')
      OR EXISTS (SELECT 1 FROM homeroom_bot_queue q WHERE q.app_id = $1 AND q.issue_number = w.n)`;

// One project's requests as a track names them (its title, its run, its
// change up for a vote), from the shared per-request record
// (homeroom-bot-progress.js requestRecordJoinsSql): `$1` the project, `$2`
// the request numbers.
const REQUEST_ROWS_SQL = `
  SELECT a.id AS app_id, a.slug, a.name, w.n AS issue_number,
         (SELECT i.title FROM issues i WHERE i.app_id = a.id AND i.github_issue_number = w.n
           ORDER BY i.id DESC LIMIT 1) AS issue_title,
         COALESCE((SELECT rq.first_version FROM homeroom_bot_requesters rq
                    WHERE rq.app_id = a.id AND rq.issue_number = w.n), FALSE) AS first_version,
         q.id AS queue_id, q.started_at, q.enqueued_at, q.reason AS queue_reason, q.held_until,
         run.id AS run_id, run.mode, run.verdict, run.created_at AS run_at, run.duration_ms AS run_duration_ms,
         run.cap_suppressed, run.build_ok, run.build_error, run.build_session_id, run.proposal_session_id AS run_proposal,
         run.live_build_waiting_at AS build_waiting_at, run.awaiting_go_at AS plan_waiting_at,
         run.review_state, run.review_started_at, run.review_round, run.review_max_rounds, run.review_minutes,
         run.no_change_said,
         bs.status AS build_status, bs.created_at AS build_started_at, bs.last_activity_at AS build_last_activity,
         bs.active_turn->>'mode' AS build_turn_mode, bs.active_turn->>'startedAt' AS build_turn_at,
         spec.created_at AS spec_at,
         prop.proposal_session_id,
         CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS proposal_status,
         cs.pr_number AS proposal_pr_number,
         cs.check_state, cs.check_phase, cs.checks_progress, cs.checks_checked_at AS checks_at, cs.test_results,
         cs.checks_commit_sha AS checks_sha, cs.reviewed_head_sha, cs.imported_pr_head_sha,
         cs.source AS proposal_source,
         COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.live_at AS merged_at,
         ${requestClosedSql({ appId: 'a.id', issueNumber: 'w.n' })} AS request_closed,
         oq.created_at AS question_at,
         reply.reply_id, reply.reply_at, reply.reply_user_id
    FROM UNNEST($2::int[]) AS w(n)
    JOIN apps a ON a.id = $1
    ${requestRecordJoinsSql({ appId: 'a.id', issueNumber: 'w.n' })}`;

// Every live run of those requests, newest first, for their tries.
const REQUEST_RUNS_SQL = `
  SELECT r.id, r.app_id, r.issue_number, r.verdict, r.cap_suppressed, r.awaiting_go_at, r.proposal_session_id,
         r.build_ok, r.build_error, r.build_session_id, r.error, r.created_at,
         (r.plan IS NOT NULL AND r.plan->'chosen' IS NULL AND r.build_ok IS FALSE
           AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL) AS plan_only
    FROM homeroom_bot_runs r
   WHERE r.app_id = $1 AND r.issue_number = ANY($2::int[]) AND r.mode = 'live'
   ORDER BY r.id DESC`;

/**
 * Pure: who one row of REQUEST_ROWS_SQL is (its project, number, title, its
 * change up for a vote or merging, the links to it), for its track.
 */
function jobOfRow(row) {
  const n = Number(row.issue_number);
  const open = ['promoted', 'merging'].includes(row.proposal_status) ? Number(row.proposal_session_id) || null : null;
  return {
    key: `${row.slug}#${n}`,
    id: Number(row.run_id) || null,
    appSlug: row.slug,
    appName: row.name || row.slug,
    issueNumber: n,
    title: row.issue_title || null,
    firstVersion: row.first_version === true,
    at: iso(row.run_at),
    proposalId: open,
    links: linksFor(row.slug, n, open, row.proposal_pr_number || null),
  };
}

/**
 * The tracks of one project's requests `numbers`, whoever asked for them:
 * Map n → track, only for requests the bot has had anything to do with.
 * What the request page and the slots view draw. Never throws. `people`:
 * issueHolders' Map for the project, when the caller has read it already.
 */
async function tracksForRequests(pool, { appId, numbers, deps = {}, people = null }) {
  const out = new Map();
  const asked = [...new Set((numbers || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!appId || !asked.length) return out;
  try {
    // A board's whole list comes through here: only the requests the bot has
    // read or queued are worth the full read below.
    const wanted = asked.length > 1
      ? (await pool.query(TOUCHED_SQL, [Number(appId), asked])).rows.map((row) => Number(row.n))
      : asked;
    if (!wanted.length) return out;
    const items = wanted.map((n) => ({ appId: Number(appId), issueNumber: n }));
    await workState.ensure(pool, items);
    const [{ rows }, { rows: runs }, states] = await Promise.all([
      pool.query(REQUEST_ROWS_SQL, [Number(appId), wanted]),
      pool.query(REQUEST_RUNS_SQL, [Number(appId), wanted]),
      workState.forRequests(pool, Number(appId), wanted),
    ]);
    const bot = rows.filter((row) => row.run_id || row.queue_id);
    if (!bot.length) return out;
    const runsOf = new Map();
    for (const run of runs) {
      const n = Number(run.issue_number);
      if (!runsOf.has(n)) runsOf.set(n, []);
      runsOf.get(n).push(run);
    }
    const jobs = bot.map((row) => [row, jobOfRow(row), states.get(Number(row.issue_number)) || null]);
    const code = (work) => work?.line?.code || null;
    let held = new Map();
    if (jobs.some(([, , work]) => code(work) === 'held_builds' || code(work) === 'held_waiting')) {
      // A held request a person has taken since reads as theirs (heldQueue).
      const holders = people || await (deps.botSvc || require('./homeroom-bot')).issueHolders(pool, appId);
      held = await heldQueue(pool, [appId], { takenBy: new Map([[Number(appId), holders]]) });
    }
    const closed = jobs.filter(([, , work]) => work?.stage === 'closed').map(([, job]) => ({ appId: Number(appId), n: job.issueNumber }));
    const doneBy = closed.length ? await doneByFor(pool, closed) : new Map();
    const until = jobs.some(([, , work]) => code(work) === 'on_hold') ? (deps.limits || require('./limits')).weeklyResetAt() : null;
    for (const [row, job, work] of jobs) {
      const runsHere = (runsOf.get(job.issueNumber) || []).map((run) => (Number(run.id) === Number(row.run_id)
        ? { ...run, no_change_said: row.no_change_said } : run));
      out.set(job.issueNumber, trackOf({
        job,
        work,
        runs: runsHere,
        held: held.get(`${appId}#${job.issueNumber}`) || null,
        doneBy: doneBy.get(`${appId}#${job.issueNumber}`) || null,
        until,
      }));
    }
    // A merge of Homeroom itself going live: when its release comes
    // (release-watch.js releasesFor), as the change's own pill says it.
    const going = [...out.values()].filter((t) => t.work.stage === 'going_live' && t.proposalId);
    if (going.length) {
      const releases = await (deps.releaseWatch || require('./release-watch')).releasesFor(pool, going.map((t) => t.proposalId));
      for (const t of going) {
        const release = releases.get(t.proposalId);
        if (release) t.release = release;
      }
    }
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read a project\'s request tracks', { appId, err: err.message });
  }
  return out;
}

/**
 * Papote #3 (18 Oct 2026): a track as `viewerId` reads it on a page anyone
 * can open (the request's page). A track waiting on "you" waits on the
 * person who asked for it (`asker`: { userId, username }), so for anybody
 * else it names them (`waitingFor`): the page said "Waiting on you: Its plan
 * is ready for you to say Build it" to every member, beside a button that
 * said it waited for somebody else. Pure.
 */
function forViewer(track, asker, viewerId) {
  if (!track || track.waitingOn !== 'you' || !asker?.username) return track;
  if (Number(asker.userId) === Number(viewerId)) return track;
  return { ...track, waitingFor: asker.username };
}

// Who asked for each of `$2` on project `$1`, and the title the bot kept
// when it was filed (a request with no row of ours has no other).
const ASKERS_SQL = `
  SELECT q.issue_number, q.issue_title, u.username
    FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
   WHERE q.app_id = $1 AND q.issue_number = ANY($2::int[])`;

async function askersFor(pool, appId, numbers) {
  const out = new Map();
  const list = [...new Set(numbers.map(Number).filter((n) => n > 0))];
  if (!list.length) return out;
  try {
    const { rows } = await pool.query(ASKERS_SQL, [Number(appId), list]);
    for (const row of rows) out.set(Number(row.issue_number), { username: row.username || null, title: row.issue_title || null });
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read who asked for the slots page', { appId, err: err.message });
  }
  return out;
}

/**
 * A project's open requests as GitHub lists them, from the shared cache
 * (services/github.js fetchPublicIssues): by number, and whether the list
 * is whole and fresh, the only kind that may say a request is not open.
 * Never throws; a project with no repository has none.
 */
async function openRequestsOf(app, deps = {}) {
  const repo = repoRef.ownerRepo(app?.repo_url);
  if (!repo) return { byNumber: new Map(), whole: false };
  try {
    const fetched = await (deps.github || require('./github')).fetchPublicIssues(repo.owner, repo.repo);
    const issues = Array.isArray(fetched?.issues) ? fetched.issues : [];
    return {
      byNumber: new Map(issues.map((issue) => [Number(issue.number), issue])),
      whole: !fetched?.note && !fetched?.stale && !fetched?.truncatedList,
    };
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read the open requests for the slots page', { app: app?.slug, err: err.message });
    return { byNumber: new Map(), whole: false };
  }
}

/**
 * One project's bot slots, for the slots page under its Workshop: what
 * holds each of its slots (homeroom-bot.js slotHolders), the requests
 * waiting for one in the order the bot takes them up (heldQueue), the ones
 * on hold until the week resets, how many wait to be read, and the viewer's
 * own building time this week. Every request is carried with its track.
 * #6156: a slot is a build (`buildCap` of them, the project's
 * BUILDS_PER_APP or its own number) or a change waiting for votes
 * (`waitCap`, WAITING_PER_APP or its own), each counted against its own.
 */
async function slotsView(pool, { app, user = null, settings = null, deps = {} }) {
  const botSvc = deps.botSvc || require('./homeroom-bot');
  const live = deps.liveSvc || require('./homeroom-bot-live');
  const s = settings || await botSvc.readSettings(pool);
  const { rows: [bot] = [] } = await pool.query(
    'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
  );
  const caps = botSvc.appCapsOf(s, app.id);
  const view = {
    app: { slug: app.slug, name: app.name || app.slug },
    botOn: !!s && s.mode !== 'off',
    acts: !!s && live.isLiveFor(s, app),
    paused: Array.isArray(s?.pausedApps) && s.pausedApps.includes(app.slug),
    buildCap: caps.building,
    waitCap: caps.waiting,
    buildsAtOnce: caps.building,
    slots: [],
    waiting: [],
    taken: [],
    onHold: [],
    // 16 Oct 2026: every other open request, by where the bot is on it.
    waitingOn: [],
    upNext: [],
    stopped: [],
    leftToPeople: [],
    withPeople: 0,
    reading: 0,
    week: null,
  };
  if (!bot) return view;
  // The project's open requests as GitHub lists them (cached, as the board
  // reads them): each row's title and a line of what it asks, and, from a
  // whole fresh list, which held requests are still open at all.
  const open = await openRequestsOf(app, deps);
  const [holders, people, { rows: queue }] = await Promise.all([
    botSvc.slotHolders(pool, bot, app.id),
    botSvc.issueHolders(pool, app.id),
    pool.query(QUEUE_SQL, [app.id]),
  ]);
  const held = await heldQueue(pool, [app.id], {
    open: open.whole ? new Map([[Number(app.id), new Set(open.byNumber.keys())]]) : null,
    takenBy: new Map([[Number(app.id), people]]),
  });
  const mine = [...held.values()].filter((h) => h.appId === Number(app.id));
  const waiting = mine.filter((h) => h.position).sort((a, b) => a.position - b.position
    || Date.parse(a.since || 0) - Date.parse(b.since || 0));
  const taken = mine.filter((h) => h.limit === 'taken').sort((a, b) => Date.parse(a.since || 0) - Date.parse(b.since || 0));
  const onHold = queue.filter((q) => q.held_until && Date.parse(q.held_until) > Date.now());
  const numbers = [...holders.map((h) => Number(h.issue_number)), ...waiting.map((w) => w.issueNumber),
    ...taken.map((w) => w.issueNumber), ...onHold.map((q) => Number(q.issue_number))].filter((n) => n > 0);
  const [tracks, asked] = await Promise.all([
    tracksForRequests(pool, { appId: app.id, numbers, deps, people }),
    askersFor(pool, app.id, numbers),
  ]);
  // Who asked, its title and a line of it: GitHub's list first, then what
  // the bot kept when it was filed, then Homeroom's own row.
  const about = (n) => {
    const issue = open.byNumber.get(n);
    return {
      title: (issue?.title || asked.get(n)?.title || tracks.get(n)?.title || null),
      askedBy: asked.get(n)?.username || null,
      excerpt: requestExcerpt(issue?.body),
    };
  };
  view.slots = holders.map((h) => ({
    kind: h.kind,
    issueNumber: Number(h.issue_number) || null,
    ...about(Number(h.issue_number)),
    since: iso(h.since),
    track: tracks.get(Number(h.issue_number)) || null,
  }));
  view.waiting = waiting.map((w) => ({
    issueNumber: w.issueNumber, ...about(w.issueNumber), position: w.position, limit: w.limit, since: w.since,
    track: tracks.get(w.issueNumber) || null,
  }));
  view.taken = taken.map((w) => ({
    issueNumber: w.issueNumber, ...about(w.issueNumber), by: w.by, since: w.since,
    track: tracks.get(w.issueNumber) || null,
  }));
  view.onHold = onHold.map((q) => ({
    issueNumber: Number(q.issue_number), ...about(Number(q.issue_number)), until: iso(q.held_until),
    track: tracks.get(Number(q.issue_number)) || null,
  }));
  view.reading = queue.filter((q) => !q.started_at && !(q.held_until && Date.parse(q.held_until) > Date.now())).length;
  await placeTheRest(pool, view, { app, open, queue, people, tracks, asked, settings: s, deps, about, placed: new Set(numbers) });
  if (user?.id) {
    view.week = await (deps.buildingTime || require('./building-time')).weekFor(pool, Number(user.id), { settings: s })
      .then((w) => ({ limited: !!w.limited, usedShare: w.usedShare, usedUp: !!w.usedUp, resetsAt: w.resetsAt }))
      .catch(() => null);
  }
  return view;
}

// Where a track that is not in a slot or a line puts its request on the
// slots page, by its stage: waiting on a person (a question, a plan's Build
// it, more detail), what the bot reads or plans next, stopped after trying,
// or left to a person to decide.
function restSection(track) {
  const work = track?.work;
  if (!work) return null;
  if (work.stage === 'waiting_for_you') return work.why === 'decide' || work.why === 'already_works' ? 'leftToPeople' : 'waitingOn';
  if (work.stage === 'reading' || work.stage === 'planning') return 'upNext';
  if (work.stage === 'stopped') return 'stopped';
  return null;
}

// The most rows one of those sections carries.
const REST_LIMIT = 100;

/**
 * 16 Oct 2026: the slots page's other sections, filled into `view`: every
 * open request (the project's whole list from GitHub) that holds no slot
 * and waits in no line, by where the bot is on it. Up next is what the bot
 * reads next: what waits in its queue, then its older requests in the
 * order it takes them (homeroom-bot.js backlogFor), each with its place and
 * what its trial run made of it. A request a person holds is theirs, and
 * counted only (`withPeople`). Never throws; on a failure the page keeps
 * the sections above.
 */
async function placeTheRest(pool, view, { app, open, queue, people, tracks, asked, settings, deps, about, placed }) {
  try {
    const botSvc = deps.botSvc || require('./homeroom-bot');
    const openNumbers = [...open.byNumber.keys()].filter((n) => !placed.has(n));
    if (!openNumbers.length) return;
    const rest = openNumbers.filter((n) => !people.has(n));
    const isRest = new Set(rest);
    view.withPeople = openNumbers.length - rest.length;
    const more = await tracksForRequests(pool, { appId: app.id, numbers: rest.filter((n) => !tracks.has(n)), deps, people });
    const trackOfN = (n) => tracks.get(n) || more.get(n) || null;
    // Titles for the ones the first read did not ask about.
    const missing = rest.filter((n) => !asked.has(n));
    if (missing.length) for (const [n, a] of await askersFor(pool, app.id, missing)) asked.set(n, a);
    const row = (n, extra = {}) => ({ issueNumber: n, ...about(n), track: trackOfN(n), ...extra });
    const queued = new Set();
    // What waits in the bot's queue to be read, in its order.
    for (const q of queue) {
      const n = Number(q.issue_number);
      if (!isRest.has(n) || q.started_at || (q.held_until && Date.parse(q.held_until) > Date.now())) continue;
      queued.add(n);
      view.upNext.push(row(n, { kind: 'queued', since: iso(q.enqueued_at) }));
    }
    for (const n of rest) {
      if (queued.has(n)) continue;
      const section = restSection(trackOfN(n));
      if (section && section !== 'upNext') view[section].push(row(n, { since: trackOfN(n)?.since || null }));
    }
    // Then the older requests, where the bot acts.
    if (view.acts) {
      const issues = [...open.byNumber.values()];
      const older = await botSvc.backlogFor(pool, app, { issues, settings, holders: people });
      let position = 0;
      for (const p of older) {
        if (!isRest.has(p.n) || queued.has(p.n) || trackOfN(p.n)) continue;
        position += 1;
        view.upNext.push(row(p.n, { kind: 'older', position, trial: p.trial || null, since: iso(open.byNumber.get(p.n)?.createdAt) }));
      }
    }
    for (const key of ['waitingOn', 'upNext', 'stopped', 'leftToPeople']) view[key] = view[key].slice(0, REST_LIMIT);
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not place the rest of a project\'s requests', { app: app?.slug, err: err.message });
  }
}

// The project's rows in the bot's queue: being read, waiting to be, or on
// hold until its payer's week resets.
const QUEUE_SQL = `
  SELECT q.issue_number, q.started_at, q.enqueued_at, q.held_until
    FROM homeroom_bot_queue q
   WHERE q.app_id = $1
   ORDER BY q.enqueued_at, q.id`;

const BOT_USERNAME = 'homeroom_bot';

/**
 * Staging's demo slots, for `?demo=1`: a staging copy never runs the bot,
 * so the page could not be seen there. Obviously fake, written nowhere,
 * drawn with real tracks (trackOf) so it reads as the real page does. Its
 * rows are staging's own mock requests (`mocks`, routes/issues.js
 * stagingMockIssues), so a tap opens a request that is there; without them
 * the rows keep their numbers and titles.
 */
function demoSlots(app, now = Date.now(), mocks = []) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const mock = new Map((mocks || []).map((issue) => [Number(issue.number), issue]));
  const about = (n, fallback, askedBy) => ({
    title: mock.get(n)?.title || fallback, askedBy, excerpt: requestExcerpt(mock.get(n)?.body) || null,
  });
  const job = (n, title) => ({ key: `demo#${n}`, appSlug: app.slug, appName: app.name || app.slug, issueNumber: n, title });
  // Each demo request's work state: a stage of the bot's by its old name
  // (work-state.js fromStage maps it), or how its work ended.
  const ENDED_WORK = {
    build_failed: { stage: 'stopped', reason: 'build_failed' },
    person: { stage: 'waiting_for_you', why: 'decide' },
  };
  const workOf = (fields = {}, extra = {}) => {
    if (fields.stage) return { ...workState.fromStage({ stage: fields.stage, since: fields.since || null }, {}), since: fields.since || null };
    if (fields.outcome === 'held') {
      return extra.held?.limit === 'taken'
        ? { stage: 'building', line: { code: 'claimed', by: extra.held.by }, whoseMove: 'builder' }
        : { stage: 'building', line: { code: extra.held?.limit === 'builds' ? 'held_builds' : 'held_waiting' }, whoseMove: 'bot' };
    }
    return ENDED_WORK[fields.outcome] || null;
  };
  const track = (n, title, fields, extra = {}) => trackOf({ job: job(n, title), work: workOf(fields, extra), ...extra });
  const slot = (kind, n, title, askedBy, fields, extra) => {
    const a = about(n, title, askedBy);
    return { kind, issueNumber: n, ...a, since: ago(60), track: track(n, a.title, fields, extra) };
  };
  // #6156: its builds are all in use, so these wait for the bot's turn.
  const wait = (n, title, askedBy, position, minutes) => {
    const a = about(n, title, askedBy);
    return { issueNumber: n, ...a, position, limit: 'builds', since: ago(minutes),
      track: track(n, a.title, { outcome: 'held' }, {
        held: { position, limit: 'builds' }, runs: [{ verdict: 'ready', cap_suppressed: 'builds_per_app', created_at: ago(minutes) }],
      }) };
  };
  const botSvc = require('./homeroom-bot');
  // Any other request: its track when the bot has one (`fields` null: none).
  const other = (n, title, askedBy, fields, extra = {}) => {
    const a = about(n, title, askedBy);
    return { issueNumber: n, ...a, since: fields?.since || null, track: fields ? track(n, a.title, fields, extra) : null };
  };
  const taken = (n, title, askedBy, by, minutes) => {
    const a = about(n, title, askedBy);
    return { issueNumber: n, ...a, by, since: ago(minutes),
      track: track(n, a.title, { outcome: 'held' }, { held: { position: null, limit: 'taken', by } }) };
  };
  return {
    app: { slug: app.slug, name: app.name || app.slug },
    botOn: true,
    acts: true,
    paused: false,
    buildCap: botSvc.BUILDS_PER_APP,
    waitCap: botSvc.WAITING_PER_APP,
    buildsAtOnce: botSvc.BUILDS_PER_APP,
    slots: [
      slot('build', 900001, 'Staging demo: a total under the list', 'staging-demo-ana', { stage: 'building', since: ago(15) }),
      slot('build', 900003, 'Staging demo: darker buttons', 'staging-demo-ben', { stage: 'fixing', since: ago(4) }, {
        runs: [{ verdict: 'ready', created_at: ago(120) }],
      }),
      slot('build', 900018, 'Staging demo: the bot is building this', 'staging-demo-cy', { stage: 'reviewing', since: ago(8) }),
      slot('build', 900021, 'Staging demo: a calendar view', 'staging-demo-ana', { stage: 'build_queued', since: ago(30) }),
      slot('build', 900022, 'Staging demo: export to a file', 'staging-demo-ben', { stage: 'build_queued', since: ago(12) }),
      slot('proposal', 900006, 'Staging demo: a name for the bot', 'staging-demo-ana', { stage: 'vote', since: ago(300) }),
      slot('proposal', 900002, 'Staging demo: smaller app names', 'staging-demo-cy', { stage: 'checks', since: ago(20) }),
      slot('proposal', 900015, 'Staging demo: keep the vote history', 'staging-demo-ben', { stage: 'question', since: ago(10) }),
    ],
    waiting: [
      wait(900009, 'Staging demo: rethink challenges', 'staging-demo-cy', 1, 200),
      wait(900010, 'Staging demo: a screenshot in the request', 'staging-demo-ana', 2, 90),
    ],
    taken: [
      taken(900014, 'Staging demo: somebody started this', 'staging-demo-ben', 'maya-builder', 60 * 26),
    ],
    onHold: [],
    // 16 Oct 2026: the other open requests, by where the bot is on them.
    waitingOn: [
      other(900016, 'Staging demo: a plan to build', 'staging-demo-cy', { stage: 'plan', since: ago(60 * 20) }),
      other(900008, 'Staging demo: which page?', 'staging-demo-ana', { stage: 'question', since: ago(45) }),
    ],
    upNext: [
      { ...other(900032, 'Staging demo: just filed', 'staging-demo-ben', { stage: 'queued', since: ago(3) }), kind: 'queued' },
      { ...other(900004, 'Staging demo: an older request', null, null), kind: 'older', position: 1, trial: 'ready', since: ago(60 * 24 * 12) },
      { ...other(900005, 'Staging demo: another older one', null, null), kind: 'older', position: 2, trial: null, since: ago(60 * 24 * 15) },
    ],
    stopped: [
      other(900007, 'Staging demo: built nothing', 'staging-demo-cy', { outcome: 'build_failed' }, {
        runs: [{ verdict: 'ready', created_at: ago(60 * 30), build_ok: false, build_error: 'the build produced no change to propose' }],
      }),
    ],
    leftToPeople: [
      other(900013, 'Staging demo: needs a decision', 'staging-demo-ana', { outcome: 'person' }),
    ],
    withPeople: 3,
    reading: 1,
    week: { limited: true, usedShare: 0.62, usedUp: false, resetsAt: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString() },
  };
}

/**
 * Staging's demo request track, for the mock request the bot is building
 * (routes/issues.js, #900018): its second try, fifteen minutes in. Pure.
 */
function demoRequestTrack(app, number, title, now = Date.now()) {
  return trackOf({
    job: {
      key: `${app.slug}#${number}`, appSlug: app.slug, appName: app.name || app.slug,
      issueNumber: number, title: title || null,
    },
    work: { stage: 'building', line: null, whoseMove: 'bot', since: new Date(now - 15 * 60 * 1000).toISOString() },
    runs: [{ verdict: 'ready', created_at: new Date(now - 26 * 60 * 60 * 1000).toISOString() },
      { verdict: 'ready', created_at: new Date(now - 16 * 60 * 1000).toISOString() }],
  });
}

module.exports = {
  STEPS,
  ENDED,
  STEP_OF_STAGE,
  CAP_LIMITS,
  linksFor,
  buildStopWhy,
  noChangeWhy,
  triesOf,
  tryStartsOf,
  trackOf,
  standingOf,
  NOT_STARTED,
  HELD_QUEUE_SQL,
  heldQueue,
  DONE_BY_SQL,
  doneByFor,
  TOUCHED_SQL,
  REQUEST_ROWS_SQL,
  REQUEST_RUNS_SQL,
  QUEUE_SQL,
  jobOfRow,
  tracksForRequests,
  forViewer,
  slotsView,
  demoSlots,
  requestExcerpt,
  openRequestsOf,
  restSection,
  placeTheRest,
  ASKERS_SQL,
  demoRequestTrack,
};
