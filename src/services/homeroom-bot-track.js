'use strict';

// One track per request (16 Oct 2026).
//
// Six parts of the platform each worked out where a request the Homeroom bot
// had was, from their own reading of its runs, its queue row and its change:
// the activity cards, the tray and its strip, the progress answer, the chat's
// news lines, a project's chat cards and the request page. They disagreed:
// a request closed elsewhere stayed in Needs you, work held at a limit read
// as finished, a build's clock counted from its first try, "See progress"
// opened the whole chat. This module is the one place the PEOPLE-FACING
// state of a request is decided, from the same records those readers use:
// progress.stageOf for work in hand and the tray's outcome for work that
// ended. Every surface draws what it says.
//
// A track is a loop, not a line. The normal path is
//
//     queued → planning → building → checks → vote → going_live → live
//
// and it goes back: a question sends it to `waiting` (on the person) and
// back; failing checks, or voters asking for changes, send it back to
// `building` as its next try (`try` counts them); a change behind main is
// synced and its checks run again. From any step it can end up `held` at a
// limit (which limit, what frees it, its place in line), `stopped` (why),
// or `done_elsewhere` (somebody else's change shipped it) or `closed`.
//
// What a track carries is codes, never words: the client words them
// (frontend/locales/en/messages.json bot.track.*), so every surface says the
// same thing the same way.

const log = require('./logger');

const STATES = Object.freeze([
  'queued', 'planning', 'waiting', 'building', 'checks', 'vote', 'going_live', 'live',
  'held', 'stopped', 'done_elsewhere', 'closed',
]);

// The five steps a track's bar draws, in order. A state lights one.
const STEPS = Object.freeze(['plan', 'build', 'checks', 'vote', 'live']);

// The states that are over: the bell rings once on reaching one, and the
// chat folds them into "finished today".
const ENDED = new Set(['live', 'stopped', 'done_elsewhere', 'closed']);

// The limits a request can be held at. `slots`: the project's
// PROPOSALS_PER_APP_CAP; `bot_wide`: the bot's ceiling across projects;
// `questions`: the daily allowance of questions on the project;
// `allowance`: whoever pays for it is out of building time this week.
const CAP_LIMITS = Object.freeze({
  proposals_per_app: 'slots',
  proposals_total: 'bot_wide',
  question_tripwire: 'questions',
});

/**
 * Pure: a progress stage (homeroom-bot-progress.js stageOf, as a tray job
 * or progress entry carries it) as a track's state, step and why. Null for
 * a stage this module does not know, which the caller then reads from the
 * request's outcome instead.
 */
function fromStage(stage, { waitingFor = null } = {}) {
  switch (stage) {
    case 'setting_up': return { state: 'planning', step: 'plan', why: 'setting_up', busy: true };
    case 'queued': return { state: 'queued', step: null, why: waitingFor?.reason || 'turn' };
    case 'reading': return { state: 'planning', step: 'plan', why: 'reading', busy: true };
    case 'question': return { state: 'waiting', step: 'plan', why: 'question', waitingOn: 'you' };
    case 'plan': return { state: 'waiting', step: 'plan', why: 'plan', waitingOn: 'you' };
    case 'held': return { state: 'held', step: 'build', why: 'slots' };
    case 'on_hold': return { state: 'held', step: null, why: 'allowance' };
    case 'build_queued': return { state: 'queued', step: 'build', why: waitingFor?.reason || 'build_turn' };
    case 'starting': case 'planning': return { state: 'planning', step: 'plan', why: 'planning', busy: true };
    case 'stalled': return { state: 'building', step: 'build', why: 'stalled' };
    case 'building': return { state: 'building', step: 'build', why: null, busy: true };
    case 'reviewing': return { state: 'building', step: 'build', why: 'reviewing', busy: true };
    case 'proposing': return { state: 'building', step: 'build', why: 'proposing', busy: true };
    case 'fix_queued': return { state: 'building', step: 'build', why: 'fix_queued', loop: true };
    case 'fixing': return { state: 'building', step: 'build', why: 'fixing', busy: true, loop: true };
    case 'followup_queued': return { state: 'building', step: 'build', why: 'changes_queued', loop: true };
    case 'revising': return { state: 'building', step: 'build', why: 'revising', busy: true, loop: true };
    case 'checks': return { state: 'checks', step: 'checks', why: null };
    case 'checks_failed': return { state: 'checks', step: 'checks', why: 'failed' };
    case 'vote': return { state: 'vote', step: 'vote', why: null, waitingOn: 'group' };
    case 'merging': return { state: 'going_live', step: 'live', why: null, busy: true };
    default: return null;
  }
}

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
 * Pure: an outcome of the tray's (homeroom-bot-tray.js outcomeOf, on a
 * request's lead run) as a track's state, step and why. `lead` is the run
 * the outcome was read from, for a stop's reason and a hold's limit.
 */
