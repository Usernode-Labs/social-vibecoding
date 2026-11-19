'use strict';

// #3685: how far along the Homeroom bot is with one person's work, read from
// the platform's own records, so its DM (homeroom-bot-mayor.js) can answer
// "how far along are you?" with what is true and nothing more.
//
// Every request the bot works on for somebody moves through the same steps,
// and each step leaves a record behind:
//
//   set up the project   a first version only: the project's row is still
//                        'creating' and homeroom_bot_first_versions waits for
//                        it. app-creation-phase says which of the four parts
//                        of the setup runs, when it runs in this process.
//   read the request     homeroom_bot_queue: waiting (enqueued_at) or being
//                        read now (started_at). A question the bot asked
//                        waits in homeroom_bot_dm_messages.
//   write a plan         a live 'ready' run whose build session exists and
//                        whose spec is not posted yet.
//   build it             the spec is posted (homeroom_bot_posts 'spec') and
//                        the build session is still active.
//   run its checks       the proposal's check_state, check_phase and
//                        checks_progress.
//   group vote           the proposal is up and its checks passed: votes for
//                        and against, and how many it needs.
//   live                 merged.
//
// The queue row of a request is deleted as soon as it has been read, BEFORE
// its plan and build (homeroom-bot.js runTriage), so a build in progress is
// found from its run and its build session, never from the queue.
//
// Nothing here guesses. A step has a time limit when the platform enforces
// one (a reading turn, a plan, a build), which is the most it can take, not
// an estimate, and a record the bot cannot read is left out, not filled in.
// How long a step usually takes is a fixed range per step (typicalMinutes,
// #19), said as that and nothing finer.
//
// #3734: the DM's activity tray (homeroom-bot-tray.js) lists under Now what
// this module says is in flight (inFlight below), so the tray and the bot's
// own answer never disagree. They used to read it separately: the tray from
// claimed queue rows alone, so a build (whose queue row is gone) and a
// follow-up waiting its turn showed as nothing while the bot said otherwise.

const { changeHref } = require('./change-destination');
// #6528: the ready rule the bot's own ready card uses (checks passed and the
// before & after shots settled), one copy shared with the change machine.
const { heldUntil } = require('../workflow/rules/bot-readiness.ts');

// Lazy: the live module is large, and only the queue readers below need it.
function live() { return require('./homeroom-bot-live'); }
// #6807: the changes waiting on a fix for a check that is not their own.
function flaky() { return require('./homeroom-bot-flaky-checks'); }

/**
 * #3734: the projects a queue row is the bot's own work on (live.appsScope),
 * whether or not it is switched on: that is said apart (botIsOn). Null when
 * there are no settings to read them from.
 */
function actsScope(settings) {
  return settings ? live().appsScope(settings) : null;
}

const MINUTE_MS = 60 * 1000;
// A ready verdict with no build session yet is a build starting. Past this,
// nothing about it is recorded, and that is what is said.
const START_GRACE_MS = 15 * MINUTE_MS;
// 3 Nov 2026 (#6228): how long a reply nobody has queued a read for still
// reads as waiting to be read. After it, a reply the bot does not pick up
// goes back to how the request was (Decide, Stopped), so a request does not
// say "reading" forever.
const REPLY_WAIT_MS = 2 * MINUTE_MS;

/**
 * #6228: the newest message a person wrote in a request's own thread after
 * the run that decided about it: what tells whether the bot has a reply
 * waiting to be read. `$`-free SQL, so progress and track can share one
 * definition: the aliases are the caller's (`it.app_id` in work-state.js
 * REQUEST_FACTS_SQL, `a.id` in the track's read).
 */
function replyLateralSql({
  appId = 'm.app_id', issueNumber = 'm.issue_number', runAt = 'run.created_at',
} = {}) {
  return `LEFT JOIN LATERAL (
    SELECT cm.id AS reply_id, cm.created_at AS reply_at, cm.user_id AS reply_user_id
      FROM chat_messages cm
      JOIN users ru ON ru.id = cm.user_id
     WHERE cm.app_id = ${appId}
       AND cm.thread_type = 'issue'
       AND cm.thread_ref = ${issueNumber}
       AND cm.msg_type = 'message'
       AND cm.deleted_at IS NULL
       AND ru.is_synthetic IS NOT TRUE
       AND cm.created_at > ${runAt}
     ORDER BY cm.id DESC LIMIT 1
  ) reply ON TRUE`;
}

/**
 * #6246 (4 Nov 2026): a plan waiting for Build it, as `$`-free SQL that
 * returns the newest run's `awaiting_go_at` when the request's newest run
 * (newest by id, any mode) waits: live, ready, nothing built from it, not
 * held by a limit, on a request still open. Null otherwise. The aliases are
 * the caller's, as replyLateralSql's are, so the bot page (ai-work.js
 * FACTS_SQL) and anything else that asks the same question asks it one way.
 * planWaits below mirrors it field by field.
 */
function planWaitingSql({ appId = 'm.app_id', issueNumber = 'm.issue_number' } = {}) {
  return `(SELECT CASE WHEN run.mode = 'live' AND run.verdict = 'ready'
                    AND run.awaiting_go_at IS NOT NULL
                    AND run.live_build_waiting_at IS NULL
                    AND run.build_ok IS NULL
                    AND run.build_session_id IS NULL
                    AND run.proposal_session_id IS NULL
                    AND run.cap_suppressed IS NULL
                    AND NOT (COALESCE((SELECT ri.status = 'closed' FROM issues ri
                                        WHERE ri.app_id = ${appId} AND ri.github_issue_number = ${issueNumber}
                                        ORDER BY ri.id DESC LIMIT 1), FALSE)
                             OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests cr
                                         WHERE cr.app_id = ${appId} AND cr.issue_number = ${issueNumber}
                                           AND cr.closed_at IS NOT NULL))
                   THEN run.awaiting_go_at END
              FROM homeroom_bot_runs run
             WHERE run.app_id = ${appId} AND run.issue_number = ${issueNumber}
             ORDER BY run.id DESC LIMIT 1)`;
}

/**
 * Pure (#6246): whether a request's record row (REQUEST_RECORD_COLUMNS) is a
 * plan waiting for Build it:
 * its newest run is live and ready with nothing built from it, the plan still
 * waits (plan_waiting_at), no build is queued or under way, no limit held it,
 * and the request is not closed. planWaitingSql is the same test in SQL.
 */
function planWaits(row) {
  return !!row && row.mode === 'live' && row.verdict === 'ready' && row.build_ok == null
    && !row.run_proposal && !!row.plan_waiting_at && !row.build_waiting_at
    && !row.build_session_id && !row.cap_suppressed && row.request_closed !== true;
}

/**
 * Pure (#6357): why a queue row is held and until when, or null when it is
 * not held (no held_until, or one already past): { kind, until }. `kind` is
 * `allowance` (its payer's building time for the week is used up, held
 * until the week resets) or `cooldown` (its look threw THROWN_TRIES times
 * in a row, held for a day: src/workflow/bot-request/machine.ts), as the
 * workflow recorded it (held_reason). A hold stored before that has no
 * reason, and is not guessed as the allowance: an allowance hold always ends
 * at the week's reset (limits.weeklyResetAt, Monday 00:00 UTC), so only a
 * hold ending exactly there is one, and any other is a cooldown.
 * HOLD_IS_ALLOWANCE_SQL is the same rule in SQL.
 */
function holdOf(row, { now = new Date() } = {}) {
  const until = row && row.held_until ? new Date(row.held_until) : null;
  if (!until || Number.isNaN(until.getTime()) || until.getTime() <= new Date(now).getTime()) return null;
  const said = row.held_reason === 'allowance' || row.held_reason === 'cooldown' ? row.held_reason : null;
  const weekBoundary = until.getUTCDay() === 1 && until.getUTCHours() === 0 && until.getUTCMinutes() === 0
    && until.getUTCSeconds() === 0 && until.getUTCMilliseconds() === 0;
  return { kind: said || (weekBoundary ? 'allowance' : 'cooldown'), until: until.toISOString() };
}

/**
 * holdOf's allowance, in SQL, for the queue row aliased `q`. Written out the
 * same in homeroom-bot-dm.js noteOverAllowance, whose query stays static.
 */
const HOLD_IS_ALLOWANCE_SQL = `(q.held_reason = 'allowance' OR (q.held_reason IS NULL
  AND q.held_until = date_trunc('week', q.held_until AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))`;

/**
 * Pure (#6228): whether a person's reply on a request is newer than the
 * bot's last look and still waiting to be read, from a request's record row (with
 * the `reply` lateral). A read that has started, or a queue row not on hold,
 * is a read coming. Otherwise the reply only counts for REPLY_WAIT_MS: a
 * reply the refresh did not queue goes back to what it was.
 */
function replyWaits(row, { now = new Date() } = {}) {
  if (!row || !row.reply_at) return false;
  const at = new Date(row.reply_at).getTime();
  const runAt = row.run_at ? new Date(row.run_at).getTime() : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(runAt) || at <= runAt) return false;
  if (row.request_closed === true) return false;
  if (row.proposal_status === 'promoted' || row.proposal_status === 'merging') return false;
  if (row.started_at) return true;
  if (row.queue_id) {
    const held = row.held_until ? new Date(row.held_until) : null;
    if (held && !Number.isNaN(held.getTime()) && held > now) return false;
    return true;
  }
  return now.getTime() - at <= REPLY_WAIT_MS;
}
// #3771: the bot's account, whose follow-ups run beside a project's other work.
const BOT_USERNAME = 'homeroom_bot';

// #4053: a first version's steps are named for what is happening, never as
// an instruction: "Step 4 of 7: Build it" read to an invited member as if
// they were asked to build it (onboarding test, 6 October 2026). One story
// per request: a request's steps are named the same way, in the same words
// everywhere they are said (the card, the tray, the bot's answers).
const FIRST_VERSION_STEPS = Object.freeze([
  'Setting up', 'Reading', 'Planning', 'Building', 'Testing', 'Ready to try', 'Live',
]);
const REQUEST_STEPS = Object.freeze([
  'Reading', 'Planning', 'Building', 'Testing', 'Ready to try', 'Live',
]);

// Which step each stage is part of. A request's first step is "Read".
const STEP_OF_STAGE = Object.freeze({
  setting_up: 'setup',
  queued: 'read',
  on_hold: 'read',
  reading: 'read',
  question: 'read',
  // B6: a first version's plan, waiting for its creator's Build it.
  plan: 'plan',
  build_queued: 'plan',
  held: 'plan',
  starting: 'plan',
  planning: 'plan',
  stalled: 'plan',
  building: 'build',
  // A first version's screens reviewed and fixed (services/bot-review.js):
  // still building it, as far as its creator is concerned.
  reviewing: 'build',
  proposing: 'build',
  checks: 'checks',
  checks_failed: 'checks',
  fix_queued: 'checks',
  fixing: 'checks',
  followup_queued: 'vote',
  revising: 'vote',
  vote: 'vote',
  merging: 'vote',
});

// The stages in which the bot itself (or the setup it started) is doing
// something this minute, rather than waiting on the person, the group, the
// checks or its queue: what "working on now" means.
const BUSY_STAGES = new Set([
  'setting_up', 'reading', 'revising', 'fixing', 'starting', 'planning', 'building', 'reviewing', 'proposing', 'merging',
]);

// #3734: what the bot has in hand for the person: doing this minute, or in
// its queue to be done (a request to read, a follow-up on its proposal).
// Not what waits on them or the group, a proposal's checks running, or a
// build held back or stalled. The activity tray's Now is exactly this.
const IN_FLIGHT_STAGES = new Set([...BUSY_STAGES, 'queued', 'build_queued', 'followup_queued', 'fix_queued']);

// app-creation-phase.js PHASES, in words.
const SETUP_PARTS = Object.freeze({
  database: 'making its database',
  repository: 'making its code repository',
  build: 'building it for the first time',
  deploy: 'starting it up',
});

// B6: a first version's plan is the one its creator answers (stage 'plan').
// Once they tap Build it, the build's own plan being written, and its turn
// and workspace being waited for, are the build to them, not the plan again:
// "Step 3 of 7", "writing the plan for the build", read as if their Build it
// had not counted (first-session run-through, 5 October 2026). A request's
// steps are unchanged: its plan is the bot's own.
const FIRST_VERSION_BUILD_STAGES = new Set(['build_queued', 'starting', 'planning']);

const STEP_ORDER = Object.freeze(['setup', 'read', 'plan', 'build', 'checks', 'vote', 'live']);

function stepNumber(stage, firstVersion) {
  const key = firstVersion && FIRST_VERSION_BUILD_STAGES.has(stage) ? 'build' : STEP_OF_STAGE[stage];
  if (!key) return null;
  const at = STEP_ORDER.indexOf(key);
  return firstVersion ? at + 1 : at;
}

/**
 * #4053: the build line, one line at the foot of a project's thumbnail that
 * says where its first version is, the same way on every screen that draws
 * it (the made screen, the App tab, the hub). The browser holds the words
 * (frontend/src/features/first-session/build-line.tsx); the server says
 * which one, for the person reading:
 *
 *   planning     steps 1 to 3: set up, read, plan       everyone
 *   plan         its plan waits for Build it            the person who started it
 *   plan-member  the same                               everyone else
 *   question     it asked the person who started it     them
 *   building     step 4 (from Build it on)              everyone
 *   testing      step 5: its checks                     everyone
 *   ready        step 6: up for approval, to try        everyone
 *   live         step 7                                 everyone
 *   stopped      its build stopped, nothing live yet    everyone
 *
 * Step numbers stay in Homeroom bot's chat: the line never counts.
 *
 * `stopped` (14 Oct 2026, newcomer run eight, Club Votes): its first version
 * was built and could not be proposed, and the App tab had no first version
 * to say any more, so it showed the starter template running, with nothing
 * to say that anything had gone wrong. It is not a step: buildLineOf never
 * names it, and homeroom-bot-dm.js firstVersionState says it when
 * firstVersionStopped below does.
 */