function fromOutcome(outcome, lead = null) {
  switch (outcome) {
    case 'live': return { state: 'live', step: 'live', why: null };
    case 'going_live': return { state: 'going_live', step: 'live', why: null };
    case 'proposed': return { state: 'vote', step: 'vote', why: null, waitingOn: 'group' };
    case 'checking': return { state: 'checks', step: 'checks', why: null };
    case 'needs_look': return { state: 'waiting', step: 'checks', why: 'look', waitingOn: 'you' };
    case 'question': return { state: 'waiting', step: 'plan', why: 'question', waitingOn: 'you' };
    case 'blocked': return { state: 'waiting', step: 'plan', why: 'detail', waitingOn: 'you' };
    case 'empty': return { state: 'stopped', step: 'plan', why: 'nothing_to_build' };
    case 'person': return { state: 'stopped', step: lead?.proposal_session_id ? 'checks' : 'plan', why: 'needs_person' };
    case 'build_failed': return { state: 'stopped', step: 'build', why: buildStopWhy(lead?.build_error, { said: lead?.no_change_said }) };
    case 'failed': return { state: 'stopped', step: null, why: 'failed' };
    case 'held': return { state: 'held', step: 'build', why: CAP_LIMITS[lead?.cap_suppressed] || 'slots' };
    case 'closed': return { state: 'stopped', step: 'vote', why: 'withdrawn' };
    case 'stopped': return { state: 'stopped', step: null, why: 'skipped' };
    // A reply the bot answered on its own change: the change is the news.
    case 'answer': case 'revise': return { state: 'vote', step: 'vote', why: null, waitingOn: 'group' };
    default: return null;
  }
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
 * Pure: one request's track, from what the tray knows of it.
 *
 *   job      the tray's entry for it (Now, Needs you or History)
 *   entry    progress.progressFor's entry for it, when it has one: the
 *            stage of work in hand, including a change up for a vote
 *   runs     its live runs, newest first (tray pastRuns rows)
 *   held     its place among the project's held requests ({ position })
 *   doneBy   who shipped it, when somebody else's change closed it
 *            ({ username, prNumber, sessionId })
 *   until    when an allowance hold lifts (limits.weeklyResetAt)
 */
function trackOf({ job, entry = null, runs = [], held = null, doneBy = null, until = null }) {
  const stage = job.stage || entry?.stage || null;
  const lead = runs.find((run) => Number(run.id) === Number(job.id)) || runs[0] || null;
  let base = stage ? fromStage(stage, { waitingFor: entry?.waitingFor || job.waitingFor || null }) : null;
  // A stage that says nothing waits (a change up for a vote) is read off the
  // outcome when the work ended in something sharper.
  if (!base) base = fromOutcome(job.outcome, lead);
  if (!base) {
    base = job.inHand
      ? { state: 'building', step: 'build', why: null }
      : { state: 'stopped', step: null, why: 'unknown' };
  }
  // A question its person answered waits on the bot again, not on them.
  if (base.state === 'waiting' && job.answered && !job.ask) {
    base = { ...base, state: 'planning', waitingOn: null, why: 'answered' };
  }
  // A hand-off of failing checks: the change waits on a person now.
  if (base.state === 'checks' && base.why === 'failed' && job.outcome === 'person') {
    base = { ...base, why: 'handed_over' };
  }
  // The request itself was closed: whatever was still waiting on somebody,
  // or stopped, is over, shipped by somebody else's change or just closed.
  const closed = job.requestClosed === true;
  if (closed && !['vote', 'checks', 'going_live', 'live', 'building'].includes(base.state)) {
    base = doneBy
      ? { state: 'done_elsewhere', step: 'live', why: null }
      : { state: 'closed', step: null, why: null };
  }
  const underWay = !!base.loop && !runs.some((run) => run.verdict === 'revise' && Date.parse(run.created_at) >= Date.parse(entry?.since || job.since || 0));
  const tries = triesOf(runs, { underWay });
  const since = iso(job.since) || iso(entry?.since) || iso(job.at);
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
    state: base.state,
    step: base.step,
    why: base.why || null,
    waitingOn: base.waitingOn || null,
    busy: !!base.busy,
    try: tries,
    // This try's clock: when the work under way began, never the wait
    // before it nor an earlier try (#5210 read "16h 31m so far" on a build
    // fifteen minutes old).
    tryStartedAt: ['building', 'planning'].includes(base.state) ? since : null,
    since,
    rootId: Number(job.cardId) || Number(job.ask?.messageId) || null,
    askId: Number(job.ask?.messageId) || null,
    proposalId: Number(job.proposalId) || Number(entry?.proposal?.proposal) || null,
    // The session its plan and change live in: the change, else its build.
    sessionId: Number(job.proposalId) || Number(entry?.proposal?.proposal) || Number(lastBuild?.build_session_id) || null,
    tryStarts: tryStartsOf(runs, { underWay: underWay ? since : null }),
    links: job.links || null,
    ...(job.release ? { release: job.release } : {}),
  };
  if (base.state === 'held') {
    track.held = {
      limit: base.why,
      position: held?.position || null,
      until: base.why === 'allowance' ? iso(until) : null,
    };
  }
  if (base.state === 'queued' && entry?.waitingFor?.ahead != null) {
    track.queue = { ahead: Number(entry.waitingFor.ahead) || 0 };
  }
  if (base.state === 'done_elsewhere' && doneBy) {
    track.doneBy = { username: doneBy.username || null, prNumber: Number(doneBy.prNumber) || null };
  }
  return track;
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
   ORDER BY h.app_id, h.cap_suppressed, h.created_at, h.issue_number`;

/** Each held request's place in its project's line: Map `${appId}#${n}` → { position, limit, since }. */
async function heldQueue(pool, appIds) {
  const ids = [...new Set((appIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await pool.query(HELD_QUEUE_SQL, [ids]);
  const counts = new Map();
  for (const row of rows) {
    const line = `${row.app_id}:${row.cap_suppressed}`;
    const position = (counts.get(line) || 0) + 1;
    counts.set(line, position);
    out.set(`${row.app_id}#${row.issue_number}`, {
      position, limit: CAP_LIMITS[row.cap_suppressed] || 'slots', since: iso(row.created_at),
      appId: Number(row.app_id), issueNumber: Number(row.issue_number),
    });
  }
  return out;
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

/**
 * Every request in the tray's `work` as a track (trackOf), in the order
 * the tray has them: Now, Needs you, History. `entries` are progressFor's
 * (by key), `rows` the person's live runs (pastRuns). Adds `work.tracks`
 * and returns it. Never throws: a read that fails leaves the tracks without
 * a hold's place or a closer's name.
 */
async function withTracks(pool, work, { entries = [], rows = [], keyOf, deps = {} } = {}) {
  const jobs = [...(work.now || []), ...(work.needsYou || []), ...(work.history || [])];
  const runsByKey = new Map();
  for (const row of rows) {
    const key = keyOf(row.slug, row.issue_number);
    if (!runsByKey.has(key)) runsByKey.set(key, []);
    runsByKey.get(key).push(row);
  }
  const entryByKey = new Map(entries.filter((e) => e && e.project)
    .map((e) => [keyOf(e.project, e.firstVersion ? null : e.number), e]));
  const appIdOf = new Map(rows.map((row) => [row.slug, Number(row.app_id)]).filter(([, id]) => id > 0));
  let held = new Map();
  let doneBy = new Map();
  let until = null;
  try {
    const heldApps = jobs.filter((job) => job.outcome === 'held' || job.stage === 'held').map((job) => appIdOf.get(job.appSlug));
    if (heldApps.some(Boolean)) held = await heldQueue(pool, heldApps.filter(Boolean));
    const closed = jobs.filter((job) => job.requestClosed === true && appIdOf.get(job.appSlug) && job.issueNumber)
      .map((job) => ({ appId: appIdOf.get(job.appSlug), n: Number(job.issueNumber) }));
    if (closed.length) doneBy = await doneByFor(pool, closed);
    if (jobs.some((job) => job.stage === 'on_hold' || entryByKey.get(job.key)?.stage === 'on_hold')) {
      until = (deps.limits || require('./limits')).weeklyResetAt();
    }
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read holds or closers for the tracks', { err: err.message });
  }
  const at = (job) => `${appIdOf.get(job.appSlug)}#${job.issueNumber}`;
  work.tracks = jobs.map((job) => trackOf({
    job,
    entry: entryByKey.get(job.key) || null,
    runs: runsByKey.get(job.key) || [],
    held: held.get(at(job)) || null,
    doneBy: doneBy.get(at(job)) || null,
    until,
  }));
  return work;
}

// ── One project's requests, whoever asked (the request page, the slots) ──

// The records progress.stageOf reads, as homeroom-bot-progress.js
// requestRows reads them for one person, for any requests of one project:
// `$1` the project, `$2` the request numbers. An open question is anybody's.
const REQUEST_ROWS_SQL = `
  SELECT a.id AS app_id, a.slug, a.name, w.n AS issue_number,
         (SELECT i.title FROM issues i WHERE i.app_id = a.id AND i.github_issue_number = w.n
           ORDER BY i.id DESC LIMIT 1) AS issue_title,
         FALSE AS first_version,
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
         (SELECT ri.status = 'closed' FROM issues ri
           WHERE ri.app_id = a.id AND ri.github_issue_number = w.n
           ORDER BY ri.id DESC LIMIT 1) AS request_closed,
         oq.created_at AS question_at
    FROM UNNEST($2::int[]) AS w(n)
    JOIN apps a ON a.id = $1
    LEFT JOIN homeroom_bot_queue q ON q.app_id = a.id AND q.issue_number = w.n
    LEFT JOIN LATERAL (
      SELECT id, mode, verdict, created_at, duration_ms, cap_suppressed, build_ok, build_error, build_session_id,
             proposal_session_id, live_build_waiting_at, awaiting_go_at,
             review->>'state' AS review_state, review->>'startedAt' AS review_started_at,
             jsonb_array_length(COALESCE(review->'rounds', '[]'::jsonb)) AS review_round,
             (review->'reviewer'->>'maxRounds')::int AS review_max_rounds,
             (review->'reviewer'->>'budgetMinutes')::int AS review_minutes,
             build_no_change->'turns'->-1->>'said' AS no_change_said
        FROM homeroom_bot_runs
       WHERE app_id = a.id AND issue_number = w.n
       ORDER BY id DESC LIMIT 1
    ) run ON TRUE
    LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
    LEFT JOIN LATERAL (
      SELECT created_at FROM homeroom_bot_posts
       WHERE run_id = run.id AND kind = 'spec'
       ORDER BY id DESC LIMIT 1
    ) spec ON TRUE
    LEFT JOIN LATERAL (
      SELECT proposal_session_id FROM homeroom_bot_runs
       WHERE app_id = a.id AND issue_number = w.n AND proposal_session_id IS NOT NULL
       ORDER BY id DESC LIMIT 1
    ) prop ON TRUE
    LEFT JOIN chat_sessions cs ON cs.id = prop.proposal_session_id
    LEFT JOIN LATERAL (
      SELECT created_at FROM homeroom_bot_dm_messages
       WHERE app_id = a.id AND issue_number = w.n AND question_status = 'open'
       ORDER BY created_at DESC LIMIT 1
    ) oq ON TRUE`;

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
 * Pure: one row of REQUEST_ROWS_SQL as the tray's entry for it would be,
 * so trackOf reads it the same way: its stage (progress.stageOf), and when
 * nothing about it is in hand, what its newest run came to (the tray's
 * outcomeOf).
 */
function jobOfRow(row, { now = new Date(), stageOf, outcomeOf, linksFor = null } = {}) {
  const live = row.mode === 'live' || !row.run_id;
  const state = live ? stageOf(row, { now }) : null;
  const outcome = state || !row.run_id ? null : outcomeOf({
    ...row,
    proposal_session_id: row.run_proposal,
    proposal_status: row.run_proposal && Number(row.run_proposal) === Number(row.proposal_session_id) ? row.proposal_status : null,
  });
  const n = Number(row.issue_number);
  const open = ['promoted', 'merging'].includes(row.proposal_status) ? Number(row.proposal_session_id) || null : null;
  return {
    key: `${row.slug}#${n}`,
    id: Number(row.run_id) || null,
    appSlug: row.slug,
    appName: row.name || row.slug,
    issueNumber: n,
    title: row.issue_title || null,
    firstVersion: false,
    stage: state ? state.stage : null,
    since: state ? iso(state.since) : null,
    at: iso(row.run_at),
    outcome,
    requestClosed: row.request_closed === true,
    proposalId: open,
    links: linksFor ? linksFor(row.slug, n, open, row.proposal_pr_number || null) : null,
  };
}

/**
 * The tracks of one project's requests `numbers`, whoever asked for them:
 * Map n → track, only for requests the bot has had anything to do with.
 * What the request page and the slots view draw. Never throws.
 */
async function tracksForRequests(pool, { appId, numbers, now = new Date(), deps = {} }) {
  const out = new Map();
  const wanted = [...new Set((numbers || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!appId || !wanted.length) return out;
  try {
    const progress = deps.progress || require('./homeroom-bot-progress');
    const tray = deps.tray || require('./homeroom-bot-tray');
    const [{ rows }, { rows: runs }] = await Promise.all([
      pool.query(REQUEST_ROWS_SQL, [Number(appId), wanted]),
      pool.query(REQUEST_RUNS_SQL, [Number(appId), wanted]),
    ]);
    const bot = rows.filter((row) => row.run_id || row.queue_id);
    if (!bot.length) return out;
    const runsOf = new Map();
    for (const run of runs) {
      const n = Number(run.issue_number);
      if (!runsOf.has(n)) runsOf.set(n, []);
      runsOf.get(n).push(run);
    }
    const jobs = bot.map((row) => [row, jobOfRow(row, { now, stageOf: progress.stageOf, outcomeOf: tray.outcomeOf, linksFor: tray.linksFor })]);
    const held = jobs.some(([, job]) => job.outcome === 'held' || job.stage === 'held')
      ? await heldQueue(pool, [appId]) : new Map();
    const closed = jobs.filter(([, job]) => job.requestClosed).map(([, job]) => ({ appId: Number(appId), n: job.issueNumber }));
    const doneBy = closed.length ? await doneByFor(pool, closed) : new Map();
    const until = jobs.some(([, job]) => job.stage === 'on_hold') ? (deps.limits || require('./limits')).weeklyResetAt() : null;
    for (const [row, job] of jobs) {
      const runsHere = (runsOf.get(job.issueNumber) || []).map((run) => (Number(run.id) === Number(row.run_id)
        ? { ...run, no_change_said: row.no_change_said } : run));
      out.set(job.issueNumber, trackOf({
        job,
        entry: null,
        runs: runsHere,
        held: held.get(`${appId}#${job.issueNumber}`) || null,
        doneBy: doneBy.get(`${appId}#${job.issueNumber}`) || null,
        until,
      }));
    }
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read a project\'s request tracks', { appId, err: err.message });
  }
  return out;
}

/**
 * One project's bot slots, for the slots page under its Workshop: what
 * holds each of its PROPOSALS_PER_APP_CAP slots (homeroom-bot.js
 * slotHolders), the requests waiting for one in the order the bot takes
 * them up (heldQueue), the ones on hold until the week resets, how many
 * wait to be read, and the viewer's own building time this week. Every
 * request is carried with its track.
 */
async function slotsView(pool, { app, user = null, settings = null, deps = {} }) {
  const botSvc = deps.botSvc || require('./homeroom-bot');
  const live = deps.liveSvc || require('./homeroom-bot-live');
  const s = settings || await botSvc.readSettings(pool);
  const { rows: [bot] = [] } = await pool.query(
    'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
  );
  const view = {
    app: { slug: app.slug, name: app.name || app.slug },
    botOn: !!s && s.mode !== 'off',
    acts: !!s && live.isLiveFor(s, app),
    paused: Array.isArray(s?.pausedApps) && s.pausedApps.includes(app.slug),
    cap: botSvc.PROPOSALS_PER_APP_CAP,
    buildsAtOnce: botSvc.BUILDS_PER_PROJECT || null,
    slots: [],
    waiting: [],
    onHold: [],
    reading: 0,
    week: null,
  };
  if (!bot) return view;
  const [holders, held, { rows: queue }] = await Promise.all([
    botSvc.slotHolders(pool, bot, app.id),
    heldQueue(pool, [app.id]),
    pool.query(QUEUE_SQL, [app.id]),
  ]);
  const waiting = [...held.values()].filter((h) => h.appId === Number(app.id)).sort((a, b) => a.position - b.position
    || Date.parse(a.since || 0) - Date.parse(b.since || 0));
  const onHold = queue.filter((q) => q.held_until && Date.parse(q.held_until) > Date.now());
  const numbers = [...holders.map((h) => Number(h.issue_number)), ...waiting.map((w) => w.issueNumber),
    ...onHold.map((q) => Number(q.issue_number))].filter((n) => n > 0);
  const tracks = await tracksForRequests(pool, { appId: app.id, numbers, deps });
  const titled = (n) => tracks.get(n)?.title || null;
  view.slots = holders.map((h) => ({
    kind: h.kind,
    issueNumber: Number(h.issue_number) || null,
    title: titled(Number(h.issue_number)),
    since: iso(h.since),
    track: tracks.get(Number(h.issue_number)) || null,
  }));
  view.waiting = waiting.map((w) => ({
    issueNumber: w.issueNumber, title: titled(w.issueNumber), position: w.position, limit: w.limit, since: w.since,
    track: tracks.get(w.issueNumber) || null,
  }));
  view.onHold = onHold.map((q) => ({
    issueNumber: Number(q.issue_number), title: titled(Number(q.issue_number)), until: iso(q.held_until),
    track: tracks.get(Number(q.issue_number)) || null,
  }));
  view.reading = queue.filter((q) => !q.started_at && !(q.held_until && Date.parse(q.held_until) > Date.now())).length;
  if (user?.id) {
    view.week = await (deps.buildingTime || require('./building-time')).weekFor(pool, Number(user.id), { settings: s })
      .then((w) => ({ limited: !!w.limited, usedShare: w.usedShare, usedUp: !!w.usedUp, resetsAt: w.resetsAt }))
      .catch(() => null);
  }
  return view;
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
 * drawn with real tracks (trackOf) so it reads as the real page does.
 */
function demoSlots(app, now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const job = (n, title, fields) => ({ key: `demo#${n}`, appSlug: app.slug, appName: app.name || app.slug, issueNumber: n, title, ...fields });
  const track = (n, title, fields, extra = {}) => trackOf({ job: job(n, title, fields), ...extra });
  const slot = (kind, n, title, fields, extra) => ({ kind, issueNumber: n, title, since: ago(60), track: track(n, title, fields, extra) });
  return {
    app: { slug: app.slug, name: app.name || app.slug },
    botOn: true,
    acts: true,
    paused: false,
    cap: 5,
    buildsAtOnce: 3,
    slots: [
      slot('build', 901, 'Staging demo: a total under the list', { stage: 'building', since: ago(15) }),
      slot('build', 902, 'Staging demo: darker buttons', { stage: 'fixing', since: ago(4) }, {
        runs: [{ verdict: 'ready', created_at: ago(120) }],
      }),
      slot('proposal', 903, 'Staging demo: a name for the bot', { stage: 'vote', since: ago(300) }),
      slot('proposal', 904, 'Staging demo: smaller app names', { stage: 'checks', since: ago(20) }),
      slot('proposal', 905, 'Staging demo: keep kudos history', { stage: 'question', since: ago(10) }),
    ],
    waiting: [
      { issueNumber: 906, title: 'Staging demo: rethink challenges', position: 1, limit: 'slots', since: ago(200),
        track: track(906, 'Staging demo: rethink challenges', { outcome: 'held' }, { held: { position: 1 } }) },
    ],
    onHold: [],
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
      issueNumber: number, title: title || null, stage: 'building', since: new Date(now - 15 * 60 * 1000).toISOString(),
    },
    runs: [{ verdict: 'ready', created_at: new Date(now - 26 * 60 * 60 * 1000).toISOString() },
      { verdict: 'ready', created_at: new Date(now - 16 * 60 * 1000).toISOString() }],
  });
}

module.exports = {
  STATES,
  STEPS,
  ENDED,
  CAP_LIMITS,
  fromStage,
  fromOutcome,
  buildStopWhy,
  noChangeWhy,
  triesOf,
  tryStartsOf,
  trackOf,
  HELD_QUEUE_SQL,
  heldQueue,
  DONE_BY_SQL,
  doneByFor,
  withTracks,
  REQUEST_ROWS_SQL,
  REQUEST_RUNS_SQL,
  QUEUE_SQL,
  jobOfRow,
  tracksForRequests,
  slotsView,
  demoSlots,
  demoRequestTrack,
};