const BUILD_LINE_STATES = Object.freeze(['planning', 'plan', 'plan-member', 'question', 'building', 'testing', 'ready', 'live', 'stopped']);

const BUILD_LINE_OF_STEP = Object.freeze({
  setup: 'planning', read: 'planning', plan: 'planning', build: 'building', checks: 'testing', vote: 'ready', live: 'live',
});

/**
 * Pure: the build line for a first version at `stage` (stageOf, or
 * 'setting_up'), read by its creator (`forCreator`) or anyone else.
 * `question` is a question the bot waits on the creator for. Null for a
 * stage that is no step.
 */
function buildLineOf(stage, { forCreator = false, question = false } = {}) {
  if (stage === 'plan') return forCreator ? 'plan' : 'plan-member';
  if (stage === 'question' && question && forCreator) return 'question';
  const key = FIRST_VERSION_BUILD_STAGES.has(stage) ? 'build' : STEP_OF_STAGE[stage];
  return (key && BUILD_LINE_OF_STEP[key]) || null;
}

// N4 (newcomer run four, 12-13 October 2026): every stage of a first
// version's build named for what is happening, with when it began, so a
// screen can say "Drawing the screens · 2 min so far". The build line
// (buildLineOf) still says `building` for all of them, which Live and the
// thumbnail's screens key on; this is the finer name its words come from
// (frontend/src/features/first-session/build-line-words.js PHASE_WORDS).
// Until this the spec turn, the build and each review round all read as
// "Building it", and the build agent's last phrase ("Adding the ballot
// bar") stayed up through 36 minutes of review.
//
//   starting   its build waits its turn and its workspace starts: no
//              spec turn yet, so nothing is drawn (run five, 13 Oct 2026:
//              "Drawing the screens" showed before the build was picked up)
//   drawing    its spec turn draws the screens (the first look is drawn
//              first: the spec saves its main screen before it writes the
//              rest, live.js FIRST_VERSION_SCREENS_FIRST)
//   writing    the spec turn writes the rest of the plan, once the first
//              look is drawn
//   building   the build turn
//   built      the build landed and its screens are captured for review
//   checking   a review round, `round` of `rounds`
//   testing    proposed, and its checks run (or are fixed)
const FIRST_VERSION_PHASES = Object.freeze(['starting', 'drawing', 'writing', 'building', 'built', 'checking', 'testing']);

/**
 * Pure: the phase of a first version whose plan is decided, from its stage
 * (stageOf), its request's record (REQUEST_RECORD_COLUMNS) and when its first look was
 * drawn: `{ key, since, round?, rounds? }`, or null for a stage before or
 * after the build (setting up, reading, the plan waiting, ready to try).
 */
function firstVersionPhase(state, row = {}, { firstLookAt = null } = {}) {
  const stage = state && state.stage;
  const since = (value) => iso(value);
  switch (stage) {
    case 'build_queued':
    case 'starting':
      return { key: 'starting', since: since(state.since || row.build_waiting_at || row.run_at) };
    case 'planning':
      return firstLookAt
        ? { key: 'writing', since: since(firstLookAt) }
        : { key: 'drawing', since: since(row.build_started_at || state.since) };
    case 'building':
      return { key: 'building', since: since(state.since) };
    case 'reviewing': {
      const rounds = Math.max(1, Number(row.review_max_rounds) || 1);
      const round = Math.min(Number(row.review_round) || 0, rounds);
      return round > 0
        ? { key: 'checking', since: since(row.review_started_at || state.since), round, rounds }
        : { key: 'built', since: since(row.review_started_at || state.since) };
    }
    case 'proposing':
    case 'checks':
    case 'checks_failed':
    case 'fix_queued':
    case 'fixing':
      return { key: 'testing', since: since(row.proposal_at || state.since) };
    default:
      return null;
  }
}

// The App tab's step list (N4), in order, by key: Plan written, Screens
// drawn, Building, Checking the screens, Testing, Live (the words are the
// browser's: build-line-words.js STEP_WORDS).
const FIRST_VERSION_STEP_KEYS = Object.freeze(['plan', 'screens', 'build', 'check', 'test', 'live']);

const PHASE_STEP = Object.freeze({
  starting: 'screens', drawing: 'screens', writing: 'build', building: 'build', built: 'check', checking: 'check', testing: 'test',
  // Run five (13 Oct 2026, fix 7): merged and not live yet (stage
  // 'merging'). Never a phase a screen names: only the step list's place,
  // so every step before Live stays done while it goes live.
  live: 'live',
});

/** The step list's place while a first version goes live (firstVersionSteps). */
const GOING_LIVE = Object.freeze({ key: 'live', since: null });

/**
 * Pure: the App tab's step list for a first version still on its way:
 * one row per FIRST_VERSION_STEP_KEYS, `state` 'done', 'now', 'next' or
 * 'skipped' (no review ran: the row is left out). A done row carries the
 * whole minutes it took when both its ends are known; the row being worked
 * on carries when it began (`since`), which the browser counts on from.
 * `times` are when things happened: `made` (Make it), `decided` (its plan
 * went ahead), `firstLook`, `spec` (the plan for the build posted),
 * `review` (the review began) and `proposal`. `phase` is firstVersionPhase,
 * null while the plan is not decided yet, or GOING_LIVE once it merged and
 * is not live yet: every step before Live done, Live under way.
 */
function firstVersionSteps(phase, times = {}) {
  const at = phase ? FIRST_VERSION_STEP_KEYS.indexOf(PHASE_STEP[phase.key]) : 0;
  const t = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const screensEnd = t(times.firstLook) ?? t(times.spec);
  const bounds = {
    plan: [t(times.made), t(times.decided)],
    screens: [t(times.decided), screensEnd],
    build: [screensEnd, t(times.review) ?? t(times.proposal)],
    check: [t(times.review), t(times.proposal)],
    test: [t(times.proposal), null],
    live: [null, null],
  };
  return FIRST_VERSION_STEP_KEYS.map((key, i) => {
    if (i < at) {
      if (key === 'check' && !times.review) return { key, state: 'skipped' };
      const [from, to] = bounds[key];
      const minutes = from != null && to != null && to >= from ? Math.floor((to - from) / MINUTE_MS) : null;
      return { key, state: 'done', ...(minutes != null ? { minutes } : {}) };
    }
    if (i === at) {
      // From when the step began, else from when its phase did.
      const since = bounds[key][0] ?? t(phase?.since);
      return { key, state: 'now', ...(since != null ? { since: new Date(since).toISOString() } : {}) };
    }
    return { key, state: 'next' };
  });
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pure: a proposal's checks, in plain words, from its columns. */
function checksWords({ check_state: state, check_phase: phase, checks_progress: progress, failed_checks: failedChecks }) {
  if (state === 'passing') return 'passed';
  if (state === 'skipped') return 'not needed for this change';
  if (state === 'failing') {
    const n = Number(failedChecks);
    return Number.isInteger(n) && n > 0 ? `failed (${plural(n, 'test')} did not pass)` : 'failed';
  }
  if (state === 'error' || state === 'unknown') return 'could not run (the preview or the test run broke)';
  if (state === 'pending' || state === 'running') {
    if (phase === 'building') return 'running: building the preview first';
    const p = progress && typeof progress === 'object' ? progress : {};
    if (phase === 'queued') {
      const ahead = Number(p.queue && p.queue.ahead);
      return Number.isInteger(ahead) && ahead > 0
        ? `waiting for a checks slot (${ahead} ahead)`
        : 'waiting for a checks slot';
    }
    const ran = Number(p.ran);
    const expected = Number(p.expected);
    const failed = Number(p.failed) || 0;
    if (Number.isInteger(ran) && Number.isInteger(expected) && expected > 0) {
      return `running: ${ran} of ${expected} done, ${failed} failed so far`;
    }
    return 'running';
  }
  return 'not run yet';
}

/** Pure: how many checks did not pass, from a proposal's test_results. */
function failedCount(results) {
  if (!Array.isArray(results)) return null;
  return results.filter((t) => t && t.status && t.status !== 'pass').length;
}

function links(domain, { slug, number = null, proposal = null, pr = null }) {
  if (!domain || !slug) return {};
  const base = `https://${domain}/#app/${encodeURIComponent(slug)}`;
  return {
    project: base,
    ...(number ? { request: `${base}/dev/issues/${Number(number)}` } : {}),
    // #4367: a change with a pull request goes by its number.
    ...(proposal ? { proposal: `https://${domain}/${changeHref(slug, proposal, pr)}` } : {}),
  };
}

/**
 * Pure (#8, WP3): whether a request's queue row is left over from before its
 * proposal merged: put there before the merge (a reply, a look again), and
 * moot once it went live. It read as "waiting in the queue" in the DM's
 * header long after. A row put there after the merge is new work.
 */
function leftOverQueue(row) {
  if (row.proposal_status !== 'merged' || !row.queue_id || !row.merged_at) return false;
  // B24 (audit 2 Nov 2026): nor is any row on a request that closed with its
  // change live: the bot reads open requests only, so nothing comes of it.
  // A live request's row read "Reading the request" under its "It's live".
  if (row.request_closed === true) return true;
  const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(value || ''));
  const queued = ms(row.enqueued_at || row.started_at);
  const merged = ms(row.merged_at);
  return Number.isFinite(queued) && Number.isFinite(merged) && queued <= merged;
}

/**
 * Pure (N5): whether a proposal's check verdict is about the head up for
 * approval: its reviewed head (an imported pull request's own head), from a
 * request's record row. True when either is not recorded, as before this was
 * read. The merge queue asks the same (src/workflow/merge-queue/facts.ts).
 */
function checksOnHead(row) {
  const head = row?.proposal_source === 'imported' ? row?.imported_pr_head_sha : row?.reviewed_head_sha;
  const checked = row?.checks_sha;
  if (typeof head !== 'string' || !head || typeof checked !== 'string' || !checked) return true;
  return head.toLowerCase() === checked.toLowerCase();
}

/**
 * #6521: checksOnHead for a change as the change page's own rows carry it
 * (routes/votes.js /promoted and /proposals/:id, whose columns are `source`
 * and `checks_commit_sha`), so the page, the thread list (stageOf) and the
 * merge gate read one rule instead of the page believing a stale pass.
 */
function sessionChecksOnHead(session) {
  if (!session) return true;
  return checksOnHead({
    proposal_source: session.source,
    imported_pr_head_sha: session.imported_pr_head_sha,
    reviewed_head_sha: session.reviewed_head_sha,
    checks_sha: session.checks_commit_sha,
  });
}

// N5: a proposal's stages on the vote step that are not ready to try: a
// follow-up waiting its turn or running changes the change.
const FOLLOW_UP_STAGES = new Set(['followup_queued', 'revising']);

// #6282 (4 Nov 2026): a change with an update on its way asks for no vote: a
// yes cast now is cleared when the update lands, and Homeroom asks again.
// These two windows are the ones the bot's own records already use, so an
// ask that has stopped holding the bot (homeroom-bot-voice.js takeAsks puts a
// taken ask older than STALE_ASK_HOURS back to queued) stops holding the
// vote too, and a queued ask past the sweep's week is not an update any more.
const UPDATE_TAKEN_HOURS = 3; // = homeroom-bot-voice.js STALE_ASK_HOURS
const UPDATE_QUEUED_DAYS = 7; // = homeroom-bot.js sweepStrandedAsks' window
// #6348 (5 Nov 2026): the longest a turn may run (src/workflow/turn/machine.ts
// MAX_TURN_MS). A turn marker older than this is one whose process died
// without releasing it, and it is no update on its way.
const UPDATE_TURN_HOURS = 6; // = src/workflow/turn/machine.ts MAX_TURN_MS
// #6600: a takeover's own record (homeroom_bot_looks kind 'update') is an
// update on its way too. One this old is stale: homeroom-bot-takeover.js
// clearStale fails it when the next update starts.
const UPDATE_LOOK_HOURS = 3; // = homeroom-bot-takeover.js STALE_UPDATE_MS

/**
 * #6348: an ask holds the vote only while its change is still on the version
 * the ask was made against. `asked_head_sha` is recorded when the ask is
 * queued (homeroom-bot-voice.js recordAsk); NULL for asks made before the
 * column existed, which keep the time windows alone. A NULL current head
 * keeps holding, as it did before the head was compared at all. `$`-free
 * SQL; `uk` is a homeroom_bot_change_asks alias and `cs` a chat_sessions one.
 */
function askOnHeadSql(uk, cs) {
  return `(${uk}.asked_head_sha IS NULL
           OR lower(${uk}.asked_head_sha) = lower(COALESCE(CASE WHEN ${cs}.source = 'imported'
                                                               THEN ${cs}.imported_pr_head_sha
                                                               ELSE ${cs}.reviewed_head_sha END,
                                                            ${uk}.asked_head_sha)))`;
}

/**
 * #6282: whether an update to a change (`cs`, a chat_sessions alias) is on
 * its way, as `$`-free SQL: 'running' while a fresh turn is in flight on it,
 * or the bot holds a fresh taken ask; 'queued' while an ask waits its turn,
 * and the change is still on the version the ask was made against (#6348);
 * NULL when no update is coming. It reads the bot's own records
 * (homeroom_bot_change_asks) and the durable turn marker
 * (chat_sessions.active_turn), so nothing new is stored.
 *
 * A turn that takes the change's before & after screenshots (mode 'shots',
 * shots-orchestrator.js) is not an update: it reads the change and writes
 * nothing to it. While it ran, a change already checked read "Building ·
 * Updating the change", counted as a try on its request's track, and held
 * its vote as an update would. What holds the vote while the screenshots
 * are taken is their own hold (bot-readiness.ts heldUntil).
 *
 * Read by the stored work state (services/work-state.js, which the Needs
 * you feed reads as vote_open), the AI tab (ai-work.js THREADS_SQL) and the
 * change's own proposal row (routes/votes.js), so all three agree.
 */
function updateComingSql(cs) {
  return `(CASE
    WHEN (${cs}.active_turn IS NOT NULL
          AND COALESCE(${cs}.active_turn->>'mode', 'build') <> 'shots'
          AND (${cs}.active_turn->>'startedAt' IS NULL
               OR (${cs}.active_turn->>'startedAt')::timestamptz > NOW() - make_interval(hours => ${UPDATE_TURN_HOURS})))
      OR EXISTS (SELECT 1 FROM homeroom_bot_change_asks uk
                  WHERE uk.session_id = ${cs}.id AND uk.status = 'taken'
                    AND uk.taken_at > NOW() - make_interval(hours => ${UPDATE_TAKEN_HOURS})
                    AND ${askOnHeadSql('uk', cs)})
      -- #6600: a takeover Homeroom bot is running on the change (its ask is
      -- taken as the look starts, but its own row says so whenever it runs).
      OR EXISTS (SELECT 1 FROM homeroom_bot_looks bl
                  WHERE bl.session_id = ${cs}.id AND bl.kind = 'update' AND bl.state = 'running'
                    AND bl.created_at > NOW() - make_interval(hours => ${UPDATE_LOOK_HOURS}))
      THEN 'running'
    WHEN EXISTS (SELECT 1 FROM homeroom_bot_change_asks uk
                  WHERE uk.session_id = ${cs}.id AND uk.status = 'queued'
                    AND uk.created_at > NOW() - make_interval(days => ${UPDATE_QUEUED_DAYS})
                    AND ${askOnHeadSql('uk', cs)})
      THEN 'queued' END)`;
}

/**
 * #6600: why a takeover's last attempt on a change (`cs`, a chat_sessions
 * alias) failed, as `$`-free SQL: the newest kind 'update' look when it is
 * failed, nothing newer is running, and its end is after the change's last
 * verdict (so a new push or another takeover clears it). NULL when no
 * takeover took the change over, its newest one succeeded, one is running,
 * or the change has been checked since. Reads the bot's own records.
 */
function updateFailedSql(cs) {
  return `(SELECT COALESCE(bl.error, 'it did not finish')
             FROM homeroom_bot_looks bl
            WHERE bl.session_id = ${cs}.id AND bl.kind = 'update'
              AND bl.id = (SELECT MAX(b2.id) FROM homeroom_bot_looks b2
                            WHERE b2.session_id = ${cs}.id AND b2.kind = 'update')
              AND bl.state = 'failed'
              AND bl.ended_at IS NOT NULL
              AND bl.ended_at > COALESCE(${cs}.checks_checked_at, ${cs}.promoted_at)
              AND NOT EXISTS (SELECT 1 FROM homeroom_bot_looks run
                               WHERE run.session_id = ${cs}.id AND run.kind = 'update' AND run.state = 'running'))`;
}

/**
 * #6282: what the update on its way changes, for "Updating: …": the newest
 * fresh taken ask's instruction, else the newest queued one's, or NULL when
 * the turn has nobody's ask behind it. #6348: it names only an ask that
 * holds, so "Updating: …" and the hold never disagree. `$`-free SQL; `cs` is
 * a chat_sessions alias, as updateComingSql's is.
 */
function updateAskSql(cs) {
  return `(SELECT uk.instruction
             FROM homeroom_bot_change_asks uk
            WHERE uk.session_id = ${cs}.id
              AND ((uk.status = 'taken'
                    AND uk.taken_at > NOW() - make_interval(hours => ${UPDATE_TAKEN_HOURS}))
                OR (uk.status = 'queued'
                    AND uk.created_at > NOW() - make_interval(days => ${UPDATE_QUEUED_DAYS})))
              AND ${askOnHeadSql('uk', cs)}
            ORDER BY CASE uk.status WHEN 'taken' THEN 0 ELSE 1 END, uk.id DESC
            LIMIT 1)`;
}

/**
 * Pure (N5): the stage a first version's App tab is drawn at, from its
 * stage (stageOf) and whether it is ready to try (`ready`:
 * homeroom-bot-dm.changeReadiness, the rule its ready card goes out on: its
 * checks passed on its head and its before & after shots settled). Ready to
 * try ('vote') only then; a vote that is not ready yet, and a follow-up
 * queued or running on it, are its checks ('checks': Testing it). Any other
 * stage is itself.
 */
function firstVersionStage(stage, { ready = false } = {}) {
  if (stage === 'vote') return ready ? 'vote' : 'checks';
  if (FOLLOW_UP_STAGES.has(stage)) return 'checks';
  return stage;
}

/**
 * Pure (19 Nov 2026, docs/plans/bot-one-model.md step 1's last reader): the
 * stage a first version's App tab steps are drawn at, from its request's
 * stored work state (services/work-state.js, the one decider every surface
 * reads), in the vocabulary its steps, its build line and its phase read
 * (STEP_OF_STAGE, buildLineOf, firstVersionPhase, firstVersionStage):
 *
 *   reading (its reply, or under way)    'reading'
 *   reading (waiting its turn, a hold)   'queued'
 *   planning                             'planning'; a plan to write again
 *                                        ('retry_plan') or one its requester
 *                                        is writing ('planning_with_you')
 *                                        waits to be read: 'queued', or
 *                                        'build_queued' when a build waits
 *                                        behind the hold
 *   waiting_for_you: plan / question     'plan' / 'question'
 *   building                             its line's step, else 'building'
 *   checking                             'checks'
 *   up_for_vote; going_live as a first   'vote' (its readiness decides Ready
 *   version's (`first_version`)          to try or Testing it)
 *   going_live                           'merging'
 *   stopped (any reason)                 'stopped'
 *
 * Null for what is no step of a first version on its way: it is live or
 * closed, or handed back to its maker for something the App tab has no line
 * for (decide, already works, needs detail), as it always was. Its own
 * deciders (requestStates, outcomeOf and firstVersionStopped, read through
 * them; the first two are gone) read the same records before; where they
 * disagreed with the work state the App tab now
 * follows the work state: a build that stalled, the bot stopped fixing its
 * checks, its look failed, or its change was closed is Stopped (the App tab
 * said Building, said nothing, or showed the starter), a check being fixed
 * for it (#6807) is Testing, and a question its look asked with none open in
 * the chat is its maker's question.
 */
function firstVersionStageOf(work) {
  if (!work || !work.stage) return null;
  // The table of stages and lines says which step each is (work-stages.json
  // `firstVersion`), so a new line names its step where it is defined.
  return require('./work-stages').firstVersionStepOf(work.stage, work.line || null, work.why || null);
}

/**
 * Pure (#6313): whether a request's newest look could not write its plan
 * (homeroom-bot-live.js buildAndPropose: "no plan could be written (…)", the
 * spec turn's final message "only part of a spec"). Nothing was built; the
 * request is queued for another read, which is a retry of the plan.
 */
function planFailed(row) {
  return row?.build_ok === false
    && /no plan could be written|only part of a spec/.test(String(row.build_error || ''));
}

// T2.9 (19 Nov 2026): how long a plan that could not be written reads as
// tried again before its retry read is queued (homeroom-bot.js
// queuePlanRetry, right after the build's record). Past it with no retry
// queued, it is stopped.
const PLAN_RETRY_GRACE_MS = 10 * MINUTE_MS;

/**
 * Pure (T2.9): whether a request's newest look could not write its plan and
 * the bot is about to read it again by itself: its first such failure (a
 * read for the retry is never tried again, #6859), not queued yet, within
 * PLAN_RETRY_GRACE_MS of the build's last activity. Between the build's
 * record and the retry's queue row it read Stopped, and rang "Stopped" for a
 * plan the bot was already trying again.
 */
function planRetryOwed(row, { now = new Date() } = {}) {
  if (!planFailed(row) || row.queue_id || row.request_closed === true) return false;
  if (row.run_read_reason === 'plan_retry') return false;
  const at = Date.parse(row.build_last_activity || row.run_at || '');
  return Number.isFinite(at) && new Date(now).getTime() - at <= PLAN_RETRY_GRACE_MS;
}

/**
 * Pure (14 Oct 2026, newcomer run eight): whether a first version's build
 * stopped, from its request's record row while nothing about it is in
 * progress (stageOf answered null): its newest look went ahead to build it
 * and the build came to nothing (build_ok false: it did not finish, or it
 * was built and not proposed), on a request still open, with no proposal of
 * it up or merged. Not a build stopped as a skip (its request was answered
 * or closed meanwhile) nor one found impossible as written (`blocked:`,
 * which asks its maker for detail instead). Homeroom bot said it stopped,
 * with Try again, in the build's thread.
 */
function firstVersionStopped(row) {
  if (!row || row.mode !== 'live' || row.verdict !== 'ready' || row.build_ok !== false) return false;
  if (row.request_closed === true) return false;
  if (['promoted', 'merging', 'merged'].includes(row.proposal_status)) return false;
  return !/^(?:skipped|blocked):/.test(String(row.build_error || ''));
}

/**
 * Pure (30 Oct 2026): a request Homeroom bot looked at and handed back to
 * the person, from its record row while nothing about it is in
 * progress (stageOf answered null), or null. 'decide' when its newest look
 * left it for a person to decide (verdict 'person', the Go ahead its DM
 * offers); 'already_works' when that look found the ask already there (its
 * `done` tag, #6306), which only waits to be closed; 'build_stopped' when
 * the build came to nothing as firstVersionStopped tells it, which reads no
 * first-version field (the Try again its DM offers). Only on a request still
 * open with no change of it up or merged. Nothing moves on either until
 * somebody does something, so the Homeroom bot tab lists them under Needs
 * you (services/ai-work.js botStages), where they read "Nobody is building
 * it yet" before.
 */
function handedBack(row) {
  if (!row || row.mode !== 'live' || row.request_closed === true) return null;
  if (['promoted', 'merging', 'merged'].includes(row.proposal_status)) return null;
  if ((row.verdict === 'person' || row.verdict === 'empty') && row.run_already_done === true) return 'already_works';
  if (row.verdict === 'person') return 'decide';
  return firstVersionStopped(row) ? 'build_stopped' : null;
}

// #19 (WP3, D5): how long each step usually takes, in minutes, by stage: a
// fixed range for now, to be read from recent runs later. "How long will it
// take?" is answered with this. A step's time limit is the most it can take
// before it is stopped, and a reply that quoted it as the wait ("about 40
// minutes") was answering a different question.
const TYPICAL_MINUTES = Object.freeze({
  setting_up: Object.freeze([2, 6]),
  reading: Object.freeze([1, 3]),
  starting: Object.freeze([1, 5]),
  planning: Object.freeze([3, 8]),
  building: Object.freeze([10, 25]),
  reviewing: Object.freeze([5, 25]),
  proposing: Object.freeze([1, 3]),
  checks: Object.freeze([5, 20]),
  revising: Object.freeze([5, 20]),
  fixing: Object.freeze([5, 20]),
});

/**
 * Pure: how long a stage's step usually takes, `{ from, to }` in minutes, or
 * null for a stage that waits on somebody (a queue, a question, the vote)
 * rather than takes a while. Never past the step's time limit.
 */
function typicalMinutes(stage, limit = null) {
  const range = TYPICAL_MINUTES[stage];
  if (!range) return null;
  const to = Number.isFinite(limit) && limit > 0 ? Math.min(range[1], limit) : range[1];
  return { from: Math.min(range[0], to), to };
}

/**
 * #6234: where Homeroom bot's own fix of a change's failing checks stands,
 * for the change's Testing card (AppView._changeTestingView), which said
 * "Its author needs to fix this" while the author, the bot, was fixing it.
 * Null unless the change is the bot's, up for a vote and failing its checks
 * now; then, in order:
 *   { state: 'fixing', since, reason }   its request's checks_failing queue
 *                                        row has started (reason 'retry'
 *                                        when this head's fix ran out of
 *                                        time once, homeroom-bot.js
 *                                        checksRetried; else null)
 *   { state: 'queued', since }           that row waits its turn
 *   { state: 'platform' }                #6388: the failing checks on this
 *                                        head all look like the platform's
 *                                        (a preview that did not answer), so
 *                                        the bot leaves them to Homeroom's
 *                                        preview and its re-run
 *   { state: 'handed_off' }              its newest run on this head gave it
 *                                        to a person (verdict person or
 *                                        failed)
 *   { state: 'stopped', tries, canTryAgain, head }
 *                                        #6284: it stopped at its own limit of
 *                                        3 fixes, and the requester, an admin
 *                                        or an admin may let it try once more
 *   null                                 nothing of the bot's is recorded
 * A read that fails is null: the card keeps its usual words. The queue is
 * keyed by request; the change reaches it through linked_issues.
 */
async function changeBotFix(pool, sessionId, { viewer = null } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT cs.app_id, cs.status, cs.check_state, cs.checks_commit_sha, cs.reviewed_head_sha,
              cs.linked_issues, cs.test_results, u.username
         FROM chat_sessions cs
         JOIN users u ON u.id = cs.user_id
        WHERE cs.id = $1`,
      [id],
    );
    const cs = rows[0];
    if (!cs || cs.username !== BOT_USERNAME || cs.status !== 'promoted' || cs.check_state !== 'failing') return null;
    const issues = (Array.isArray(cs.linked_issues) ? cs.linked_issues : []).map(Number).filter(Number.isInteger);
    if (issues.length) {
      const queued = await pool.query(
        `SELECT started_at, enqueued_at FROM homeroom_bot_queue
          WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND reason = $3
          ORDER BY started_at DESC NULLS LAST, enqueued_at ASC
          LIMIT 1`,
        [cs.app_id, issues, 'checks_failing'],
      );
      const row = queued.rows[0];
      if (row && row.started_at) {
        const retried = await require('./homeroom-bot').checksRetried(pool, id, cs.reviewed_head_sha);
        return { state: 'fixing', since: row.started_at, reason: retried ? 'retry' : null };
      }
      if (row) return { state: 'queued', since: row.enqueued_at, reason: null };
    }
    // #6807: its failing check is not its own, and Homeroom bot is getting
    // that check fixed: the bot is still working, so the card says so rather
    // than falling through to handed_off, stopped or a person.
    const flake = await flaky().fixingWait(pool, id);
    if (flake) return { state: 'fixing', since: flake.since, reason: 'flaky_check', request: flake.issueNumber };
    const head = String(cs.reviewed_head_sha || '').toLowerCase();
    if (!head) return null;
    // #6388: the checks that failed on the head up for a vote look like the
    // platform's own trouble (a preview that never answered), which the bot
    // already chose not to revise for (homeroom-bot.js oweChecksFix). The
    // card says so instead of falling through to "Its author needs to fix
    // this", which its requester read as being about them.
    if (String(cs.checks_commit_sha || '').toLowerCase() === head) {
      const followup = require('./homeroom-bot-followup');
      const { failing, total } = followup.failingChecks(cs.test_results);
      if (followup.checksLookLikeInfra({ failing, total })) return { state: 'platform', since: null, reason: null };
    }
    const runs = await pool.query(
      `SELECT id, limit_stop FROM homeroom_bot_runs
        WHERE proposal_session_id = $1 AND LOWER(checks_head_sha) = $2 AND verdict IN ('person', 'failed')
        ORDER BY id DESC
        LIMIT 1`,
      [id, head],
    );
    if (!runs.rows.length) return null;
    const run = runs.rows[0];
    if (run.limit_stop !== 'own_revisions') return { state: 'handed_off', since: null, reason: null };
    // #6284: stopped at its own limit. An open grant means a round is
    // already waiting or running for this stop. #6776: only if one really
    // is; a grant with nothing behind it leaves the button there to press.
    const counts = await require('./homeroom-bot-followup').revisionCounts(pool, id);
    if (counts.openGrant) {
      const round = await require('./homeroom-bot-retry-grants').roundState(pool, id);
      if (round.state !== 'none') return { state: 'queued', since: null, reason: null };
    }
    const canTryAgain = viewer
      ? await require('./homeroom-bot-retry-grants').mayGrant(pool, { sessionId: id, user: viewer }).catch(() => false)
      : false;
    return {
      state: 'stopped', since: null, reason: null, head,
      tries: counts.own + counts.grants,
      canTryAgain,
    };
  } catch {
    return null;
  }
}

/**
 * #6280 (4 Nov 2026): whether a request is closed, as `$`-free SQL the
 * caller's aliases name. The newest issue row by id (issues is not unique on
 * (app_id, github_issue_number), so a join could duplicate rows); null: no
 * mirrored issue, or a first version before its request is filed. Null reads
 * as not closed, unless the bot recorded its close (a request with no row of
 * ours: homeroom-bot-closed-requests.js recordClosed). The bot page's rows
 * and a request's track read it one way.
 */
function requestClosedSql({ appId = 'm.app_id', issueNumber = 'm.issue_number' } = {}) {
  return `(COALESCE((SELECT ri.status = 'closed' FROM issues ri
                      WHERE ri.app_id = ${appId} AND ri.github_issue_number = ${issueNumber}
                      ORDER BY ri.id DESC LIMIT 1), FALSE)
             OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests cr
                         WHERE cr.app_id = ${appId} AND cr.issue_number = ${issueNumber} AND cr.closed_at IS NOT NULL))`;
}

/**
 * #6280 (4 Nov 2026): the records one request's row is read from, as
 * `$`-free SQL the caller's aliases name: its queue row, its newest LIVE run
 * (the one stageOf reads: a shadow build's newer run is not this request's
 * stage), the build session that run started, its newest plan post, its
 * newest proposal and change, the newest reply after that run, and an open
 * question about it (anybody's). Its stored work state (work-state.js
 * REQUEST_FACTS_SQL), the times of a first version's steps and the keys of
 * its activity cards (homeroom-bot-dm.js, homeroom-bot-activity.js) and a
 * request's own track (homeroom-bot-track.js REQUEST_ROWS_SQL) read one
 * source, so their stages cannot disagree.
 */
function requestRecordJoinsSql({ appId = 'm.app_id', issueNumber = 'm.issue_number' } = {}) {
  return `LEFT JOIN homeroom_bot_queue q ON q.app_id = ${appId} AND q.issue_number = ${issueNumber}
       LEFT JOIN LATERAL (
         SELECT id, mode, verdict, created_at, duration_ms, cap_suppressed, build_ok, build_error, build_session_id,
                proposal_session_id, live_build_waiting_at, awaiting_go_at,
                reason AS run_reason, already_done AS run_already_done,
                -- T2.9: why the look was read (a failed plan's retry is read once).
                read_reason AS run_read_reason,
                review->>'state' AS review_state, review->>'startedAt' AS review_started_at,
                jsonb_array_length(COALESCE(review->'rounds', '[]'::jsonb)) AS review_round,
                (review->'reviewer'->>'maxRounds')::int AS review_max_rounds,
                (review->'reviewer'->>'budgetMinutes')::int AS review_minutes,
                build_no_change->'turns'->-1->>'said' AS no_change_said
           FROM homeroom_bot_runs
          WHERE app_id = ${appId} AND issue_number = ${issueNumber} AND mode = 'live'
          ORDER BY id DESC LIMIT 1
       ) run ON TRUE
       ${replyLateralSql({ appId, issueNumber, runAt: 'run.created_at' })}
       LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_posts
          WHERE run_id = run.id AND kind = 'spec'
          ORDER BY id DESC LIMIT 1
       ) spec ON TRUE
       LEFT JOIN LATERAL (
         SELECT proposal_session_id FROM homeroom_bot_runs
          WHERE app_id = ${appId} AND issue_number = ${issueNumber} AND proposal_session_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
       ) prop ON TRUE
       LEFT JOIN chat_sessions cs ON cs.id = prop.proposal_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_dm_messages
          WHERE app_id = ${appId} AND issue_number = ${issueNumber} AND question_status = 'open'
          ORDER BY created_at DESC LIMIT 1
       ) oq ON TRUE`;
}

/** The columns requestRecordJoinsSql provides, as both readers select them. */
const REQUEST_RECORD_COLUMNS = `q.id AS queue_id, q.started_at, q.enqueued_at, q.reason AS queue_reason, q.held_until, q.held_reason,
            run.id AS run_id, run.mode, run.verdict, run.created_at AS run_at, run.duration_ms AS run_duration_ms,
            run.cap_suppressed,
            run.build_ok, run.build_error, run.build_session_id, run.proposal_session_id AS run_proposal,
            run.live_build_waiting_at AS build_waiting_at, run.awaiting_go_at AS plan_waiting_at,
            run.review_state, run.review_started_at, run.review_round, run.review_max_rounds, run.review_minutes,
            run.no_change_said, run.run_reason, run.run_already_done, run.run_read_reason,
            bs.status AS build_status, bs.created_at AS build_started_at, bs.last_activity_at AS build_last_activity,
            bs.active_turn->>'mode' AS build_turn_mode, bs.active_turn->>'startedAt' AS build_turn_at,
            spec.created_at AS spec_at,
            prop.proposal_session_id,
            -- Merged but not live yet (live_at) reads as merging: going live.
            CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS proposal_status,
            cs.check_state, cs.check_phase,
            -- #6528: the change's before & after shots, so a passing change
            -- still being shot reads as checking rather than ready.
            cs.shots_state, cs.shots_run_id, cs.shots_detail, cs.shots_updated_at,
            cs.merge_conflict_state, cs.integration_merges_clean, cs.integration_block_reasons,
            cs.checks_progress, cs.checks_checked_at AS checks_at, cs.test_results,
            -- N5: which commit the verdict is about, and the head up for
            -- approval (checksOnHead).
            cs.checks_commit_sha AS checks_sha, cs.reviewed_head_sha, cs.imported_pr_head_sha,
            cs.source AS proposal_source,
            COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.live_at AS merged_at,
            -- T2.1: when and why the bot's change was closed (a closed
            -- change session is 'archived'), which its request's stop says.
            cs.archived_at AS proposal_closed_at, cs.close_reason AS proposal_close_reason,
            oq.created_at AS question_at,
            -- #6284: it stopped at its own limit on this change, with no
            -- grant open: Needs you reads that, not "checking".
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs lr
               WHERE lr.proposal_session_id = prop.proposal_session_id
                 AND lr.limit_stop = 'own_revisions'
                 AND lr.id = (
                   SELECT MAX(lr2.id) FROM homeroom_bot_runs lr2
                    WHERE lr2.proposal_session_id = prop.proposal_session_id
                      AND lr2.verdict IN ('person', 'failed')
                      AND LOWER(lr2.checks_head_sha) = LOWER(cs.reviewed_head_sha))
                 AND NOT EXISTS (
                   SELECT 1 FROM homeroom_bot_revision_grants g
                    WHERE g.session_id = prop.proposal_session_id AND g.used_at IS NULL)
            ) AS fix_stopped,
            -- #6807: an open wait on a fix for a check that is not this
            -- change's: the bot is still working, and it reads as checking.
            ${flaky().flakeFixingSql('prop.proposal_session_id')} AS flake_fixing,
            reply.reply_id, reply.reply_at, reply.reply_user_id`;

/** Where each of `rows`' waiting requests is in the live queue, by queue id. */
async function queuePositions(pool, rows, settings) {
  const position = new Map();
  const scope = actsScope(settings);
  if (!scope || live().scopeIsEmpty(scope) || !rows.some((r) => r.queue_id && !r.started_at)) return position;
  const { rows: queue } = await pool.query(
    `SELECT q.id FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      WHERE q.started_at IS NULL
        AND (CASE WHEN $2::boolean THEN NOT (a.slug = ANY($3::text[])) ELSE a.slug = ANY($1::text[]) END)
      ORDER BY q.priority, q.enqueued_at LIMIT 500`,
    [scope.slugs, scope.all, scope.except],
  );
  queue.forEach((q, i) => position.set(Number(q.id), i + 1));
  return position;
}

// 13 Nov 2026: what a request waiting to be read waits for, in the bot's
// words (stageOf's `queued`). It is the bot's own line (per project), and it
// starts by itself: a tester read "waiting for a free builder" as waiting for
// another person, and wondered whether the project had to be made public for one.
const QUEUE_WAIT = 'waiting its turn in my own line; I\'ll start on it by myself when I have a free slot';

/**
 * The first versions the bot is to build for this person whose request is
 * not filed yet: the project is still being set up, or could not be.
 */
async function firstVersionRows(pool, userId) {
  const { rows } = await pool.query(
    `SELECT a.id AS app_id, a.slug, a.name, a.status AS app_status, a.created_at AS app_created_at,
            f.status, f.created_at, f.error
       FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.user_id = $1 AND f.bot_builds = TRUE AND f.status IN ('waiting', 'filing', 'failed')
      ORDER BY f.created_at DESC LIMIT 10`,
    [userId],
  );
  return rows;
}

/** Pure: a first version's setup, as a stage, or a stopped outcome. */
function setupOf(row, { phase = null } = {}) {
  if (row.status === 'failed') return { outcome: 'its first version could not be started' };
  if (row.app_status === 'error') return { outcome: 'setting up the project failed, so its first version could not be started' };
  if (row.app_status === 'awaiting_secrets') {
    return {
      stage: 'setting_up', since: row.app_created_at || row.created_at, waitingOn: 'them',
      doing: 'the project is waiting for its secrets to be set on its page before it can start',
    };
  }
  if (row.app_status === 'running') {
    return { stage: 'setting_up', since: row.created_at, doing: 'the project is set up; its first request is being filed to start on it' };
  }
  const parts = Object.keys(SETUP_PARTS);
  const part = phase && SETUP_PARTS[phase.phase]
    ? `: part ${parts.indexOf(phase.phase) + 1} of ${parts.length}, ${SETUP_PARTS[phase.phase]}`
    : '';
  return { stage: 'setting_up', since: row.app_created_at || row.created_at, doing: `setting up the project${part}` };
}

/** Pure: whether a stage (stageOf) is in the bot's hands now (IN_FLIGHT_STAGES). */
function inFlight(item) {
  return !!item && IN_FLIGHT_STAGES.has(item.stage) && !item.waitingOn;
}


module.exports = {
  FIRST_VERSION_STEPS,
  REQUEST_STEPS,
  BUILD_LINE_STATES,
  buildLineOf,
  // N4: a first version's stages by name, and its App tab's step list.
  FIRST_VERSION_PHASES,
  FIRST_VERSION_STEP_KEYS,
  firstVersionPhase,
  firstVersionSteps,
  GOING_LIVE,
  SETUP_PARTS,
  BUSY_STAGES,
  IN_FLIGHT_STAGES,
  START_GRACE_MS,
  // #6228: a reply on a request waiting to be read.
  REPLY_WAIT_MS,
  replyWaits,
  holdOf,
  HOLD_IS_ALLOWANCE_SQL,
  replyLateralSql,
  // #6280: one record read for the work state and a request's track.
  requestClosedSql,
  requestRecordJoinsSql,
  REQUEST_RECORD_COLUMNS,
  // #6246: a plan waiting for Build it, read by the bot page and the Workshop.
  planWaits,
  planWaitingSql,
  // #6282: an update on its way holds the vote it would otherwise ask for.
  UPDATE_TAKEN_HOURS,
  UPDATE_QUEUED_DAYS,
  // #6348: a turn marker older than a turn can run is not an update coming.
  UPDATE_TURN_HOURS,
  // #6600: a takeover's running look, and why its last attempt failed.
  UPDATE_LOOK_HOURS,
  askOnHeadSql,
  updateComingSql,
  updateFailedSql,
  updateAskSql,
  inFlight,
  // #6234: the bot's own fix of a change's failing checks, for its page.
  changeBotFix,
  // #6776: the same queue order, for a try's place in line.
  queuePositions,
  checksOnHead,
  // #6521: the same rule for a change page's own row shape.
  sessionChecksOnHead,
  firstVersionStage,
  firstVersionStageOf,
  firstVersionStopped,
  handedBack,
  // T2.9: a plan that could not be written, and whether the bot tries it again.
  planFailed,
  planRetryOwed,
  PLAN_RETRY_GRACE_MS,
  QUEUE_WAIT,
  setupOf,
  firstVersionRows,
  stepNumber,
  checksWords,
  failedCount,
  links,
  // #8, #19 (WP3)
  TYPICAL_MINUTES,
  leftOverQueue,
  typicalMinutes,
};
