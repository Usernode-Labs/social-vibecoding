'use strict';

const { planRecordSql } = require('./request-specs');

// One work state per request and per change (5 Nov 2026, step 3 of one bot
// per thread: docs/plans/bot-one-model.md).
//
// Seven pieces of code used to decide where a request stood, one per surface
// (the bot tab's standing, the drawer's outcomes, a request page's track, a
// project chat card's stage, the bell's moments, ...), each from the same
// records with rules of its own, and they disagreed: one request read Decide
// on the bot tab, sat in History in the drawer and said Reading in its
// project's chat. This module decides it once:
//
//   derive(facts)        the stage of a request, from one facts row (the
//                        bot's records, read by REQUEST_FACTS_SQL: the same
//                        per-request query the bot page and the track read)
//   deriveChange(facts)  the stage of a change with no request of its own
//   placeFor(state, you) where an item goes for one viewer: Needs you, In
//                        progress, Waiting, Live, or not listed
//   bellOf(prev, next)   the moment a change of stage rings, if any
//   refresh(db, items)   derives the items again and stores each that
//                        changed (work_states), returning them
//   afterTransition      the workflow's hook: after every accepted event of
//                        a machine that moves a request or a change, in its
//                        own transaction, refresh the items it is about and
//                        push each change (`work_state`)
//
// Ten stages, the same words everywhere: reading, planning, waiting_for_you
// (always with a why), building, checking, up_for_vote, going_live, live,
// stopped (with a reason), closed. The second line (`line`) carries queue and
// hold reasons and detail.

const progress = require('./homeroom-bot-progress');
// #6807: whether a change waits on a fix for a check that is not its own.
const flaky = require('./homeroom-bot-flaky-checks');
const { syncWaits, syncStand } = require('./vote-ready');
const checksEstimate = require('./checks-estimate');
const { firstVersionSql } = require('./first-version-rule');
const { heldUntil, readyToTry } = require('../workflow/rules/bot-readiness.ts');
const { currentVotePredicateSql } = require('../workflow/rules/vote-predicate.ts');

// The stages, whys, reasons and line codes, and what each means on every
// surface, are one table (work-stages.json): the lists below are read off it.
const stages = require('./work-stages');
const { STAGES, WHYS, REASONS } = stages;
// A live item is listed for a week, as the bot tab always did.
const LIVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// The bot reads a claim this long (homeroom-bot.js CLAIM_TTL_DAYS).
const CLAIM_DAYS = 7;

const iso = (at) => {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// #6306: the bot's first whole sentence, cut at `max` with "…" when it does
// not fit. A row says what it found in one sentence; the page keeps all.
function firstSentence(text, max = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0];
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

// ── Reasons a later release made out of date ──────────────────────────────

// A read handed a request back for a limit Homeroom has since lifted: the
// reason is no longer true, so the request's card offers to read it again
// (homeroom-bot-dm.js askBotToBuild `readAgain`). Each entry names a code the
// client words (`request.status.note.outdated*`), the release that lifted it,
// and a pattern for the reasons it explains; a later fix adds a line here.
// The first: the bot could not read a plan a person posted (6 Nov 2026,
// 13:05 UTC, #6384).
const LIFTED_LIMITS = Object.freeze([
  Object.freeze({
    code: 'posted_plan',
    liftedAt: '2026-11-06T13:05:00Z',
    pattern: /\bplan\b[^.]*\b(cannot|can't|could not|couldn't|unable to)\b[^.]*\bread|\b(cannot|can't|could not|couldn't|unable to)\b[^.]*\bread\b[^.]*\bplan\b/i,
  }),
]);

/**
 * Pure: the code of the lifted limit that explains a request's hand-back
 * reason ('posted_plan'), else null. Only a `reason` line written before
 * that limit was lifted counts (`work.since`), never one given after.
 */
function outdatedReason(work) {
  if (!work || work.stage !== 'waiting_for_you') return null;
  if (!work.line || work.line.code !== 'reason') return null;
  const text = String(work.line.text || '');
  const since = Date.parse(work.since || '');
  if (!text || !Number.isFinite(since)) return null;
  for (const limit of LIFTED_LIMITS) {
    const at = Date.parse(limit.liftedAt);
    if (Number.isFinite(at) && since < at && limit.pattern.test(text)) return limit.code;
  }
  return null;
}

// ── Deciding ──────────────────────────────────────────────────────────────

const state = (stage, extra = {}) => {
  const out = { stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra };
  if (out.whoseMove == null) out.whoseMove = stages.whoseMoveOf(stage);
  out.since = iso(out.since);
  return out;
};

/**
 * Pure: the checks estimate's second line while a run is in flight (#6402).
 * `About N min left`, from the same estimate the Testing card draws: the
 * median build plus checks time, less how long this run has been going. No
 * line when there is no estimate, the run has passed it, or it waits for a
 * free checks slot (`queued`: no time can be estimated yet).
 */
function checksLine(row, now) {
  if (!row || row.check_phase === 'queued') return null;
  const running = ['building', 'testing'].includes(row.check_phase)
    || (row.check_phase == null && (row.check_state === 'pending' || row.check_state === 'running'));
  if (!running) return null;
  const estimate = row.checks_estimate;
  const buildMs = Number(estimate && estimate.buildMs);
  const checksMs = Number(estimate && estimate.checksMs);
  if (!Number.isFinite(buildMs) || !Number.isFinite(checksMs)) return null;
  const at = row.checks_at || row.checks_checked_at;
  if (!at) return null;
  const elapsed = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(elapsed)) return null;
  const remaining = buildMs + checksMs - elapsed;
  if (remaining <= 0) return null;
  return { code: 'checks_running', minutes: Math.max(1, Math.ceil(remaining / 60000)) };
}

/**
 * Pure (#6616): whether a change's votes are in. The one predicate every
 * reader of `votes_in` shares — services/work-state.js's stages and the
 * Needs you feed's `authorGateMet` — so the list that leaves a vote to the
 * feed and the feed that keeps the row can never disagree. A missing answer
 * (a failed gate read) is false: the row stays a Vote.
 */
function votesIn(row) {
  return row?.votes_in === true;
}

/**
 * Pure (#6531, 11 Nov 2026): a change that conflicts with main where only a
 * yes can move it (syncStand 'vote'). It is up for a vote, and so open for
 * votes, only while it could take one (vote_open): its checks
 * passed (or had nothing to test) on the head up for a vote, it is not its
 * project's first version, and its before & after shots are not still being
 * taken. Until then it is checking: its failing checks when they fail on
 * its head (failedOnHead), else what a yes will do once it can be given.
 * `onHead` and `held` are the caller's (a request's facts row and a change's
 * name their columns differently).
 */
function yesOnlyState(row, since, { onHead, held }) {
  const passed = row.check_state === 'passing' || row.check_state === 'skipped';
  if (passed && onHead && row.first_version !== true && !held) {
    return state('up_for_vote', { since, line: { code: 'conflict_on_yes' } });
  }
  if (failedOnHead(row, onHead)) {
    const failing = Number(row.failed_checks ?? progress.failedCount(row.test_results)) || 0;
    return state('checking', { since, line: { code: 'checks_failing', ...(failing ? { failing } : {}) } });
  }
  return state('checking', { since, line: { code: 'conflict_on_yes' } });
}

/**
 * Pure: whether a change's checks failed on the head up for a vote. A
 * failing verdict about another commit (a fix the restart recovery rolled
 * back, say) is not its own: decided 19 Nov 2026, it reads as its checks
 * still to come, as a verdict of unknown or none yet on its head reads, the
 * way a pass about another commit already did (N5). `onHead` is the caller's
 * reading of the head (changeChecksOnHead).
 */
function failedOnHead(row, onHead) {
  return (row.check_state === 'failing' || row.check_state === 'error') && onHead;
}

/** The stage word plus the two lines a checking change can carry (#6402). */
function checkingState(row, since, now, onYes = changeOnYes) {
  // #6531: what a conflicting change waits on decides where it shows and
  // what it says. A yes-only conflict is up for a vote once it could take
  // one (yesOnlyState); one the lane is resolving says "Syncing with main";
  // one only its author can move keeps the old wording.
  const stand = standOf(row);
  if (stand === 'vote') return onYes(row, since, now);
  if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
  if (stand === 'author') return state('checking', { since, line: { code: 'sync_wait' } });
  // #6594: its votes are in, so its checks are what it waits on now, not a
  // vote it no longer needs.
  if (votesIn(row)) return state('checking', { since, line: { code: 'approved_checking' } });
  const line = checksLine(row, now);
  return state('checking', { since, ...(line ? { line } : {}) });
}

/**
 * Pure (#6594): a change still asking for a vote, with the line that says
 * why one is needed again when a push retired earlier yes votes.
 */
function upForVote(row, since) {
  const earlier = Number(row.earlier_yes) || 0;
  return state('up_for_vote', { since, ...(earlier > 0 ? { line: { code: 'earlier_yes', count: earlier } } : {}) });
}

/**
 * Pure (#6546): an approved change whose merge GitHub is holding, from the
 * proposal machine's mergeHeld reasons, or null. Only an approved (or
 * forced) change is ever handed to GitHub to merge, so one GitHub held is
 * going live, and its line says on what: GitHub's required checks (still
 * running, or being run again on today's main), or GitHub itself. One whose
 * required checks failed again after that is its author's (or the bot's).
 */
function githubHold(row) {
  const reasons = (Array.isArray(row?.integration_block_reasons) ? row.integration_block_reasons : []).map(String);
  // 19 Nov 2026 (Track 1, T1.7): approved, and GitHub's required checks
  // never finished or kept failing after 15 tries, so Homeroom stopped
  // asking until the change or main moves ('github_stuck', written beside
  // the hold it came from). Stuck going live, whatever that hold says.
  if (reasons.includes('github_stuck')) return { stage: 'going_live', code: 'github_stuck' };
  if (reasons.includes('github_checks_failing')) return { stage: 'checking', code: 'github_checks_failing' };
  if (reasons.includes('github_checks')) return { stage: 'going_live', code: 'github_checks' };
  if (reasons.includes('github_refused') || reasons.includes('github_busy')) return { stage: 'going_live', code: 'github_wait' };
  return null;
}

// ── A request's own step ─────────────────────────────────────────────────

// T2.2: the queue reasons a stopped build leaves its request owed by
// (src/workflow/rules/bot-loop.ts CREDIT_WAIT_REASON, PLAN_RETRY_REASON):
// the bot picks it up again by itself, so its queue row says where it is
// whatever its newest run's build left behind.
const OWED_AGAIN = new Set(['credit_wait', 'plan_retry']);

const question = (row) => state('waiting_for_you', { since: row.question_at, why: 'question' });

/**
 * Pure: a request with a queue row that has not started: on hold (the
 * week's building time: "On hold until Monday"; or, #6357, a day's pause
 * after its look threw again and again), a reply about to be read (#6228),
 * waiting for building credit (#6867: read and found ready, so Ready to
 * build, never "Not started yet"; the bot picks it up by itself), its
 * failed plan's retry (#6313, #6859), or waiting its turn.
 */
function queuedStep(row, now) {
  const since = row.enqueued_at || null;
  const hold = progress.holdOf(row, { now });
  if (hold) {
    return state('reading', {
      since, line: { code: hold.kind === 'cooldown' ? 'cooldown' : 'on_hold', ...(iso(hold.until) ? { until: iso(hold.until) } : {}) },
    });
  }
  if (progress.replyWaits(row, { now })) return state('reading', { since: row.reply_at, line: { code: 'reply', soon: true } });
  if (row.queue_reason === 'credit_wait') return state('building', { since, line: { code: 'credit_wait' } });
  if (progress.planFailed(row) || row.queue_reason === 'plan_retry') return state('planning', { since, line: { code: 'retry_plan' } });
  return state('reading', {
    since,
    line: {
      code: 'queued',
      // Its place in the bot's line on its project (REQUEST_FACTS_SQL).
      ...(row.queue_place ? { place: Number(row.queue_place) } : {}),
      // B8: somebody asked the bot for it (its page, their chat), so it is
      // the bot's already, waiting for a free builder.
      ...(row.queue_priority != null && Number(row.queue_priority) === 0 ? { asked: true } : {}),
    },
  });
}

/**
 * Pure: the bot's own step on a request that has no change of the bot's up
 * for a vote or past it, from its facts row (REQUEST_RECORD_COLUMNS), or
 * null when nothing about it is in progress. One decider in one vocabulary:
 * this was homeroom-bot-progress.js stageOf, which named some 22 stages of
 * its own that fromStage then mapped to the ten.
 */
function ownStep(row, now) {
  // #4539: the request itself was closed. Its waiting plan and the open
  // question about it no longer wait on the person, and a build not started
  // yet reads as not in progress.
  const closed = row.request_closed === true;
  // #6246 (4 Nov 2026): a plan waiting for Build it is what the person acts
  // on now, so it stays the plan whatever sits beside it: a reply the bot is
  // reading, a queue row on hold, or a question left open from before the
  // look that made it (#6219). A question the plan's own look asked still
  // wins. The Workshop reads the same wait (planWaitingSql).
  if (progress.planWaits(row)) {
    const olderQuestion = !!row.question_at && !!row.run_at && new Date(row.question_at) < new Date(row.run_at);
    if (row.question_at && !olderQuestion) return question(row);
    return state('waiting_for_you', { since: row.plan_waiting_at, why: 'plan' });
  }
  // #6228: a read under way after a person replied is reading that reply.
  if (row.started_at) {
    return state('reading', { since: row.started_at, ...(progress.replyWaits(row, { now }) ? { line: { code: 'reply' } } : {}) });
  }
  if (row.question_at && !closed) return question(row);
  // The newest look decided to build it, and nothing has finished it yet.
  if (row.mode === 'live' && row.verdict === 'ready' && row.build_ok == null && !row.run_proposal) {
    // #4539, 30 Oct 2026: on a closed request nothing waits to be built any
    // more (the bot reads open requests only). A build under way builds on.
    if (closed && !row.build_session_id) return null;
    // T2.2 (19 Nov 2026): the build stopped and left the request owed in the
    // bot's own queue (a credit wait, #6867; its plan read again, #6859):
    // that queue row is where it stands.
    if (row.queue_id && OWED_AGAIN.has(row.queue_reason)) return queuedStep(row, now);
    if (row.cap_suppressed) {
      // #6156: the project's builds are a limit of their own; its changes
      // waiting for approval and the bot's ceiling across projects are the
      // others (homeroom-bot.js SLOT_CAPS). Its place among the project's
      // requests held at the same limit (REQUEST_FACTS_SQL held_place).
      return state('building', {
        since: row.run_at,
        line: {
          code: row.cap_suppressed === 'builds_per_app' ? 'held_builds' : 'held_waiting',
          ...(Number(row.held_place) > 0 ? { position: Number(row.held_place) } : {}),
        },
      });
    }
    // B6: a first version's plan, sent to its creator, waits for Build it.
    if (row.plan_waiting_at && !row.build_waiting_at && !row.build_session_id) {
      return state('waiting_for_you', { since: row.plan_waiting_at, why: 'plan' });
    }
    // #5323: waiting its turn to be built, with its place among the
    // project's builds waiting to start.
    if (row.build_waiting_at && !row.build_session_id) {
      return state('building', { since: row.build_waiting_at, line: { code: 'queued', ...(row.build_place ? { place: Number(row.build_place) } : {}) } });
    }
    if (!row.build_session_id) {
      return now.getTime() - new Date(row.run_at).getTime() <= progress.START_GRACE_MS
        ? state('building', { since: row.run_at, line: { code: 'starting' } })
        : state('stopped', { since: row.run_at, reason: 'stalled' });
    }
    if (row.build_status === 'archived') return null;
    // A first version whose build landed and whose screens are being
    // reviewed and fixed before it is proposed (services/bot-review.js).
    if (row.review_state === 'reviewing') {
      const of = Math.max(1, Number(row.review_max_rounds) || 1);
      const round = Math.max(1, Math.min(Number(row.review_round) || 1, of));
      return state('building', { since: row.review_started_at || row.build_last_activity || null, line: { code: 'reviewing', round, of } });
    }
    if (row.build_status === 'paused' || row.build_status === 'promoted') {
      return state('building', { since: row.build_last_activity || null, line: { code: 'proposing' } });
    }
    // Building once its plan is posted, or once the build turn itself runs
    // (a plan that failed is not posted, and the build goes ahead without).
    if (row.spec_at || row.build_turn_mode === 'build') {
      return state('building', { since: row.spec_at || row.build_turn_at || row.build_started_at });
    }
    return state('planning', { since: row.build_started_at || row.run_at });
  }
  if (row.queue_id) return queuedStep(row, now);
  // #6228: a reply nobody has queued a read for yet still reads as one
  // coming, for REPLY_WAIT_MS: the bot's refresh sees it and queues it.
  if (progress.replyWaits(row, { now })) return state('reading', { since: row.reply_at, line: { code: 'reply', soon: true } });
  return null;
}

// ── A request whose change is up for a vote or past it ───────────────────

/**
 * Pure: the bot's own change of a request as CHANGE_FACTS_SQL names its
 * facts, from the request's facts row (REQUEST_RECORD_COLUMNS, which reads
 * the same change under a request's column names). The refresh hands derive
 * the change's own facts row; this is the same reading for a caller that has
 * the request's row alone.
 */
function changeOfRequest(row) {
  const failed = row.check_state === 'failing' || row.check_state === 'error';
  return {
    id: row.proposal_session_id,
    status: row.proposal_status,
    source: row.proposal_source, imported_pr_head_sha: row.imported_pr_head_sha,
    reviewed_head_sha: row.reviewed_head_sha, checks_commit_sha: row.checks_sha,
    check_state: row.check_state, check_phase: row.check_phase, checks_at: row.checks_at,
    checks_estimate: row.checks_estimate,
    failed_checks: row.failed_checks ?? (failed ? progress.failedCount(row.test_results) : null),
    merge_conflict_state: row.merge_conflict_state, integration_merges_clean: row.integration_merges_clean,
    integration_block_reasons: row.integration_block_reasons,
    shots_state: row.shots_state, shots_run_id: row.shots_run_id, shots_detail: row.shots_detail,
    shots_updated_at: row.shots_updated_at,
    first_version: row.first_version === true, votes_in: row.votes_in === true, earlier_yes: row.earlier_yes,
    flake_fixing: row.flake_fixing === true, update_coming: row.update_coming, update_failed: row.update_failed,
    // A request's row reads a merged change that is not live yet as merging,
    // and names when it went live `merged_at`.
    promoted_at: row.proposal_at, merged_at: null, live_at: row.merged_at || null,
  };
}

const CHECKS_FAILED = new Set(['failing', 'error', 'unknown']);

/**
 * Pure (review B2, 19 Nov 2026): a request whose change is up for a vote or
 * past it stands where that change stands (`change`: deriveChange of the
 * change's own facts, the one reading of what holds a vote or a merge),
 * unless Homeroom bot is doing something about it that its requester should
 * read first:
 *
 *   - its look is running on the change: fixing what its tests found, or
 *     reading the newest replies on it (Building);
 *   - a follow-up of its own waits its turn (#3734; not its failing checks,
 *     which the change's own row already says: #6545);
 *   - it asked a question that is still open, on a request still open;
 *   - it stopped at its own limit on the change's failing checks (#6284):
 *     Needs you says so, with Let it try again, rather than Checking.
 *
 * These were cases of a second decider (homeroom-bot-progress.js stageOf and
 * fromStage) that also held every rule about a change up for a vote, in
 * another order than the change's own row.
 */
function withBot(row, change) {
  const promoted = row.proposal_status === 'promoted';
  if (row.started_at) {
    return state('building', { since: row.started_at, line: { code: row.queue_reason === 'checks_failing' ? 'fixing' : 'revising' } });
  }
  if (row.queue_id && promoted && row.queue_reason !== 'checks_failing') {
    return state('building', { since: row.enqueued_at, line: { code: 'update_queued' } });
  }
  if (row.question_at && row.request_closed !== true) return question(row);
  if (promoted && row.fix_stopped === true && row.flake_fixing !== true
    && CHECKS_FAILED.has(row.check_state) && progress.checksOnHead(row)) {
    return state('stopped', { since: row.checks_at || row.proposal_at, reason: 'fix_stopped' });
  }
  return change;
}

/**
 * Pure: where a request stands, from its facts row (REQUEST_FACTS_SQL: the
 * bot's records for it, its change, its claim, a private thread holding it)
 * and, when its change is up for a vote or past it, that change's own facts
 * (`change`: CHANGE_FACTS_SQL, as the refresh reads them; read off the
 * request's row when not handed in). Never null: a request nothing is
 * happening to waits to be read.
 */
function derive(row, opts = {}) {
  const out = deriveFacts(row, opts);
  // 5 Oct 2026 (Page Turners), kept: a request filed or queued while its
  // project's first version is not live waits for it, and says so
  // (`held_first_version`, the bot's own rule: homeroom-bot.js
  // heldForFirstVersion, read by refresh).
  if (row.held_first_version === true && out.stage === 'reading' && NOT_STARTED.has(out.line?.code)) {
    return { ...out, line: { code: 'first_version_wait' } };
  }
  return out;
}

function deriveFacts(row, { now = new Date(), change = null } = {}) {
  const status = row.proposal_status || null;
  // Its change is live (REQUEST_RECORD_COLUMNS reads a merged change that is
  // not live yet as 'merging').
  if (status === 'merged') return state('live', { since: row.merged_at || row.proposal_at });
  // Its change is up for a vote or being merged: where the change stands,
  // and what the bot is doing about it.
  if (status === 'promoted' || status === 'merging') {
    return withBot(row, deriveChange(change || changeOfRequest(row), { now }));
  }
  // The bot's own step for it, when it has one.
  const out = ownStep(row, now);
  // A private thread of the requester's holds it for their plan: nothing
  // queued overtakes that until a change is up (1 Nov 2026).
  const planHeld = row.awaiting_plan === true && !status;
  const planning = (line = {}) => state('planning', {
    since: row.request_at || row.run_at, line: { code: 'planning_with_you', ...line }, whoseMove: 'requester',
  });
  if (planHeld && (!out || out.stage === 'reading')) return planning();
  // 16 Oct 2026: ready, but a person has the request now (a claim, or a
  // change of their own under way): the bot leaves it alone, so it is
  // theirs, not a wait for a slot.
  // #4190: a claim made once the bot was already on it is a person working
  // ALONGSIDE the bot, not a hold, so only an earlier claim counts here.
  const personBuilding = row.lc_by && (row.lc_status === 'active' || row.lc_status === 'paused') ? row.lc_by : null;
  const claimFirst = row.claimed_by && (!row.run_at || new Date(row.claimed_at) <= new Date(row.run_at)) ? row.claimed_by : null;
  if (out && out.stage === 'building' && READY.has(out.line?.code) && (personBuilding || claimFirst)) {
    return state('building', {
      since: personBuilding ? row.lc_last_activity_at || out.since : row.claimed_at || out.since,
      line: { code: 'claimed', by: personBuilding || claimFirst }, whoseMove: 'builder',
    });
  }
  // 13 Nov 2026: the same hold on a request that had already reached the
  // build line (its build waits its turn, or one of the project's limits
  // holds it). The lane starts no build and takes no held verdict back up
  // while the thread holds it (rules/bot-loop.ts BUILD_CANDIDATES_SQL,
  // READ_CANDIDATES_SQL), so it waits for its requester, not for a slot: it
  // read "Ready to build · Number 1 in line" beside Let the bot build it
  // now. `ready` says a build is waiting behind the hold (botWorkOf).
  if (planHeld && out && out.stage === 'building' && READY.has(out.line?.code)) return planning({ ready: true });
  if (out) return out;

  // A change somebody made for it, when Homeroom bot has none of its own:
  // that is where it stands, whatever an older look of the bot's said.
  // 19 Nov 2026: never the session of the bot's own build that came to
  // nothing (it links the request it builds: homeroom-bot-live.js), which
  // stays paused until Try again proposes it or starts over. It read as
  // Building, the builder's move, on every surface but the App tab, whose
  // own decider said Stopped (tests/first-version-finish-postgres.test.js);
  // its run says what came of it (handedBack, below).
  const ownStoppedBuild = row.build_ok === false && Number(row.lc_id) > 0 && Number(row.lc_id) === Number(row.build_session_id);
  // T2.1 (19 Nov 2026): the bot's own change is no longer open (closed, or
  // taken back to Underway) while a person's change is: the person's change
  // is where it stands. It was skipped whenever the bot's newest proposal had
  // any status at all, so a request whose bot change was closed read "Not
  // started yet" beside somebody's change up for a vote. Without a status
  // the change is anybody's, as before; with one, only a person's (its
  // author named) or the bot's own change itself, taken back to Underway.
  const botChangeOpen = status === 'promoted' || status === 'merging' || status === 'merged';
  const theirs = !status || !!row.lc_by || (Number(row.lc_id) > 0 && Number(row.lc_id) === Number(row.proposal_session_id));
  if (!botChangeOpen && row.lc_status && !ownStoppedBuild && theirs) {
    // The change's own facts when refresh read them (CHANGE_FACTS_SQL: its
    // checks' head, its shots, an update on its way), so the request and
    // the change's own row read one stage; else the columns of the facts row.
    const change = deriveChange(row.lc_facts || {
      status: row.lc_status, check_state: row.lc_check_state, checks_at: row.lc_checks_at,
      check_phase: row.lc_check_phase, merge_conflict_state: row.lc_merge_conflict_state,
      integration_merges_clean: row.lc_integration_merges_clean,
      integration_block_reasons: row.lc_integration_block_reasons,
      checks_estimate: row.checks_estimate,
      votes_in: row.lc_votes_in === true, earlier_yes: row.lc_earlier_yes,
      promoted_at: row.lc_promoted_at, merged_at: row.lc_merged_at, live_at: row.lc_live_at,
      last_activity_at: row.lc_last_activity_at, created_at: row.lc_created_at,
      // #6282: an update on its way holds its vote too. #6600: and a
      // takeover whose last attempt failed says so.
      update_coming: row.lc_update_coming, update_failed: row.lc_update_failed,
      // #6807: it waits on a fix for a check that is not its own.
      flake_fixing: row.lc_flake_fixing === true,
    }, { now });
    // Somebody is building it: who, as a claim says it.
    if ((row.lc_status === 'active' || row.lc_status === 'paused') && row.lc_by) {
      return state('building', { since: change.since, line: { code: 'claimed', by: row.lc_by }, whoseMove: 'builder' });
    }
    // deriveChange read an update on its way and a failed takeover already
    // (withUpdate, #6282, #6600).
    return change;
  }

  // T2.9 (19 Nov 2026): its plan could not be written and the bot reads it
  // again by itself, its retry not queued yet: it is the plan being tried
  // again, as it reads once the retry is queued, never a stop for a moment.
  if (progress.planRetryOwed(row, { now })) return state('planning', { since: row.run_at, line: { code: 'retry_plan' } });
  // Nothing in progress: what its newest look came to.
  const back = progress.handedBack(row);
  const reason = row.run_reason ? firstSentence(row.run_reason, 140) : null;
  const said = reason ? { line: { code: 'reason', text: reason } } : {};
  // Somebody took a hand-back up since (a claim): it is being built.
  if (back && row.claimed_by) return state('building', { since: row.claimed_at, line: { code: 'claimed', by: row.claimed_by }, whoseMove: 'builder' });
  if (back === 'already_works') return state('waiting_for_you', { since: row.run_at, why: 'already_works', ...said });
  if (back === 'decide') return state('waiting_for_you', { since: row.run_at, why: 'decide', ...said });
  if (back === 'build_stopped') return state('stopped', { since: row.run_at, reason: 'build_failed' });
  if (row.request_closed === true) return state('closed', { since: row.closed_at || row.run_at });
  if (row.mode === 'live' && (row.verdict === 'empty' || /^blocked:/.test(String(row.build_error || '')))) {
    return state('waiting_for_you', { since: row.run_at, why: 'needs_detail', ...said });
  }
  if (row.mode === 'live' && row.verdict === 'failed') return state('stopped', { since: row.run_at, reason: 'look_failed' });
  // Its newest look asked a question (in the request's thread, or a DM
  // question since closed), and nothing has answered it: still theirs.
  if (row.mode === 'live' && row.verdict === 'question') return state('waiting_for_you', { since: row.run_at, why: 'question' });
  if (row.claimed_by) return state('building', { since: row.claimed_at, line: { code: 'claimed', by: row.claimed_by }, whoseMove: 'builder' });
  // T2.1 (19 Nov 2026): the change the bot built for it was closed (a
  // change session's closed status is 'archived': a stale change set aside,
  // one withdrawn or voted down) while the request stays open, and nothing
  // newer happened to it: its newest look is the one that proposed that
  // change. This test read 'closed', which no change session ever is, so
  // the request read "Not started yet" and a first version showed the
  // starter app. A newer look (a question, a hand-back, a build) decides
  // above; a person's change for it, before.
  if (status === 'archived' && Number(row.proposal_session_id) > 0
    && Number(row.run_proposal) === Number(row.proposal_session_id)) {
    return state('stopped', { since: row.proposal_closed_at || row.proposal_at, reason: 'change_closed' });
  }
  // The bot's change taken back to Underway (unpromoted) with nobody's
  // change for it: it is being worked on again, not waiting to be read.
  if ((status === 'active' || status === 'paused') && Number(row.run_proposal) === Number(row.proposal_session_id)) {
    return state('building', { since: row.proposal_at, whoseMove: 'builder' });
  }
  // Not read yet, or read and nothing came of it (a skip): it waits to be read.
  return state('reading', { since: row.request_at || row.run_at, line: { code: 'waiting' } });
}

/**
 * Pure (#6282, #6545, #6600): how an update on its way, or a takeover whose
 * last attempt failed, changes a change's state. `coming` is 'running' |
 * 'queued' | null (homeroom-bot-progress.js updateComingSql) and `failed`
 * is why its newest takeover look failed, if it did (updateFailedSql).
 *
 * A running update holds a vote and a checking change as Building: a
 * takeover on a change whose checks failed says "Fixing what its tests
 * found", the words a fix of the bot's own already uses, and any other
 * says it is being updated. A queued one holds only a vote (it waits its
 * turn, the bot's to start), and a change still checking (a fix waiting its
 * turn) stays Checking until the update starts. 11 Nov 2026: never up for a
 * vote while it comes, so a stage of up_for_vote is always a change open
 * for votes (vote_open). A takeover whose last attempt failed leaves its
 * change Checking, its line saying Homeroom bot could not fix it.
 */
function withUpdate(change, { coming = null, failed = null } = {}) {
  if (!change) return change;
  const failing = change.stage === 'checking'
    && (change.line?.code === 'checks_failing' || change.line?.code === 'github_checks_failing');
  if (coming === 'running') {
    if (change.stage === 'checking' || change.stage === 'up_for_vote') {
      return state('building', { since: change.since, line: { code: failing ? 'fixing' : 'revising' } });
    }
    return change;
  }
  if (coming === 'queued' && change.stage === 'up_for_vote') {
    return state('building', { since: change.since, line: { code: 'update_queued' } });
  }
  if (!coming && failed && failing) return { ...change, line: { code: 'bot_fix_failed' } };
  return change;
}

/** Pure: the head a change's votes and checks are about (progress.checksOnHead's reading). */
function changeHead(row) {
  return (row?.source === 'imported' ? row?.imported_pr_head_sha : row?.reviewed_head_sha) || row?.checks_commit_sha || null;
}

/**
 * Pure (#6528): whether a change's before & after shots still hold its
 * vote, by the bot's own readiness rule (bot-readiness.ts heldUntil, with
 * its 45-minute lapse when no settle ever comes).
 */
function shotsHeld(row, now = new Date()) {
  if (!row || !row.shots_detail) return false;
  return heldUntil({
    shots_state: row.shots_state, shots_run_id: row.shots_run_id, shots_detail: row.shots_detail,
    shots_updated_at: row.shots_updated_at, checks_checked_at: row.checks_at,
  }, changeHead(row), now.getTime()) != null;
}

/** Pure: whether a change's check verdict is about the head up for a vote (progress.checksOnHead). */
function changeChecksOnHead(row) {
  return progress.checksOnHead({
    proposal_source: row?.source, imported_pr_head_sha: row?.imported_pr_head_sha,
    reviewed_head_sha: row?.reviewed_head_sha, checks_sha: row?.checks_commit_sha,
  });
}

/**
 * Pure: where a change stands, from its own facts (CHANGE_FACTS_SQL; a
 * request's change, or one with no request of its own). Up for a vote only
 * when it is open for votes (voteOpen): its checks passed on its head, it
 * merges cleanly (or only a yes can move it), GitHub is not holding an
 * approved merge, it is not its project's first version, no update is on
 * its way, and its before & after shots are not still being taken.
 */
function deriveChange(row, { now = new Date() } = {}) {
  const status = row.status || null;
  if (status === 'merged') {
    return row.live_at ? state('live', { since: row.live_at }) : state('going_live', { since: row.merged_at });
  }
  if (status === 'merging') return state('going_live', { since: row.promoted_at });
  if (status === 'closed' || status === 'archived') return state('closed', { since: row.last_activity_at || row.promoted_at });
  if (status === 'promoted') return withUpdate(promotedChange(row, now), { coming: row.update_coming, failed: row.update_failed });
  void now;
  return state('building', { since: row.last_activity_at || row.created_at, whoseMove: 'builder' });
}

/**
 * Pure (#6821, 18 Nov 2026): what a change that does not merge cleanly waits
 * on, once its votes are in. `awaiting_approval` stays stored until the merge
 * queue measures the change again, so a change whose yes votes are in read as
 * "only a yes can move it" (syncStand 'vote', and so up_for_vote) while its
 * page, which reads the live merge gate, said Approved and syncing with main.
 * That gate already ignores the reason once the votes are in (routes/votes.js
 * merge gate), so the derivation does too: the stand is what the remaining
 * reasons say, and an approved change catching up with main is syncing.
 */
function standOf(row) {
  const stand = syncStand(row);
  if (stand !== 'vote' || !votesIn(row)) return stand;
  const reasons = (Array.isArray(row?.integration_block_reasons) ? row.integration_block_reasons : []).map(String);
  if (!reasons.includes('awaiting_approval')) return stand;
  return syncStand({ ...row, integration_block_reasons: reasons.filter((r) => r !== 'awaiting_approval') });
}

/** Pure: a change's own facts row that waits only for a yes on a conflict (yesOnlyState). */
function changeOnYes(row, since, now) {
  return yesOnlyState(row, since, { onHead: changeChecksOnHead(row), held: shotsHeld(row, now) });
}

function promotedChange(row, now) {
  const since = row.checks_at || row.promoted_at;
  // #6531: a conflicting change is where its conflict stand puts it, before
  // its stale verdict is read as final: only a yes can move it (vote, once
  // it could take one: yesOnlyState), the lane is catching it up (syncing),
  // or it is its author's (author).
  const stand = standOf(row);
  if (stand === 'vote') return changeOnYes(row, since, now);
  if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
  if (stand === 'author') {
    const failed = failedOnHead(row, changeChecksOnHead(row));
    return state('checking', { since, line: { code: failed ? 'checks_failing' : 'sync_wait' } });
  }
  // #6546: approved, and GitHub is holding its merge: going live (or its
  // author's again, when GitHub's own checks fail), never up for a vote.
  const hold = githubHold(row);
  if (hold) return state(hold.stage, { since: row.promoted_at, line: { code: hold.code } });
  if (row.check_state !== 'passing' && row.check_state !== 'skipped') {
    // Decided 19 Nov 2026: a failing verdict about another commit than the
    // one up for a vote is not its failure; it reads as checks still to come.
    const failing = failedOnHead(row, changeChecksOnHead(row));
    if (failing && row.flake_fixing === true) {
      // #6807: it fails a check that is not its own, and the fix for that
      // check is under way: the bot is working, not the change's author.
      return state('checking', { since, line: { code: 'fixing_check' } });
    }
    if (failing) {
      const count = Number(row.failed_checks) || 0;
      return state('checking', { since, line: { code: 'checks_failing', ...(count ? { failing: count } : {}) } });
    }
    // #6402: deferred or conflicting heads wait to sync with main; a run in
    // flight says about how long it has left.
    return checkingState(row, since, now, changeOnYes);
  }
  // N5: a verdict about another commit than the one up for a vote says
  // nothing about it: its own checks are still to come. #6594: with its
  // votes in, it is approved and those checks are what it waits on.
  if (!changeChecksOnHead(row)) {
    return state('checking', { since, ...(votesIn(row) ? { line: { code: 'approved_checking' } } : {}) });
  }
  // A passing change that has since stopped merging cleanly moves back to
  // Waiting to sync with main: its verdict no longer describes what lands.
  if (syncWaits(row)) return state('checking', { since, line: { code: 'sync_wait' } });
  // #6528: its before & after shots are still being taken. T2.12 (19 Nov
  // 2026): a first version's too: it read Going live while its App tab,
  // which waited for the same shots, said Testing. (Review A3: the App tab
  // and the ready card read this row now.)
  if (shotsHeld(row, now)) return state('checking', { since, line: { code: 'shots' } });
  // D1: a project's first version goes live without a vote.
  if (row.first_version === true) return state('going_live', { since: row.promoted_at, line: { code: 'first_version' } });
  // #6594: its votes are in (the project's rule would let it merge now): it
  // is being merged, not voted on, so it is not open for votes either.
  if (votesIn(row)) return state('going_live', { since: row.promoted_at });
  return upForVote(row, row.promoted_at);
}

// ── When an item moves by time alone (T2.7) ─────────────────────────────

// Which derive wrote a row (`standing.v`). A row an older derive wrote has no
// due time of its own, so the sweep reads those too, a few a minute, until
// every open row is derived again. Bump it when the derive changes what a
// row says without a write that marks it.
const DERIVE_VERSION = 3;

// How long an update on its way holds before its windows are read again
// (progress.updateComingSql: a taken ask or a turn marker lapses in hours).
const UPDATE_RECHECK_MS = 60 * 60 * 1000;
// A running checks estimate counts down by the minute.
const CHECKS_RECHECK_MS = 60 * 1000;
// Never sooner than this from the derive: a due already past is read again
// on the sweep's next pass, not in a loop.
const DUE_FLOOR_MS = 30 * 1000;

/**
 * Pure (T2.7, 19 Nov 2026): when an item's state next moves by time alone,
 * with nothing written, as an ISO time, or null when it moves only by its
 * records (which mark it: work_state_dirty). Stored with the row
 * (`standing.dueAt`), so the sweep reads exactly the rows that are due
 * instead of every open row forever.
 *
 *   - a build found ready that has not started stalls (START_GRACE_MS);
 *   - a reply nobody has queued a read for stops reading as one coming
 *     (REPLY_WAIT_MS);
 *   - a hold ends (`until`); a claim lapses (CLAIM_DAYS);
 *   - a failed plan's retry not queued in time is stopped (PLAN_RETRY_GRACE_MS);
 *   - a change's before & after shots stop holding its vote (heldUntil's
 *     45 minutes), an update on its way is read again within the hour, and a
 *     run's "About N min left" counts down by the minute;
 *   - an open card expires.
 *
 * `row` is a request's facts row (REQUEST_FACTS_SQL), `change` the change's
 * facts (CHANGE_FACTS_SQL: a request's lead change, or the change itself).
 */
function dueOf({ state: st, row = null, change = null, offers = [], now = new Date() } = {}) {
  if (!st || st.stage === 'closed') return null;
  const t = now.getTime();
  const dues = [];
  const at = (ms) => { if (Number.isFinite(ms)) dues.push(ms); };
  const when = (v) => (v ? Date.parse(v instanceof Date ? v.toISOString() : String(v)) : NaN);
  const code = st.line && st.line.code;
  if (row) {
    if (st.stage === 'building' && code === 'starting') at(when(row.run_at) + progress.START_GRACE_MS);
    if (st.stage === 'reading' && code === 'reply' && st.line.soon && !row.queue_id) at(when(row.reply_at) + progress.REPLY_WAIT_MS);
    if (code === 'claimed' && row.claimed_by && st.line.by === row.claimed_by) at(when(row.claimed_at) + CLAIM_DAYS * DAY_MS);
    if (st.stage === 'planning' && code === 'retry_plan' && !row.queue_id) {
      at(when(row.build_last_activity || row.run_at) + progress.PLAN_RETRY_GRACE_MS);
    }
    if (row.proposal_status === 'promoted') {
      const held = row.shots_detail ? heldUntil({
        shots_state: row.shots_state, shots_run_id: row.shots_run_id, shots_detail: row.shots_detail,
        shots_updated_at: row.shots_updated_at, checks_checked_at: row.checks_at,
      }, (row.proposal_source === 'imported' ? row.imported_pr_head_sha : row.reviewed_head_sha) || row.checks_sha, t) : null;
      if (held != null) at(held + 1000);
      if (row.update_coming === 'running' || row.update_coming === 'queued') at(t + UPDATE_RECHECK_MS);
    }
  }
  if (code === 'on_hold' || code === 'cooldown') at(when(st.line.until) + 1000);
  if (code === 'checks_running') at(t + CHECKS_RECHECK_MS);
  if (change && change.status === 'promoted') {
    const held = change.shots_detail ? heldUntil({
      shots_state: change.shots_state, shots_run_id: change.shots_run_id, shots_detail: change.shots_detail,
      shots_updated_at: change.shots_updated_at, checks_checked_at: change.checks_at,
    }, changeHead(change), t) : null;
    if (held != null) at(held + 1000);
    if (change.update_coming === 'running' || change.update_coming === 'queued') at(t + UPDATE_RECHECK_MS);
  }
  for (const o of Array.isArray(offers) ? offers : []) at(when(o && o.expiresAt) + 1000);
  if (!dues.length) return null;
  return new Date(Math.max(Math.min(...dues), t + DUE_FLOOR_MS)).toISOString();
}

/** Pure: whether a change is open for votes now (work_states.vote_open): its stage is up for a vote. */
function voteOpenOf(changeState) {
  return !!changeState && changeState.stage === 'up_for_vote';
}

/**
 * Pure: where an item goes for one viewer, or null when it is not theirs to
 * see in these lists. `viewer` says how they stand to it: `requester` (it is
 * theirs, or they decide on its project), `voteOwed` (they still owe a vote,
 * which the Needs you feed lists as Vote), `own` (they asked for it, built it
 * or follow it).
 */
function placeFor(item, viewer = {}) {
  if (!item) return null;
  const mine = !!viewer.requester;
  const own = mine || !!viewer.own;
  const listed = stages.STAGE[item.stage] ? stages.STAGE[item.stage].listed : 'next';
  switch (listed) {
    case 'needs':
      return mine ? 'needs' : own ? 'waiting' : null;
    case 'vote':
      if (viewer.voteOwed) return null; // the feed's Vote row
      return own ? 'waiting' : null;
    case 'live': {
      const at = item.since ? new Date(item.since).getTime() : 0;
      return own && (!at || Date.now() - at <= LIVE_DAYS * DAY_MS) ? 'live' : null;
    }
    case null:
      return null;
    default:
      if (!own) return null;
      // Waiting its turn, or held: Waiting. Under way: In progress.
      return listed === 'waiting' || stages.LISTED_WAITING.has(item.line && item.line.code) ? 'waiting' : 'next';
  }
}

/**
 * Pure: the moment a change of stage rings the requester's bell, or null.
 * Into waiting_for_you: needs you; up_for_vote: ready to vote; stopped:
 * stopped; live: live. A row that only moved its line rings nothing.
 */
const queuedUpdate = (item) => !!item && item.stage === 'building' && item.line?.code === 'update_queued';

function bellOf(prev, next) {
  if (!next) return null;
  const same = prev && prev.stage === next.stage && (prev.why || null) === (next.why || null)
    && (prev.reason || null) === (next.reason || null);
  if (same) return null;
  const bell = (stages.STAGE[next.stage] && stages.STAGE[next.stage].bell) || null;
  // An update that was only queued and never started took nothing back:
  // its "ready to try" still stands (withdrawReady), so it rings no other.
  if (bell === 'ready') return prev && (prev.stage === 'up_for_vote' || queuedUpdate(prev)) ? null : 'ready';
  return bell;
}

// ── Words ────────────────────────────────────────────────────────────────

// 11 Nov 2026: the stage, why, reason and line of an item map to the phrase
// ids of frontend/locales/en/core.json's work.* entries here, once. The map
// ships with every row (`words`: fromRow, the push, a request's standing),
// so every screen draws the same words and no client keeps a table of its
// own; the server's own English (Homeroom bot's answers, the bell) reads
// the same catalog through push-text.js.

// A request in the reading stage nobody has started on yet, and one ready to
// build that waits (its turn, a limit, building credit: T2.2), are said so:
// the same stages, in plainer words (work-stages.json `notStarted`, `ready`).
const { NOT_STARTED, READY } = stages;

const camel = (s) => String(s).replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

// T2.10, T2.11 (19 Nov 2026): the hand-backs that are not their requester's
// own decision, and a build found impossible as written, by the cause the
// one decoder stored (bot-stop-cause.js): their words say who or what they
// wait on (work.handBack.*, work.handBackOthers.*), never "Waiting for you to
// decide" to a requester who does not decide it.
const HAND_BACK_WORDS = new Set(['others', 'operator_work', 'destructive_db', 'platform', 'other_project', 'wrong_project', 'close']);

/** Pure: an item's stored cause and the names it carries (its standing's, or a shaped row's own). */
function causeOfItem(item) {
  const standing = item && item.standing && typeof item.standing === 'object' ? item.standing : null;
  const cause = (item && item.cause) || (standing && standing.cause) || null;
  const names = (item && Array.isArray(item.causeNames) && item.causeNames.length ? item.causeNames : null)
    || (standing && Array.isArray(standing.causeNames) ? standing.causeNames : []);
  return { cause, names };
}

/** Pure: the stage's phrase, as its requester reads it (`yours`) or as anyone else does. */
function stagePhrase(item, yours) {
  const { cause, names } = causeOfItem(item);
  if (item.stage === 'waiting_for_you' && item.why === 'decide' && HAND_BACK_WORDS.has(cause)) {
    const at = `core:work.${yours ? 'handBack' : 'handBackOthers'}`;
    if (cause === 'others') {
      return names.length === 1 ? { id: `${at}.others`, values: { username: String(names[0]) } } : { id: `${at}.othersMany` };
    }
    return { id: `${at}.${camel(cause)}` };
  }
  if (item.stage === 'waiting_for_you' && item.why === 'needs_detail' && cause === 'blocked') {
    return { id: `core:work.${yours ? 'handBack' : 'handBackOthers'}.blocked` };
  }
  if (item.stage === 'waiting_for_you' && item.why && WHYS.includes(item.why)) {
    return { id: yours ? stages.WHY[item.why].phrase : stages.WHY[item.why].phraseOthers };
  }
  // T2.9: a build a person stopped, and a plan that could not be written,
  // say so in the stage word itself.
  if (item.stage === 'stopped' && item.reason === 'build_failed' && cause === 'stopped' && names.length) {
    return { id: 'core:work.reason.stoppedBy', values: { username: String(names[0]) } };
  }
  if (item.stage === 'stopped' && item.reason === 'build_failed' && cause === 'plan') return { id: 'core:work.reason.planFailed' };
  if (item.stage === 'stopped' && item.reason && REASONS.includes(item.reason)) return { id: stages.REASON[item.reason].phrase };
  // The stage's own word, unless its line replaces it (work-stages.json
  // `stageWord`): a conflicting change the lane is catching up says "Syncing
  // with main" (#6531); one with only its before & after screenshots left,
  // "Taking screenshots"; one whose failing check is being fixed for it,
  // "Fixing" (#6807); an approved change GitHub holds says Approved (#6563,
  // #6594), "Waiting to merge" or Stuck (T1.7); a request nobody has started
  // on, "Not started yet"; a build that waits, "Ready to build".
  return { id: stages.stageWordOf(item.stage, item.line && item.line.code) };
}

/** Pure: the second line's phrase, or null when it has none. */
function linePhrase(item) {
  return stages.linePhraseOf(item && item.line);
}

/**
 * Pure: an item's words, as phrase ids of the core catalog: its stage as
 * its requester reads it (`stage`) and as anyone else does (`stageOthers`),
 * and its second line (`line`, or null).
 */
function phrasesOf(item) {
  if (!item || !item.stage) return null;
  return { stage: stagePhrase(item, true), stageOthers: stagePhrase(item, false), line: linePhrase(item) };
}

let englishCatalog = null;
/** Pure: a phrase in English, from the core catalog (push-text.js reads it in a checkout and in the image). */
function english(phrase) {
  if (!phrase || !phrase.id) return '';
  if (!englishCatalog) {
    const pushText = require('./push-text');
    englishCatalog = pushText.englishFrom(pushText.englishTexts(null, 'core'));
  }
  return englishCatalog(phrase.id, phrase.values);
}

/** Pure: the stage's words in English, as the screens say them (phrasesOf). */
function stageSays(item, { yours = true } = {}) {
  const words = phrasesOf(item);
  return words ? english(yours ? words.stage : words.stageOthers) : '';
}

/** Pure: the second line in English, or null. */
function lineSays(item) {
  const line = linePhrase(item);
  return line ? english(line) || null : null;
}

// The second lines of the bot's stages that say it waits rather than works.
const { WAITING_LINES } = stages;

/**
 * Pure: whether Homeroom bot is at an item this minute: reading it,
 * planning it or building it, not waiting its turn, a hold, or a person.
 */
function busyNow(item) {
  if (!item || item.whoseMove !== 'bot') return false;
  if (!stages.STAGE[item.stage] || stages.STAGE[item.stage].works !== true) return false;
  const code = item.line && item.line.code;
  if (code === 'reply' && item.line.soon) return false;
  return !WAITING_LINES.has(code);
}

// What the Homeroom bot is reading or building on a request (`bot`: { what,
// since, plan?, held?, turn? }, or null), as a request's page and Ask
// Homeroom bot to build this read it before they read the standing: read
// off the same row, so the two never disagree.
// (work-stages.json `bot`: a request waiting its turn is the bot's only when
// somebody asked it for it; one held for its requester's plan only when a
// build already waits behind the hold, so asking again is refused; a build
// held at a limit or waiting for credit is in its queue; one a person has
// is not the bot's.)
function botWorkOf(item) {
  if (!item) return null;
  const since = item.since || null;
  if (item.stage === 'building' && item.whoseMove === 'builder') return null;
  const work = stages.botOf(item.stage, item.line || null, item.why || null);
  if (!work) return null;
  const { what, ...more } = work;
  return { what, since, ...more };
}

/** Pure: the stage and its second line in one English phrase ("Building · Starting"). */
function says(item, opts) {
  const line = lineSays(item);
  return line ? `${stageSays(item, opts)} · ${line}` : stageSays(item, opts);
}

// ── Reading the facts ─────────────────────────────────────────────────────

/**
 * One row per request named by ($1 app ids, $2 numbers), with every record
 * derive reads: the same per-request record the bot page and a request's
 * track read (homeroom-bot-progress.js requestRecordJoinsSql), its request's
 * own state, its requester, a claim on it, a private thread holding it for
 * the requester's plan, an update on its way, and its place in the bot's
 * line on its project.
 */
const REQUEST_FACTS_SQL = `
  WITH it AS (
    SELECT DISTINCT x.app_id, x.issue_number
      FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
  )
  SELECT it.app_id, it.issue_number,
         (SELECT a.slug FROM apps a WHERE a.id = it.app_id) AS app_slug,
         rq.user_id AS requester_id,
         COALESCE(rq.first_version, FALSE) AS first_version,
         iss.created_at AS request_at,
         (SELECT cr.closed_at FROM homeroom_bot_closed_requests cr
           WHERE cr.app_id = it.app_id AND cr.issue_number = it.issue_number) AS closed_at,
         ${progress.REQUEST_RECORD_COLUMNS},
         ${progress.requestClosedSql({ appId: 'it.app_id', issueNumber: 'it.issue_number' })} AS request_closed,
         cl.username AS claimed_by, cl.claimed_at,
         ${require('../workflow/rules/bot-loop.ts').planHoldSql('it.app_id', 'it.issue_number', 'NULL::int')} AS awaiting_plan,
         CASE WHEN cs.id IS NULL THEN NULL ELSE ${progress.updateComingSql('cs')} END AS update_coming,
         lc.id AS lc_id, lc.status AS lc_status, lc.check_state AS lc_check_state, lc.checks_checked_at AS lc_checks_at,
         lc.check_phase AS lc_check_phase, lc.merge_conflict_state AS lc_merge_conflict_state,
         lc.integration_merges_clean AS lc_integration_merges_clean, lc.integration_block_reasons AS lc_integration_block_reasons,
         lc.promoted_at AS lc_promoted_at, lc.merged_at AS lc_merged_at, lc.live_at AS lc_live_at,
         lc.last_activity_at AS lc_last_activity_at, lc.created_at AS lc_created_at, lc.update_coming AS lc_update_coming,
         lc.update_failed AS lc_update_failed,
         -- #6807: the lead change's open wait on a fix for a check that is not its own.
         ${flaky.flakeFixingSql('lc.id')} AS lc_flake_fixing,
         lc.username AS lc_by, q.priority AS queue_priority,
         -- #5323: a ready request's place among the project's builds waiting to start.
         CASE WHEN run.live_build_waiting_at IS NOT NULL AND run.build_session_id IS NULL THEN (
           SELECT COUNT(*)::int FROM homeroom_bot_runs b
            WHERE b.app_id = it.app_id AND b.mode = 'live' AND b.live_build_waiting_at IS NOT NULL
              AND b.build_session_id IS NULL AND b.build_ok IS NULL AND b.proposal_session_id IS NULL
              AND b.live_build_waiting_at <= run.live_build_waiting_at
              AND b.id = (SELECT MAX(b2.id) FROM homeroom_bot_runs b2
                           WHERE b2.app_id = b.app_id AND b2.issue_number = b.issue_number AND b2.mode = 'live')
         ) END AS build_place,
         CASE WHEN q.id IS NOT NULL AND q.started_at IS NULL THEN (
           SELECT COUNT(*)::int FROM homeroom_bot_queue q2
            WHERE q2.app_id = it.app_id AND q2.started_at IS NULL AND q2.enqueued_at <= q.enqueued_at
         ) END AS queue_place,
         -- A held request's place among the project's requests held at the
         -- same limit, in the order the bot takes them back up (oldest hold
         -- first), counting only open ones: its track's "3rd in line".
         CASE WHEN run.cap_suppressed IS NOT NULL THEN (
           SELECT COUNT(*)::int FROM (
             SELECT DISTINCT ON (h.issue_number) h.issue_number, h.cap_suppressed, h.created_at
               FROM homeroom_bot_runs h
              WHERE h.app_id = it.app_id AND h.mode = 'live'
              ORDER BY h.issue_number, h.id DESC
           ) hq
            WHERE hq.cap_suppressed = run.cap_suppressed
              AND (hq.created_at < run.created_at OR (hq.created_at = run.created_at AND hq.issue_number <= it.issue_number))
              AND NOT ${progress.requestClosedSql({ appId: 'it.app_id', issueNumber: 'hq.issue_number' })}
         ) END AS held_place
    FROM it
    LEFT JOIN homeroom_bot_requesters rq ON rq.app_id = it.app_id AND rq.issue_number = it.issue_number
    LEFT JOIN LATERAL (
      SELECT i.created_at FROM issues i
       WHERE i.app_id = it.app_id AND i.github_issue_number = it.issue_number
       ORDER BY i.id DESC LIMIT 1
    ) iss ON TRUE
    ${progress.requestRecordJoinsSql({ appId: 'it.app_id', issueNumber: 'it.issue_number' })}
    LEFT JOIN LATERAL (
      SELECT u.username, ic.claimed_at
        FROM issue_claims ic JOIN users u ON u.id = ic.user_id
       WHERE ic.app_id = it.app_id AND ic.github_issue_number = it.issue_number
         AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
         AND u.is_synthetic IS NOT TRUE
       ORDER BY ic.claimed_at DESC
       LIMIT 1
    ) cl ON TRUE
    -- The change somebody made for it (it says it closes it): what it
    -- stands at when Homeroom bot has no change of its own for it, and a
    -- person's under way holds the bot off as the bot itself reads it
    -- (homeroom-bot.js issueHolders). A posted plan is no change.
    LEFT JOIN LATERAL (
      SELECT c.id, c.status, c.check_state, c.checks_checked_at, c.check_phase,
             c.merge_conflict_state, c.integration_merges_clean, c.integration_block_reasons, c.promoted_at, c.merged_at, c.live_at,
             c.last_activity_at, c.created_at,
             (SELECT u.username FROM users u WHERE u.id = c.user_id AND u.is_synthetic IS NOT TRUE) AS username,
             CASE WHEN c.status = 'promoted' THEN ${progress.updateComingSql('c')} END AS update_coming,
             CASE WHEN c.status = 'promoted' THEN ${progress.updateFailedSql('c')} END AS update_failed
        FROM chat_sessions c
       WHERE c.app_id = it.app_id AND it.issue_number = ANY(c.linked_issues)
         AND c.is_headless = FALSE
         AND NOT ${planRecordSql('c')}
         AND c.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       ORDER BY CASE c.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END, c.id DESC
       LIMIT 1
    ) lc ON TRUE`;

// The checks of a change's newest verdict that did not pass (progress.js
// failedCount, in SQL).
const FAILED_CHECKS_SQL = (cs) => `(SELECT COUNT(*)::int
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${cs}.test_results) = 'array' THEN ${cs}.test_results ELSE '[]'::jsonb END) t
    WHERE COALESCE(t->>'status', '') NOT IN ('', 'pass'))`;

/**
 * One row per change named by $1 (session ids): what its stage and its
 * standing read (its checks and their head, what holds its vote or its
 * merge, an update on its way, its votes this round), and whether it is
 * about requests of its own (`has_requests`).
 */
const CHANGE_FACTS_SQL = `
  SELECT cs.id, cs.app_id, (SELECT a.slug FROM apps a WHERE a.id = cs.app_id) AS app_slug, cs.user_id, cs.status,
         cs.pr_number, cs.is_headless, cs.check_state, cs.checks_checked_at AS checks_at,
         cs.check_phase, cs.merge_conflict_state, cs.integration_merges_clean, cs.integration_block_reasons,
         cs.promoted_at, cs.merged_at, cs.live_at, cs.created_at, cs.last_activity_at,
         cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha, cs.checks_commit_sha,
         cs.shots_state, cs.shots_run_id, cs.shots_detail, cs.shots_updated_at,
         CASE WHEN cs.check_state IN ('failing', 'error') THEN ${FAILED_CHECKS_SQL('cs')} END AS failed_checks,
         ${firstVersionSql('cs')} AS first_version,
         CASE WHEN cs.status = 'promoted' THEN ${progress.updateComingSql('cs')} END AS update_coming,
         -- #6600: why a takeover's last attempt failed, when it did.
         CASE WHEN cs.status = 'promoted' THEN ${progress.updateFailedSql('cs')} END AS update_failed,
         -- #6807: an open wait on a fix for a check that is not this change's.
         ${flaky.flakeFixingSql('cs.id')} AS flake_fixing,
         (SELECT COUNT(*) FILTER (WHERE pv.vote = 'yes') FROM pr_votes pv
           WHERE pv.session_id = cs.id AND ${currentVotePredicateSql('pv', 'cs')})::int AS votes_yes,
         (SELECT COUNT(*) FILTER (WHERE pv.vote = 'no') FROM pr_votes pv
           WHERE pv.session_id = cs.id AND ${currentVotePredicateSql('pv', 'cs')})::int AS votes_no,
         -- Each run column on its own index (one OR would read every run).
         (cardinality(COALESCE(cs.linked_issues, '{}'::int[])) > 0
          OR EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.proposal_session_id = cs.id)
          OR EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.build_session_id = cs.id)) AS has_requests,
         -- Its open cards (one of Homeroom bot's offers on it).
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'expiresAt', c.expires_at) ORDER BY c.id)
                     FROM bot_cards c
                    WHERE c.status = 'open' AND c.expires_at > NOW()
                      AND (c.session_id = cs.id OR (c.args->>'sessionId') = cs.id::text)), '[]'::jsonb) AS offers
    FROM chat_sessions cs
   WHERE cs.id = ANY($1::int[])`;

/**
 * What is asked of each request's requester and what Homeroom bot last said
 * about it, one row per request named by ($1 app ids, $2 numbers): the
 * bot's open question, its newest plan, an open vote to close it, a private
 * thread holding it for its requester's plan, its open cards (and a
 * thread's offers from before the card store), the reports filed from it,
 * and the bot's newest post about it.
 */
const STANDING_SQL = `
  WITH it AS (
    SELECT DISTINCT x.app_id, x.issue_number
      FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
  )
  SELECT it.app_id, it.issue_number,
         oq.message_id AS question_id, oq.created_at AS question_at,
         pl.session_id AS plan_session_id, pl.version AS plan_version, pl.created_at AS plan_at,
         cv.id AS close_id, cv.yes AS close_yes, cv.no AS close_no,
         dr.id AS draft_id,
         COALESCE((SELECT jsonb_agg(o ORDER BY o->>'id') FROM (
             SELECT jsonb_build_object('id', c.id, 'kind', c.kind, 'expiresAt', c.expires_at) AS o
               FROM bot_cards c
              WHERE c.app_id = it.app_id AND c.status = 'open' AND c.expires_at > NOW()
                AND COALESCE(c.issue_number, c.source_issue_number,
                             CASE WHEN (c.args->>'issueNumber') ~ '^[0-9]{1,9}$' THEN (c.args->>'issueNumber')::int END) = it.issue_number
             UNION ALL
             SELECT jsonb_build_object('id', v.id, 'kind', v.kind, 'expiresAt', v.created_at + INTERVAL '14 days')
               FROM homeroom_bot_voice_offers v
              WHERE v.app_id = it.app_id AND v.status = 'open' AND v.created_at > NOW() - INTERVAL '14 days'
                AND (v.args->>'issueNumber') = it.issue_number::text
           ) offered), '[]'::jsonb) AS offers,
         (SELECT COUNT(*)::int FROM feedback_reports fr
           WHERE fr.app_id = it.app_id AND fr.issue_number = it.issue_number) AS reports,
         sd.message_id AS said_id, sd.kind AS said_kind, sd.created_at AS said_at, sd.text AS said_text
    FROM it
    LEFT JOIN LATERAL (
      SELECT d.message_id, d.created_at FROM homeroom_bot_dm_messages d
       WHERE d.app_id = it.app_id AND d.issue_number = it.issue_number AND d.question_status = 'open'
       ORDER BY d.created_at DESC LIMIT 1
    ) oq ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.session_id, s.version, s.created_at
        FROM chat_session_specs s
        JOIN chat_sessions c ON c.id = s.session_id
       WHERE c.app_id = it.app_id
         AND (c.created_from_issue_number = it.issue_number OR it.issue_number = ANY(c.linked_issues))
         AND (s.shared_to_group_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM homeroom_bot_runs r
                          WHERE r.app_id = it.app_id AND r.issue_number = it.issue_number AND r.build_session_id = c.id))
       ORDER BY s.created_at DESC, s.version DESC LIMIT 1
    ) pl ON TRUE
    LEFT JOIN LATERAL (
      SELECT i.id,
             (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id AND v.vote = 'yes')::int AS yes,
             (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id AND v.vote = 'no')::int AS no
        FROM issues i
       WHERE i.app_id = it.app_id AND i.kind = 'close_issue' AND i.status = 'open'
         AND (i.payload->>'issueNumber') = it.issue_number::text
       ORDER BY i.id DESC LIMIT 1
    ) cv ON TRUE
    LEFT JOIN LATERAL (
      SELECT ph.id FROM private_threads ph
       WHERE ph.app_id = it.app_id AND ph.about_number = it.issue_number
         AND ${require('../workflow/rules/bot-loop.ts').planHoldActiveSql('ph')}
       ORDER BY ph.id DESC LIMIT 1
    ) dr ON TRUE
    LEFT JOIN LATERAL (
      SELECT p.thread_message_id AS message_id, p.kind, p.created_at, LEFT(m.content, 200) AS text
        FROM homeroom_bot_posts p
        JOIN chat_messages m ON m.id = p.thread_message_id
       WHERE p.app_id = it.app_id AND p.issue_number = it.issue_number AND p.pending IS NOT TRUE
         AND m.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id DESC LIMIT 1
    ) sd ON TRUE`;

// The live runs of each request named by ($1 app ids, $2 numbers), newest
// first, at most 200 of each: what their tries count, and why a build
// stopped. The limit is per request, so one request with many runs never
// takes another's out of a batch (its tries and its cause read from its own
// newest runs, whatever else is refreshed with it).
const STANDING_RUNS_SQL = `
  SELECT r.*
    FROM (SELECT DISTINCT x.app_id, x.issue_number FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)) it
    CROSS JOIN LATERAL (
      SELECT r.id, r.app_id, r.issue_number, r.verdict, r.cap_suppressed, r.awaiting_go_at, r.proposal_session_id,
             r.build_ok, r.build_error, r.build_session_id, r.error, r.created_at,
             r.build_no_change->'turns'->-1->>'said' AS no_change_said,
             -- T2.10: what a person verdict found (bot-stop-cause.js handBackOf).
             r.about_platform, r.go_ahead_blocker, (r.wrong_project IS NOT NULL) AS wrong_project,
             (r.plan IS NOT NULL AND r.plan->'chosen' IS NULL AND r.build_ok IS FALSE
               AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL) AS plan_only
        FROM homeroom_bot_runs r
       WHERE r.app_id = it.app_id AND r.issue_number = it.issue_number AND r.mode = 'live'
       ORDER BY r.id DESC
       LIMIT 200
    ) r
   ORDER BY r.id DESC`;

// Who shipped a closed request: the newest merged change linked to it that
// is not the bot's. `$1`/`$2` the requests as parallel arrays of project
// and number.
const DONE_BY_SQL = `
  SELECT DISTINCT ON (w.app_id, w.n) w.app_id, w.n, cs.id AS session_id, cs.pr_number, u.username
    FROM UNNEST($1::int[], $2::int[]) AS w(app_id, n)
    JOIN chat_sessions cs ON cs.app_id = w.app_id AND cs.status = 'merged'
         AND (w.n = ANY(cs.linked_issues) OR cs.created_from_issue_number = w.n)
    JOIN users u ON u.id = cs.user_id
   WHERE u.username <> 'homeroom_bot'
   ORDER BY w.app_id, w.n, cs.merged_at DESC NULLS LAST, cs.id DESC`;

/**
 * The requests a session is about: the requests whose bot run built or
 * proposed it, then the ones it says it closes. Empty for a change with no
 * request, which is its own item.
 */
async function requestsOfSession(db, sessionId) {
  // One branch per run column, so each reads its own index (an OR of the
  // two would read every run); UNION drops the repeats.
  const { rows } = await db.query(
    `SELECT r.app_id, r.issue_number FROM homeroom_bot_runs r WHERE r.proposal_session_id = $1
     UNION
     SELECT r.app_id, r.issue_number FROM homeroom_bot_runs r WHERE r.build_session_id = $1
     UNION
     SELECT cs.app_id, n AS issue_number FROM chat_sessions cs, unnest(cs.linked_issues) AS n
      WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
}

// ── Storing ──────────────────────────────────────────────────────────────

// jsonb hands keys back in its own order, so two values are compared with
// their keys sorted, never as written.
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, canon(value[k])]));
  }
  return value instanceof Date ? value.toISOString() : value;
}
const sameJson = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

/**
 * Pure (review B3): which derive wrote a stored row: the lower of its
 * `derive_version` column and its `standing.v`, so a row a Pod of an older
 * release wrote again (it writes `standing.v` only, and leaves the column
 * as a newer Pod set it) still reads as that older derive's. 0 for none.
 */
function versionOf(row) {
  const col = row && row.derive_version != null ? Number(row.derive_version) : null;
  const old = row && row.standing && row.standing.v != null ? Number(row.standing.v) : null;
  const known = [col, old].filter((n) => Number.isFinite(n));
  return known.length ? Math.min(...known) : 0;
}

// What of a row is the sweep's own and never something a reader shows: its
// due time (T2.7) and which derive wrote it (B3). A row whose only change
// is one of these is stored quietly: no push, no new updated_at, no move in
// a list sorted by it.
const QUIET_STANDING = (v) => { const { dueAt, v: version, ...rest } = v || {}; void dueAt; void version; return rest; };

async function upsert(db, key, next, { touch = false } = {}) {
  const { rows: [prev] } = await db.query(
    `SELECT stage, why, reason, line, whose_move, requester_id, since, standing, vote_open, lead_change_id, derive_version
       FROM work_states
      WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3`,
    [key.appId, key.kind, key.ref],
  );
  // B3: which derive wrote it, in its own column and, for the Pods of the
  // release before this one, in the standing (they read only that).
  const standing = { ...(next.standing || {}), v: DERIVE_VERSION };
  // B3: `since` counts: a row whose stage and line stay but whose time moved
  // is a row that changed.
  if (prev && prev.stage === next.stage && (prev.why || null) === next.why && (prev.reason || null) === next.reason
    && sameJson(prev.line, next.line) && (prev.whose_move || null) === next.whoseMove
    && (prev.requester_id == null ? null : Number(prev.requester_id)) === (next.requesterId ?? null)
    && iso(prev.since) === iso(next.since)
    && prev.vote_open === !!next.voteOpen
    && (prev.lead_change_id == null ? null : Number(prev.lead_change_id)) === (next.leadChangeId ?? null)
    && sameJson(QUIET_STANDING(prev.standing), QUIET_STANDING(standing))) {
    if ((prev.standing && prev.standing.dueAt) !== standing.dueAt || versionOf(prev) !== DERIVE_VERSION) {
      await db.query(
        `UPDATE work_states SET standing = $4::jsonb, derive_version = $5, checked_at = NOW()
          WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3`,
        [key.appId, key.kind, key.ref, JSON.stringify(standing), DERIVE_VERSION],
      );
      return null;
    }
    // Unchanged. The sweep still marks it checked, so it moves on to others.
    if (touch) {
      await db.query('UPDATE work_states SET checked_at = NOW() WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3',
        [key.appId, key.kind, key.ref]);
    }
    return null;
  }
  await db.query(
    `INSERT INTO work_states (app_id, item_kind, item_ref, issue_number, session_id, stage, why, reason, line,
                              whose_move, requester_id, since, standing, vote_open, lead_change_id, derive_version,
                              updated_at, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16, NOW(), NOW())
     ON CONFLICT (app_id, item_kind, item_ref) DO UPDATE
       SET issue_number = EXCLUDED.issue_number, session_id = EXCLUDED.session_id, stage = EXCLUDED.stage,
           why = EXCLUDED.why, reason = EXCLUDED.reason, line = EXCLUDED.line, whose_move = EXCLUDED.whose_move,
           requester_id = EXCLUDED.requester_id, since = EXCLUDED.since, standing = EXCLUDED.standing,
           vote_open = EXCLUDED.vote_open, lead_change_id = EXCLUDED.lead_change_id,
           derive_version = EXCLUDED.derive_version, updated_at = NOW(), checked_at = NOW()`,
    [key.appId, key.kind, key.ref, key.issueNumber ?? null, key.sessionId ?? null, next.stage, next.why, next.reason,
      next.line ? JSON.stringify(next.line) : null, next.whoseMove, next.requesterId ?? null, next.since,
      JSON.stringify(standing), !!next.voteOpen, next.leadChangeId ?? null, DERIVE_VERSION],
  );
  return {
    prev: prev ? {
      stage: prev.stage, why: prev.why || null, reason: prev.reason || null, line: prev.line || null,
      // Whether a vote on closing it was open: one opening retires its
      // Propose to close buttons (bot-cards.js retireFor).
      closeVote: !!prev.standing?.asks?.closeVote,
      // Whether it was open for votes: a change that opens asks its voters
      // (votePings).
      voteOpen: prev.vote_open === true,
    } : null,
  };
}

const IN_FLIGHT_CHECKS = (s) => s === 'pending' || s === 'running';

/**
 * Attach `checks_estimate` (the Testing card's own estimate, cached a minute
 * per app) to facts rows whose change is promoted and still checking, so a
 * run in flight can say "About N min left" (#6402). Best-effort: a failed
 * read is no estimate, and no estimate is no line.
 */
async function attachChecksEstimate(db, rows, wants) {
  const byApp = new Map();
  for (const row of rows) {
    if (!wants(row)) continue;
    const id = Number(row.app_id);
    if (!byApp.has(id)) byApp.set(id, await checksEstimate.forApp(db, id).catch(() => null));
    row.checks_estimate = byApp.get(id);
  }
}

// #6594: the predicate over a work_states row (`w`) that says its votes are
// in: it is going live, or it is approved and waiting on checks.
const APPROVED_SQL = (alias) => `(${alias}.stage = 'going_live' OR ${alias}.line->>'code' IN (${stages.APPROVED_LINES.map((c) => `'${c}'`).join(', ')}))`;

const VOTES_IN_SQL = `
  SELECT cs.id, cs.app_id, cs.user_id, cs.promoted_at, cs.created_at,
         cs.requires_explicit_approval, cs.explicit_approval_reason,
         ${require('./first-version-rule').firstVersionSql('cs')} AS first_version,
         -- #6594: yes voters a push retired: they voted on an earlier
         -- version, their yes no longer counts, and they have not confirmed
         -- it on this one. The vote prompt says why a new yes is needed.
         (SELECT COUNT(DISTINCT pv.user_id)::int
            FROM pr_votes pv
           WHERE pv.session_id = cs.id AND pv.vote = 'yes'
             AND pv.approval_epoch < cs.approval_epoch
             AND counts_toward_session_outcome(pv.user_id, cs.id)
             AND pv.user_id IS DISTINCT FROM cs.user_id
             AND NOT EXISTS (SELECT 1 FROM pr_votes cur
                              WHERE cur.session_id = cs.id AND cur.user_id = pv.user_id
                                AND cur.approval_epoch = cs.approval_epoch)) AS earlier_yes
    FROM chat_sessions cs
   WHERE cs.id = ANY($1::int[]) AND cs.status = 'promoted'`;

/**
 * #6594: attach `votes_in` (the project's rule would let this change merge
 * now) and `earlier_yes` to facts rows whose change is promoted, so a change
 * whose votes are in never reads "Up for a vote". The gate is the same one
 * every merge decision takes, so its count can never disagree with the
 * Votes card's: current-epoch yes votes, the member floor and explicit
 * approval. Best-effort: a failed read leaves `votes_in` false, which is
 * today's wording.
 */
async function attachVotes(db, rows, keyOf, now) {
  const bySession = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const id = key ? Number(key.id) : 0;
    if (!(id > 0)) continue;
    if (!bySession.has(id)) bySession.set(id, { prefix: key.prefix || '', rows: [] });
    bySession.get(id).rows.push(row);
  }
  if (!bySession.size) return;
  try {
    const { rows: facts } = await db.query(VOTES_IN_SQL, [[...bySession.keys()]]);
    const governance = require('./governance');
    for (const f of facts) {
      const id = Number(f.id);
      const { prefix, rows: of } = bySession.get(id);
      let votesIn = false;
      if (f.first_version !== true) {
        const gate = await governance.governedGate(db, Number(f.app_id), {
          kind: 'pr', id, openedAt: f.promoted_at || f.created_at, now,
          explicitApproval: f.requires_explicit_approval === true,
          explicitReason: f.explicit_approval_reason || null,
          authorId: f.user_id == null ? null : Number(f.user_id),
          firstVersion: false,
        }).catch(() => null);
        votesIn = gate?.mergeable === true;
      }
      for (const row of of) {
        row[`${prefix}votes_in`] = votesIn;
        row[`${prefix}earlier_yes`] = Number(f.earlier_yes) || 0;
      }
    }
  } catch (err) {
    require('./logger').warn('work-state', 'votes read failed', { message: err.message });
  }
}

/**
 * Pure: a change's facts as its standing carries them (the contract every
 * reader draws: services/work-state.js fromRow `change`), with whether it is
 * open for votes from its own stage. Null for no change.
 */
function changeStandingOf(f, changeState, now = new Date()) {
  if (!f) return null;
  const promoted = f.status === 'promoted';
  return {
    id: Number(f.id),
    number: f.pr_number == null ? null : Number(f.pr_number),
    status: f.status || null,
    checks: {
      state: f.check_state || null,
      phase: f.check_phase || null,
      failing: f.failed_checks == null ? null : Number(f.failed_checks),
    },
    votes: { yes: Number(f.votes_yes) || 0, no: Number(f.votes_no) || 0 },
    voteOpen: voteOpenOf(changeState),
    firstVersion: f.first_version === true,
    githubHold: promoted && !!githubHold(f),
    shotsHeld: promoted && shotsHeld(f, now),
    conflict: promoted && (f.merge_conflict_state === 'conflict' || f.merge_conflict_state === 'failed' || f.integration_merges_clean === false),
    update: promoted && (f.update_coming === 'queued' || f.update_coming === 'running') ? f.update_coming : null,
  };
}

const NO_ASKS = Object.freeze({ question: null, plan: null, closeVote: null, draft: null, offers: [], reports: 0 });

/**
 * Pure: what a request's standing says beside its stage, from its facts row
 * (REQUEST_FACTS_SQL), its STANDING_SQL row, its live runs (newest first),
 * its derived state and its lead change: the change, what is asked of its
 * requester, the bot's newest post about it, its tries (a request's track's
 * "Try 2"), why a build stopped, and who shipped it.
 */
function requestStandingOf({ row, extra = null, runs = [], next, change = null, doneBy = null, deciders = [] }) {
  const iso2 = (v) => iso(v);
  const waitingGo = next.stage === 'waiting_for_you' && next.why === 'plan';
  const plan = extra && extra.plan_version != null
    ? { version: Number(extra.plan_version), sessionId: Number(extra.plan_session_id) || null, at: iso2(extra.plan_at), waitingGo }
    : waitingGo
      ? { version: null, sessionId: Number(row.build_session_id) || null, at: iso2(row.plan_waiting_at), waitingGo }
      : null;
  const asks = extra ? {
    question: extra.question_id ? { messageId: Number(extra.question_id), at: iso2(extra.question_at) } : null,
    plan,
    closeVote: extra.close_id ? { issueId: Number(extra.close_id), yes: Number(extra.close_yes) || 0, no: Number(extra.close_no) || 0 } : null,
    draft: extra.draft_id ? { threadId: Number(extra.draft_id) } : null,
    offers: (Array.isArray(extra.offers) ? extra.offers : []).map((o) => ({ id: Number(o.id), kind: String(o.kind), expiresAt: iso2(o.expiresAt) })),
    reports: Number(extra.reports) || 0,
  } : { ...NO_ASKS, plan };
  const said = extra && extra.said_id
    ? { messageId: Number(extra.said_id), kind: extra.said_kind || null, at: iso2(extra.said_at), text: String(extra.said_text || '').slice(0, 200) }
    : null;
  // Its tries, as its track counts them: a change being fixed or updated is
  // its next try until a run records it (homeroom-bot-track.js triesOf).
  const track = require('./homeroom-bot-track');
  const code = next.line && next.line.code;
  const since = next.since || iso2(row.run_at);
  const underWay = (code === 'fixing' || code === 'revising')
    && !runs.some((run) => run.verdict === 'revise' && Date.parse(run.created_at) >= Date.parse(since || 0));
  const lead = runs[0] || null;
  // T2.9, T2.10, T2.11: why it stopped, or what its hand-back waits on, by
  // the one decoder (bot-stop-cause.js): the stage's words, the track's
  // line, the bell and the push all read this code.
  const decode = require('./bot-stop-cause');
  const handBack = next.stage === 'waiting_for_you' && next.why === 'decide'
    ? decode.handBackOf({ run: lead, offers: asks.offers, deciders }) : null;
  const cause = decode.causeOf({ next, run: lead, handBack, credit: row.queue_reason === decode.CREDIT_WAIT });
  return {
    change,
    asks,
    said,
    tries: track.triesOf(runs, { underWay }),
    tryStarts: track.tryStartsOf(runs, { underWay: underWay ? since : null }),
    cause: cause ? cause.cause : null,
    ...(cause && cause.names ? { causeNames: cause.names } : {}),
    // T2.12: the request's newest live run, so a card about a run knows
    // whether the row is about it (homeroom-bot-activity.js outcomeFor).
    ...(Number(row.run_id) > 0 ? { runId: Number(row.run_id) } : {}),
    doneBy: next.stage === 'closed' && doneBy
      ? { username: doneBy.username || null, prNumber: Number(doneBy.pr_number) || null, sessionId: Number(doneBy.session_id) || null }
      : null,
  };
}

/**
 * T2.10 (19 Nov 2026): who decides a request its look left for a person,
 * when its requester does not (the bot's own rule, homeroom-bot.js
 * whoDecides: the project's creator, then its admins), as usernames. Empty
 * when its requester decides, or nobody can be read: the hand-back is then
 * its requester's.
 */
async function decidersOf(db, row) {
  const userId = Number(row.requester_id) || 0;
  if (!userId) return [];
  try {
    const d = await require('./homeroom-bot').whoDecides(db, { id: Number(row.app_id), slug: row.app_slug || null }, { userId, username: null });
    return d && !d.requesterDecides && Array.isArray(d.deciders) ? d.deciders.map((x) => x && x.username).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// A change built for a request has a row of its own once it is up for a
// vote or past it (Needs you reads whether it is open for votes); before
// that its request's row is where it stands.
const CHANGE_ROW_STATUSES = new Set(['promoted', 'merging', 'merged', 'closed', 'archived']);

// ── One writer per item (review B3) ─────────────────────────────────────

const { WORK_STATE_ITEM_LOCK } = require('./advisory-locks');
const requestLock = (r) => `request:${Number(r.appId)}:${Number(r.issueNumber)}`;
const changeLock = (id) => `change:${Number(id)}`;

/**
 * Review B3 (19 Nov 2026): take the item locks named by `keys` (requestLock,
 * changeLock) for `db`'s transaction, in the order given, never waiting for
 * one: resolves the set of keys it could NOT take, because another
 * transaction holds them (so a caller with nothing busy reads nothing back).
 * Such an item's holder is deriving it now, from facts it reads after taking
 * the lock, so whatever this caller wrote is either in what the holder reads
 * or marked the item for the drain after the holder's commit (every fact the
 * derive reads marks its item: work-state-marks-all-inputs.sql). Taking it
 * again in the same transaction succeeds. Waiting instead could deadlock: a
 * machine's transition holds its change's chat_sessions row FOR UPDATE when
 * it stores its rows, and a holder's bell row needs a key share on that row
 * (notifications.session_id).
 */
async function takeItems(db, keys) {
  const list = [...new Set(keys)];
  if (!list.length) return new Set();
  const { rows } = await db.query(
    `SELECT t.k FROM (SELECT k FROM unnest($2::text[]) WITH ORDINALITY AS u(k, n) ORDER BY n OFFSET 0) t
      WHERE NOT pg_try_advisory_xact_lock($1::int, hashtext(t.k))`,
    [WORK_STATE_ITEM_LOCK, list],
  );
  return new Set((rows || []).map((r) => r.k));
}

/**
 * Derive the items again and store each that changed. `items` are
 * { appId, issueNumber } (a request) or { sessionId } (a change: its own
 * row, and the rows of the requests it is about). Resolves the changed
 * rows: { appId, kind, ref, issueNumber, sessionId, state, prev, bell },
 * `state` carrying the whole stored row (stage, why, reason, line, whose
 * move, since, requesterId, voteOpen, leadChangeId, standing).
 *
 * Review B3 (19 Nov 2026): each item is stored under its own lock
 * (takeItems), taken before its facts are read and held to the end of the
 * transaction, so a write can never put back what an older reading of the
 * facts said over a row derived from a newer one (which rang its bell a
 * second time when the newer reading came round again). On a pool it runs
 * in a transaction of its own, so the locks mean something. An item another
 * writer holds is skipped, and named in `skipped` (an array the caller
 * passes) as { appId, issueNumber } or { sessionId }: the drain puts its
 * mark back.
 */
async function refresh(db, items, { now = new Date(), touch = false, skipped = null } = {}) {
  if (isPool(db)) return unit(db, (tx) => refresh(tx, items, { now, touch, skipped }));
  const requests = new Map();
  const changes = new Set();
  for (const it of items || []) {
    if (it && Number(it.appId) > 0 && Number(it.issueNumber) > 0) {
      requests.set(`${Number(it.appId)}:${Number(it.issueNumber)}`, { appId: Number(it.appId), issueNumber: Number(it.issueNumber) });
    } else if (it && Number(it.sessionId) > 0) {
      for (const r of await requestsOfSession(db, Number(it.sessionId))) requests.set(`${r.appId}:${r.issueNumber}`, r);
      changes.add(Number(it.sessionId));
    }
  }
  // B3: the requests first, then the changes, each in order, before any of
  // their facts is read.
  const busy = await takeItems(db, [
    ...[...requests.values()].sort((a, b) => a.appId - b.appId || a.issueNumber - b.issueNumber).map(requestLock),
    ...[...changes].sort((a, b) => a - b).map(changeLock),
  ]);
  const skip = (item) => { if (Array.isArray(skipped)) skipped.push(item); };
  for (const [k, r] of requests) {
    if (busy.has(requestLock(r))) { requests.delete(k); skip({ appId: r.appId, issueNumber: r.issueNumber }); }
  }
  for (const id of [...changes]) {
    if (busy.has(changeLock(id))) { changes.delete(id); skip({ sessionId: id }); }
  }
  const changed = [];
  let rows = [];
  if (requests.size) {
    const list = [...requests.values()];
    ({ rows } = await db.query(REQUEST_FACTS_SQL, [list.map((r) => r.appId), list.map((r) => r.issueNumber)]));
    // Stored in one order everywhere (by project and number, then by
    // change), so two refreshes of the same rows never wait on each other.
    rows.sort((a, b) => Number(a.app_id) - Number(b.app_id) || Number(a.issue_number) - Number(b.issue_number));
  }
  // The change each request draws: the bot's newest proposal of it, else a
  // person's change for it. Its facts are read with the changes named.
  const leads = new Set();
  for (const row of rows) {
    row.lead_change_id = Number(row.proposal_session_id) || Number(row.lc_id) || null;
    if (row.lead_change_id) leads.add(row.lead_change_id);
    if (Number(row.lc_id)) leads.add(Number(row.lc_id));
  }
  // B3: the change rows its requests draw are stored under their own locks
  // too, taken now, before the changes' facts are read. One another writer
  // holds is still read, for the requests that draw it, and not stored here.
  const busyLeads = await takeItems(db, [...leads].filter((id) => !changes.has(id)).sort((a, b) => a - b).map(changeLock));
  for (const id of leads) {
    if (busyLeads.has(changeLock(id))) skip({ sessionId: id });
  }
  const mayStore = (id) => changes.has(Number(id)) || (leads.has(Number(id)) && !busyLeads.has(changeLock(id)));
  const ids = [...new Set([...changes, ...leads])];
  const facts = new Map();
  if (ids.length) {
    const { rows: found } = await db.query(CHANGE_FACTS_SQL, [ids]);
    await attachChecksEstimate(db, found, (r) => r.status === 'promoted' && IN_FLIGHT_CHECKS(r.check_state));
    // #6594: whether each promoted change's votes are in, which decides
    // whether it asks for a vote at all. Read once per change, here, and
    // handed to the requests that draw it below.
    await attachVotes(db, found, (r) => (r.status === 'promoted' ? { id: Number(r.id), prefix: '' } : null), now);
    for (const f of found) facts.set(Number(f.id), f);
  }
  const changeStates = new Map([...facts.values()].map((f) => [Number(f.id), deriveChange(f, { now })]));

  if (rows.length) {
    await attachChecksEstimate(db, rows, (r) => (r.proposal_status === 'promoted' && IN_FLIGHT_CHECKS(r.check_state))
      || (r.lc_status === 'promoted' && IN_FLIGHT_CHECKS(r.lc_check_state)));
    // #6594: a request reads its change's votes from that change's facts
    // (the bot's own proposal of it, or a person's change for it).
    for (const row of rows) {
      const own = row.proposal_status === 'promoted' ? facts.get(Number(row.proposal_session_id)) : null;
      if (own) Object.assign(row, { votes_in: own.votes_in === true, earlier_yes: Number(own.earlier_yes) || 0 });
      const theirs = row.lc_status === 'promoted' ? facts.get(Number(row.lc_id)) : null;
      if (theirs) Object.assign(row, { lc_votes_in: theirs.votes_in === true, lc_earlier_yes: Number(theirs.earlier_yes) || 0 });
    }
    // Which of them wait for their project's first version, by the bot's
    // own rule (as its read lane and a project chat's card read it).
    const bot = require('./homeroom-bot');
    const holds = await bot.firstVersionHolds(db, [...new Set(rows.map((r) => Number(r.app_id)))]).catch(() => new Map());
    for (const row of rows) {
      row.held_first_version = bot.heldForFirstVersion(holds, {
        appId: row.app_id, issueNumber: row.issue_number, firstVersion: row.first_version === true, reason: row.queue_reason || null,
      });
      // A person's change for it reads the change's own facts (deriveFacts).
      if (Number(row.lc_id) && facts.has(Number(row.lc_id))) row.lc_facts = facts.get(Number(row.lc_id));
    }
    const pairs = [rows.map((r) => Number(r.app_id)), rows.map((r) => Number(r.issue_number))];
    const [{ rows: extras }, { rows: runs }] = await Promise.all([
      db.query(STANDING_SQL, pairs),
      db.query(STANDING_RUNS_SQL, pairs),
    ]);
    const extraOf = new Map(extras.map((e) => [`${e.app_id}:${e.issue_number}`, e]));
    const runsOf = new Map();
    for (const run of runs) {
      const k = `${run.app_id}:${run.issue_number}`;
      if (!runsOf.has(k)) runsOf.set(k, []);
      runsOf.get(k).push(run);
    }
    const derived = rows.map((row) => {
      const lead = row.lead_change_id ? facts.get(row.lead_change_id) || null : null;
      const leadState = lead ? changeStates.get(Number(lead.id)) : null;
      const voteOpen = !!lead && voteOpenOf(leadState);
      // A request whose change is up for a vote or past it stands where the
      // change stands, read from the change's own facts (deriveFacts,
      // withBot): one reading, so it is up for a vote exactly while its
      // change is open for votes.
      const own = Number(row.proposal_session_id) ? facts.get(Number(row.proposal_session_id)) || null : null;
      const next = derive(row, { now, change: own });
      return { row, next, lead, leadState, voteOpen };
    });
    const closed = derived.filter((d) => d.next.stage === 'closed');
    const doneBy = new Map();
    if (closed.length) {
      const { rows: shipped } = await db.query(DONE_BY_SQL, [closed.map((d) => Number(d.row.app_id)), closed.map((d) => Number(d.row.issue_number))]);
      for (const r of shipped) doneBy.set(`${r.app_id}:${r.n}`, r);
    }
    for (const { row, next: derivedState, lead, leadState, voteOpen } of derived) {
      const k = `${row.app_id}:${row.issue_number}`;
      const next = {
        ...derivedState,
        requesterId: row.requester_id == null ? null : Number(row.requester_id),
        voteOpen,
        leadChangeId: row.lead_change_id || null,
      };
      next.standing = requestStandingOf({
        row, extra: extraOf.get(k) || null, runs: runsOf.get(k) || [], next,
        change: changeStandingOf(lead, leadState, now), doneBy: doneBy.get(k) || null,
        // T2.10: a hand-back a person decides names who, when its requester does not.
        deciders: next.stage === 'waiting_for_you' && next.why === 'decide' ? await decidersOf(db, row) : [],
      });
      // T2.7: when it next moves by time alone, for the sweep (upsert
      // stores which derive wrote it).
      const dueAt = dueOf({ state: next, row, change: lead, offers: next.standing.asks && next.standing.asks.offers, now });
      if (dueAt) next.standing.dueAt = dueAt;
      const sessionId = Number(row.proposal_session_id || row.build_session_id || row.lc_id) || null;
      const key = { appId: Number(row.app_id), kind: 'request', ref: Number(row.issue_number), issueNumber: Number(row.issue_number), sessionId };
      const wrote = await upsert(db, key, next, { touch });
      if (wrote) changed.push({ ...key, appSlug: row.app_slug || null, state: next, prev: wrote.prev, bell: bellOf(wrote.prev, next) });
    }
  }

  // The changes' own rows: every change named, and each request's change
  // once it is up for a vote or past it. Never a headless session's. A row
  // a change already has is always derived again (a change built for a
  // request that went back to Underway, or was closed, must not keep saying
  // it is open for votes, and the sweep must find it checked), and one whose
  // change is gone or headless is removed.
  const existing = new Set();
  const storable = ids.filter(mayStore);
  if (storable.length) {
    // A change's row carries its own id as its session (work_states_session_idx).
    const { rows: had } = await db.query(
      `SELECT item_ref FROM work_states WHERE session_id = ANY($1::int[]) AND item_kind = 'change'`, [storable]);
    for (const r of had) existing.add(Number(r.item_ref));
  }
  const gone = [...existing].filter((id) => !facts.has(id) || facts.get(id).is_headless === true);
  if (gone.length) {
    await db.query(`DELETE FROM work_states WHERE session_id = ANY($1::int[]) AND item_kind = 'change'`, [gone]);
  }
  const own = [...facts.values()]
    .filter((f) => f.is_headless !== true && mayStore(f.id))
    .filter((f) => existing.has(Number(f.id)) || f.has_requests !== true || CHANGE_ROW_STATUSES.has(f.status))
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const f of own) {
    const st = changeStates.get(Number(f.id));
    const next = {
      ...st,
      requesterId: f.user_id == null ? null : Number(f.user_id),
      voteOpen: voteOpenOf(st),
      leadChangeId: null,
      standing: {
        change: changeStandingOf(f, st, now),
        asks: { ...NO_ASKS, offers: (Array.isArray(f.offers) ? f.offers : []).map((o) => ({ id: Number(o.id), kind: String(o.kind), expiresAt: iso(o.expiresAt) })) },
        said: null,
      },
    };
    // T2.7: when it next moves by time alone, for the sweep (upsert stores
    // which derive wrote it).
    const dueAt = dueOf({ state: st, change: f, offers: next.standing.asks.offers, now });
    if (dueAt) next.standing.dueAt = dueAt;
    const key = { appId: Number(f.app_id), kind: 'change', ref: Number(f.id), issueNumber: null, sessionId: Number(f.id) };
    const wrote = await upsert(db, key, next, { touch });
    // A change with requests never rings: its requests' rows do.
    if (wrote) {
      changed.push({
        ...key, appSlug: f.app_slug || null, state: next, prev: wrote.prev,
        bell: f.has_requests === true ? null : bellOf(wrote.prev, next),
      });
    }
  }
  await markPlaces(db, changed);
  return changed;
}

// T2.7: the lines whose words count the project's other requests: a place
// in the bot's line, among its builds, or behind one of its limits.
const { PLACE_LINES } = stages;

/**
 * T2.7 (19 Nov 2026): a request that moved in or out of one of those lines
 * marks its project's other requests in them, so "Number 2 in line" moves
 * when the one ahead starts; and one that went live (or is going live: a
 * first version) marks those waiting for the project's first version. The
 * marks are drained like any other (drainDirty), so the sweep no longer
 * reads every queued row to catch a place that moved.
 */
async function markPlaces(db, changed) {
  const byApp = new Map();
  const add = (appId, codes, ref) => {
    const key = `${appId}:${codes.join(',')}`;
    if (!byApp.has(key)) byApp.set(key, { appId, codes, refs: [] });
    byApp.get(key).refs.push(Number(ref));
  };
  for (const c of changed || []) {
    if (c.kind !== 'request') continue;
    const was = c.prev && c.prev.line && c.prev.line.code;
    const is = c.state && c.state.line && c.state.line.code;
    if (PLACE_LINES.includes(was) || PLACE_LINES.includes(is)) add(c.appId, PLACE_LINES, c.ref);
    if ((c.state.stage === 'live' || c.state.stage === 'going_live') && (!c.prev || c.prev.stage !== c.state.stage)) {
      add(c.appId, ['first_version_wait'], c.ref);
    }
  }
  for (const { appId, codes, refs } of byApp.values()) {
    await db.query(
      `SELECT work_state_mark(ws.app_id, ws.item_ref, NULL)
         FROM work_states ws
        WHERE ws.app_id = $1 AND ws.item_kind = 'request' AND NOT (ws.item_ref = ANY($2::int[]))
          AND ws.line->>'code' = ANY($3::text[])`,
      [Number(appId), refs, codes],
    );
  }
}

// ── The workflow's hook ──────────────────────────────────────────────────

// The machines whose transitions move a request or a change, and how an
// instance's key names what it is about.
const WATCHED = new Set([
  'bot-request', 'bot-build', 'bot-change', 'proposal', 'preview', 'merge-followups', 'app-delivery', 'governance-proposal',
]);

// A vote decides a request only when it closes or reopens one, as it applies.
const DECIDING_KINDS = new Set(['close_issue', 'reopen_issue']);

/**
 * Pure: whether an accepted event may move a request or change (the
 * kernel's afterAccepted `wants`, asked before any query): a watched
 * machine's, and of a governance vote only the one that applies a close or
 * a reopen.
 */
function wants({ machine, state, data } = {}) {
  if (!WATCHED.has(machine)) return false;
  if (machine === 'governance-proposal') return state === 'applied' && DECIDING_KINDS.has(data?.kind);
  return true;
}

/** The items one instance of a watched machine is about. */
async function itemsOf(db, { machine, key, appId }) {
  if (!WATCHED.has(machine) || typeof key !== 'string') return [];
  let m = /^request:(\d+):(\d+)$/.exec(key);
  if (m) return [{ appId: Number(m[1]), issueNumber: Number(m[2]) }];
  m = /^run:(\d+)(?:@.*)?$/.exec(key);
  if (m) {
    const { rows } = await db.query('SELECT app_id, issue_number FROM homeroom_bot_runs WHERE id = $1', [Number(m[1])]);
    return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
  }
  m = /^session:(\d+)$/.exec(key);
  if (m) return [{ sessionId: Number(m[1]) }];
  // A vote to close or reopen a request (governance-proposal): the request
  // it names, and the ones open in its thread that close with it.
  m = machine === 'governance-proposal' && /^issue:(\d+)$/.exec(key);
  if (m) {
    const { rows } = await db.query(
      `SELECT p.app_id, (p.payload->>'issueNumber')::int AS issue_number, p.thread_id
         FROM issues p
        WHERE p.id = $1 AND p.kind IN ('close_issue', 'reopen_issue')
          AND (p.payload->>'issueNumber') ~ '^[0-9]+$'`,
      [Number(m[1])],
    );
    if (!rows.length) return [];
    const { rows: thread } = rows[0].thread_id ? await db.query(
      `SELECT r.app_id, r.number AS issue_number FROM requests r WHERE r.thread_id = $1 AND r.app_id = $2`,
      [rows[0].thread_id, rows[0].app_id],
    ) : { rows: [] };
    const out = new Map();
    for (const r of [...rows, ...thread]) out.set(`${r.app_id}:${r.issue_number}`, { appId: Number(r.app_id), issueNumber: Number(r.issue_number) });
    return [...out.values()];
  }
  m = /^app:(\d+)$/.exec(key);
  if (m) {
    // An app's delivery: whatever of it is going live may be live now.
    const { rows } = await db.query(
      `SELECT app_id, item_kind, item_ref, session_id FROM work_states WHERE app_id = $1 AND stage = 'going_live'`,
      [Number(m[1])],
    );
    return rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) }));
  }
  void appId;
  return [];
}

/**
 * Pure: a work state as every reader takes it (fromRow, the push, a
 * request's `standing` on its page): the stored row, its words (phrasesOf)
 * and its standing (its change, what is asked, what the bot last said). The
 * per-viewer facts (`mine`, `voteOwed`) are the reader's to add.
 */
function shapeOf(item) {
  const standing = item.standing && typeof item.standing === 'object' ? item.standing : {};
  const out = {
    appId: Number(item.appId),
    app: item.app || null,
    kind: item.kind,
    ref: Number(item.ref),
    issueNumber: item.issueNumber == null ? null : Number(item.issueNumber),
    sessionId: item.sessionId == null ? null : Number(item.sessionId),
    stage: item.stage,
    why: item.why || null,
    reason: item.reason || null,
    line: item.line || null,
    whoseMove: item.whoseMove || null,
    requesterId: item.requesterId == null ? null : Number(item.requesterId),
    since: iso(item.since),
    updatedAt: iso(item.updatedAt),
    voteOpen: !!item.voteOpen,
    leadChangeId: item.leadChangeId == null ? null : Number(item.leadChangeId),
    words: phrasesOf(item),
    change: standing.change || null,
    asks: standing.asks || { ...NO_ASKS },
    said: standing.said || null,
  };
  if (item.kind === 'request') {
    out.tries = Number(standing.tries) || 1;
    out.tryStarts = Array.isArray(standing.tryStarts) ? standing.tryStarts : [];
    out.cause = standing.cause || null;
    out.causeNames = Array.isArray(standing.causeNames) ? standing.causeNames : [];
    out.runId = Number(standing.runId) || null;
    out.doneBy = standing.doneBy || null;
  }
  return out;
}

/**
 * The push a changed row is carried by, to everyone who may view its app:
 * the whole row (shapeOf) as anybody but its requester reads it (publicOf).
 */
function pushOf(row) {
  const state = publicOf(shapeOf({
    ...row.state,
    appId: row.appId, kind: row.kind, ref: row.ref, issueNumber: row.issueNumber, sessionId: row.sessionId,
    app: row.appSlug ? { slug: row.appSlug, name: row.appName || row.appSlug } : null,
    updatedAt: row.updatedAt || new Date(),
  }));
  return {
    kind: 'scoped',
    routing: { appId: row.appId, appSlug: row.appSlug || null },
    data: {
      type: 'work_state',
      appId: row.appId,
      appSlug: row.appSlug || null,
      item: { kind: row.kind, ref: row.ref, issueNumber: row.issueNumber, sessionId: row.sessionId },
      state,
    },
  };
}

/**
 * Publish pushes from outside a transition (a route, the sweep): the same
 * bus envelope a transition's pushes use, so every process delivers them.
 * Inside a transaction they go out when it commits.
 */
async function publish(db, pushes) {
  if (!pushes || !pushes.length) return;
  const bus = require('./ws-bus');
  await db.query(
    'SELECT pg_notify($1, body) FROM unnest($2::text[]) WITH ORDINALITY AS t(body, n) ORDER BY n',
    [bus.CHANNEL, pushes.map((p) => bus.workflowBody(p.kind, p.routing ?? null, p.data))],
  );
}

/**
 * Refresh items a route changed outside any machine (a close, a reopen, a
 * claim, a vote) and publish what changed. Never throws: the route's own
 * write stands, and the sweep corrects a row this missed.
 */
async function touched(db, items) {
  try {
    // T2.8: the rows and the bells they ring are stored together.
    const out = await refreshUnits(db, items);
    await publish(db, out.pushes);
    if (out.changed.length) {
      try {
        await publish(db, await settleCards(db, out.changed));
      } catch (err) {
        require('./logger').warn('work-state', 'Retiring the cards of moved rows failed', { message: err.message });
      }
    }
    return out.changed;
  } catch (err) {
    require('./logger').warn('work-state', 'refresh after a route write failed', { message: err.message });
    return [];
  }
}

// ── One unit per item (T2.8) ─────────────────────────────────────────────

/** Whether `db` is a pool (each statement its own transaction), not a client inside one. */
const isPool = (db) => !!db && typeof db.connect === 'function' && typeof db.release !== 'function';

/**
 * T2.8: run `fn` as one unit: in a transaction of its own on a pool, else in
 * a savepoint of the caller's transaction, so a throw undoes what it wrote
 * and nothing else. A client that turns out not to be in a transaction runs
 * it as it is.
 */
async function unit(db, fn) {
  if (isPool(db)) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  // One name for every unit: savepoints nest last in, first out, and a
  // RELEASE or ROLLBACK TO names the newest of that name.
  try {
    await db.query('SAVEPOINT work_state_unit');
  } catch {
    return fn(db);
  }
  try {
    const out = await fn(db);
    await db.query('RELEASE SAVEPOINT work_state_unit');
    return out;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT work_state_unit').catch(() => {});
    throw err;
  }
}

/**
 * T2.8 (19 Nov 2026): derive items again and resolve the pushes their moves
 * owe (the work_state, the bell, the voters asked, a ready withdrawn), the
 * rows and the bells stored together: a throw that stored rows and then
 * pushed to nobody left a stage moved with its bell never rung (bellOf rings
 * a move only once). The batch is one unit; when it throws, each item is a
 * unit of its own, so one bad item keeps no other from moving. Resolves {
 * changed, pushes, failed, skipped } (`failed`: the items that threw, with
 * why; `skipped`: those another writer held, B3). The cards a move retires
 * are the caller's (settleCards), after its commit.
 */
async function refreshUnits(db, items, { now = new Date(), touch = false } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return { changed: [], pushes: [], failed: [], skipped: [] };
  const run = async (tx, these) => {
    const skipped = [];
    const changed = await refresh(tx, these, { now, touch, skipped });
    return { changed, skipped, pushes: await pushesOf(tx, changed, { cards: false }) };
  };
  try {
    const out = await unit(db, (tx) => run(tx, list));
    return { ...out, failed: [] };
  } catch (err) {
    if (list.length === 1) return { changed: [], pushes: [], failed: [{ item: list[0], error: err }], skipped: [] };
  }
  const out = { changed: [], pushes: [], failed: [], skipped: [] };
  for (const item of list) {
    try {
      const one = await unit(db, (tx) => run(tx, [item]));
      out.changed.push(...one.changed);
      out.pushes.push(...one.pushes);
      out.skipped.push(...one.skipped);
    } catch (err) {
      out.failed.push({ item, error: err });
    }
  }
  return out;
}

// ── The bell ─────────────────────────────────────────────────────────────

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): a request's requester
// hears four moments, rung from its stage alone: into waiting_for_you
// (needs you), up_for_vote (ready to vote), stopped, and live. The bell row
// is written with the stage, in the same transaction, and its words come
// from homeroom-bot-notify-copy.js as the bot's own moments' do; it opens
// the request. A first version's news is still the bot's own messages,
// which ring themselves (homeroom-bot-dm.js sendDm), so it is not rung here.
const BELL_KINDS = Object.freeze({ needs_you: 'build_needs_you', ready: 'build_ready', stopped: 'build_stopped', live: 'build_live' });
const WHY_SAID = Object.freeze(Object.fromEntries(WHYS.map((why) => [why, stages.WHY[why].said])));
// T2.9: what a stop says when its row has no cause of its own (a row from
// before the cause was stored). A failed read and a closed change are not
// "something went wrong while I was building" any more.
const REASON_SAID = Object.freeze(Object.fromEntries(REASONS.map((reason) => [reason, stages.REASON[reason].said])));

/**
 * Pure: which of a moment's words a change of stage says
 * (homeroom-bot-notify-copy.js `said`). T2.9, T2.10, T2.11: a stop and a
 * hand-back say their stored cause (bot-stop-cause.js saidOfCause), so the
 * push says the same thing as the row, the track and the note.
 */
function bellSaid(bell, item, { group = false } = {}) {
  const { cause } = causeOfItem(item || {});
  if (bell === 'needs_you') {
    if (item.why === 'decide' || item.why === 'needs_detail') {
      return require('./bot-stop-cause').saidOfCause(cause) || WHY_SAID[item.why];
    }
    return WHY_SAID[item.why] || 'question';
  }
  if (bell === 'ready') return group ? 'ready_group' : 'ready';
  if (bell === 'stopped') return require('./bot-stop-cause').saidOfCause(cause) || REASON_SAID[item.reason] || 'build_other';
  return 'live';
}

// The request's name falls back to Homeroom's own copy of it when the
// requester row has none (requests, then issues), never to the project alone.
const BELL_FACTS_SQL = `
  SELECT rq.first_version,
         COALESCE(NULLIF(rq.issue_title, ''),
                  (SELECT NULLIF(r.title, '') FROM requests r WHERE r.app_id = rq.app_id AND r.number = rq.issue_number),
                  (SELECT NULLIF(i.title, '') FROM issues i
                    WHERE i.app_id = rq.app_id AND i.github_issue_number = rq.issue_number
                    ORDER BY i.id DESC LIMIT 1)) AS issue_title,
         a.slug, a.name,
         (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members,
         bot.id AS bot_id,
         lr.read_reason, lr.builder,
         (SELECT u.username FROM users u WHERE u.id = rq.user_id) AS requester_username
    FROM homeroom_bot_requesters rq
    LEFT JOIN LATERAL (
      SELECT r.read_reason, r.builder FROM homeroom_bot_runs r
       WHERE r.app_id = rq.app_id AND r.issue_number = rq.issue_number AND r.mode = 'live'
       ORDER BY r.id DESC LIMIT 1
    ) lr ON TRUE
    JOIN apps a ON a.id = rq.app_id
    LEFT JOIN users bot ON bot.username = 'homeroom_bot' AND bot.is_synthetic = TRUE
   WHERE rq.app_id = $1 AND rq.issue_number = $2 AND rq.user_id = $3`;

/**
 * Ring each changed row's requester at its moment (bellOf), in `db`'s
 * transaction, and resolve the pushes that tell their open tabs their bell
 * moved. Rows with no moment, of no requester, of a change or a first
 * version ring nothing.
 */
/**
 * Pure (16 Oct 2026, kept): a moment that asks nothing new of its requester
 * rings nobody, though its stage still shows where it waits. An older
 * request's first read (`read_reason` 'backlog') rings only when its change
 * is ready, and a hand-off that names who builds it (`builder`) asks the
 * requester nothing.
 */
function quietBell(bell, facts, item = null) {
  // T2.9: a build its requester stopped tells them nothing they did not do.
  if (bell === 'stopped') {
    const { cause, names } = causeOfItem(item || {});
    return cause === 'stopped' && !!facts?.requester_username && names[0] === facts.requester_username;
  }
  if (bell !== 'needs_you') return false;
  return facts?.read_reason === 'backlog' || !!(facts?.builder && String(facts.builder).trim());
}

/**
 * Pure (review B3): the key of the moment a changed row rings: its item, its
 * stage with the why or reason that made it a moment (bellOf), and since
 * when. Stored on the bell (notifications.bell_key).
 */
function bellKeyOf(row) {
  const st = row && row.state ? row.state : {};
  return ['work', row.kind, Number(row.appId), Number(row.ref), st.stage, st.why || st.reason || '', iso(st.since) || ''].join(':');
}

async function bellPushes(db, changed) {
  const pushes = [];
  for (const row of changed || []) {
    const userId = Number(row.state?.requesterId) || 0;
    if (!row.bell || row.kind !== 'request' || !userId || !BELL_KINDS[row.bell]) continue;
    const { rows: [f] } = await db.query(BELL_FACTS_SQL, [row.appId, row.issueNumber, userId]);
    if (!f || f.first_version === true || !f.bot_id) continue;
    if (quietBell(row.bell, f, row.state)) continue;
    const said = bellSaid(row.bell, row.state, { group: Number(f.members) > 1 });
    const reason = row.state.line?.code === 'reason' ? row.state.line.text : null;
    // T2.9, T2.10: who a stop or a hand-back names (who stopped it, who decides).
    const { names } = causeOfItem(row.state);
    const detail = require('./homeroom-bot-notify-copy').botNotificationDetail({
      moment: row.bell, said, appName: f.name || f.slug, appSlug: f.slug, issueNumber: row.issueNumber,
      requestTitle: f.issue_title || null, ...(reason ? { reason } : {}),
      ...(said === 'decide_others' && names.length ? { deciders: names } : {}),
      ...(said === 'stopped_by' && names.length ? { stoppedBy: names[0] } : {}),
    });
    // Its push goes out from the row (notifications_enqueue_mobile_push_
    // deliveries); "ready to try" also owes the email that stands in for the
    // push when no phone can take it (activity-mail.js noticeMailTargets).
    // No chat is its home (notifications.js STAGE_BELL_SQL): its change, by
    // which a merge settles it (change-notifications.ts settleDecidedChange).
    // B3: once per moment. A move stored twice (an older reading of its
    // facts written over a newer one, put right a few seconds later) is the
    // same item, stage and since, and rings nothing while its bell is still
    // unread. A real return to the moment (an update that withdrew its
    // "ready to try", then its vote again) finds its old bell read.
    const { rows: rang } = await db.query(
      `INSERT INTO notifications (user_id, source_user_id, kind, detail, app_id, session_id, mailed_at, bell_key)
       SELECT $1, $2, $3::text, $4, $5, $6, CASE WHEN $3::text = 'build_ready' THEN NULL ELSE NOW() END, $7::text
        WHERE NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_user_id = $2)
          AND NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.user_id = $1 AND n.read_at IS NULL AND n.bell_key = $7::text)
       RETURNING id`,
      [userId, f.bot_id, BELL_KINDS[row.bell], detail, row.appId, Number(row.sessionId) || null, bellKeyOf(row)],
    );
    if (rang.length) pushes.push({ kind: 'user', routing: { userId }, data: { type: 'notifications_changed' } });
  }
  return pushes;
}

/**
 * #6441: "Ready to try" outlives the change being ready. When a request's
 * stage leaves for building (an update or a fix under way), the
 * "ready to try" it rang is no longer true, so its unread row is withdrawn:
 * marked read and mailed, never deleted (the row stays in All, and no email
 * goes out for it). The move back to up_for_vote rings a fresh one through
 * bellOf. A stage move that does not rebuild (up_for_vote to checking) is
 * not a withdraw. A request row only: a change with no request is not rung
 * by its stage.
 */
async function withdrawReady(db, changed) {
  const pushes = [];
  const told = new Set();
  for (const row of changed || []) {
    if (row.kind !== 'request') continue;
    const sessionId = Number(row.sessionId) || 0;
    // Only an update or a fix under way rebuilds it: one that is only queued
    // takes nothing back yet (11 Nov 2026: building, update_queued).
    if (!sessionId || row.state?.stage !== 'building' || queuedUpdate(row.state)) continue;
    if (!row.prev || (row.prev.stage === 'building' && !queuedUpdate(row.prev))) continue;
    const { rows } = await db.query(
      `UPDATE notifications
          SET read_at = NOW(), mailed_at = COALESCE(mailed_at, NOW())
        WHERE session_id = $1 AND kind = 'build_ready' AND read_at IS NULL
        RETURNING user_id`,
      [sessionId],
    );
    for (const r of rows) {
      const userId = Number(r.user_id) || 0;
      if (!userId || told.has(userId)) continue;
      told.add(userId);
      pushes.push({ kind: 'user', routing: { userId }, data: { type: 'notifications_changed' } });
    }
  }
  return pushes;
}

/**
 * Step 3 (11 Nov 2026): the buttons of Homeroom bot's cards about rows that
 * moved, which their new standings no longer keep (bot-cards.js
 * retireOnMove, the one table), retired; and each item whose cards went
 * derived again at once, so its standing no longer lists them among its
 * open cards (a retire marks nothing: migration
 * work-state-backfill-and-indexes). Resolves the pushes of the messages
 * they were under and of the rows derived again. Inside a transition this
 * is its transaction's; the drain runs it after its own commits
 * (drainDirty).
 */
async function settleCards(db, changed, depth = 0) {
  const cards = require('./bot-cards');
  const pushes = [];
  const again = [];
  for (const row of changed || []) {
    // Buttons are judged on a move only (bot-cards.js moved).
    if (!cards.moved(row.prev, row.state)) continue;
    const item = row.kind === 'request' ? { appId: row.appId, issueNumber: row.issueNumber } : { sessionId: row.sessionId };
    const out = await cards.inTransaction(db, (tx) => cards.retireOnMove(tx, { ...item, standing: row.state, prev: row.prev }));
    pushes.push(...out.pushes);
    if (out.retired) again.push(item);
  }
  if (again.length) {
    // Its open cards changed and nothing else did, unless a write landed
    // meanwhile: a move found here rings and retires like any other, once
    // more at most.
    const moved = await refresh(db, again);
    pushes.push(...await pushesOf(db, moved, { cards: false }));
    if (depth < 1) pushes.push(...await settleCards(db, moved, depth + 1));
  }
  return pushes;
}

/**
 * Pure (19 Nov 2026): whether a changed row is a change that has just
 * opened for votes (its stored vote_open turned true), the moment its
 * project's voters are asked to come and vote (votePings).
 */
function openedForVotes(row) {
  return !!row && row.kind === 'change' && row.state?.voteOpen === true && !(row.prev && row.prev.voteOpen === true);
}

/**
 * 19 Nov 2026 (docs/plans/bot-one-model.md, step 1's last reader): the "new
 * proposal to vote on" ping, rung from the stored row as the requester's
 * bell is: each changed change whose row just opened for votes asks its
 * project's voters (workflow/rules/proposal-notifications.ts
 * createPrProposedNotifications, which reads the same row and asks nobody
 * twice), in `db`'s transaction, and resolves the pushes that tell their
 * open tabs. It went out from the transitions that settled a change's
 * checks or its conflict before, on a predicate of its own (#6402), and
 * asked while its shots, an update on its way or GitHub still held the vote
 * that Needs you did not list yet.
 */
async function votePings(db, changed) {
  const pushes = [];
  for (const row of changed || []) {
    if (!openedForVotes(row)) continue;
    const sessionId = Number(row.sessionId || row.ref);
    // T2.6 (19 Nov 2026): one of Homeroom bot's changes asks the people who
    // must approve it ("ready to try", change_ready) now, not when its checks
    // and shots alone said so (homeroom-bot-dm.js tellReady); the "new
    // proposal to vote on" ping below leaves them out, so nobody hears both.
    // Its own unit: a read that fails asks nobody and leaves the rest standing.
    const notifications = require('./notifications');
    const rang = await unit(db, async (tx) => {
      const ready = await require('./homeroom-bot-dm').approversOnOpen(tx, sessionId);
      if (!ready || !ready.recipients.length) return [];
      return notifications.createChangeReadyNotifications(tx, {
        appId: ready.appId, sessionId, sourceUserId: ready.requesterId, recipientIds: ready.recipients, epoch: ready.epoch,
      });
    }).catch((err) => {
      require('./logger').warn('work-state', 'Could not ask who must approve a change that opened for votes', { sessionId, message: err.message });
      return [];
    });
    for (const n of rang || []) {
      pushes.push({ kind: 'user', routing: { userId: Number(n.user_id) }, data: { type: 'notification_new', notificationId: Number(n.id) } });
    }
    const made = await notifications.createPrProposedNotifications(db, {
      appId: Number(row.appId), sessionId, proposerId: row.state.requesterId ?? null,
    });
    for (const n of made || []) {
      pushes.push({ kind: 'user', routing: { userId: Number(n.user_id) }, data: { type: 'notification_new', notificationId: Number(n.id) } });
    }
  }
  return pushes;
}

/**
 * Pure (review A3): whether a changed row is a change that has just become
 * ready to try (rules/bot-readiness.ts readyToTry: its stored vote_open
 * turned true, or it is a first version now going live without a vote), the
 * moment Homeroom bot's change machine sends its requester the "ready to
 * try" card.
 */
function tryOpened(row) {
  return !!row && row.kind === 'change' && readyToTry(row.state) && !(row.prev && readyToTry(row.prev));
}

// Tell Homeroom bot's change machine (src/workflow/bot-change/) that the
// stored row of each change named by $1 says it is ready to try: a plain
// pending event, appended as a vote's is (routes/votes.js botChangeVotedSql),
// only for a change the machine follows and has not finished with.
const BOT_CHANGE_OPENED_SQL = `
  INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
  SELECT wi.machine, wi.key, wi.app_id, 'VoteOpened', jsonb_build_object('sessionId', x.id),
         '{"kind":"route","name":"work-state"}'::jsonb, NULL, 'vote-opened:' || gen_random_uuid(), NULL
    FROM unnest($1::int[]) AS x(id)
    JOIN wf_instances wi ON wi.machine = 'bot-change' AND wi.key = 'session:' || x.id
   WHERE wi.state NOT IN ('merged', 'live', 'closed')
  RETURNING id`;

/**
 * Review A3 (19 Nov 2026): "ready to try" has one decider, the stored row.
 * Each changed change that has just become ready to try (tryOpened) is told
 * to the bot's change machine, in `db`'s transaction, with the row that says
 * so: the machine reads the row again and sends the card (it kept a rule of
 * its own before, which knew nothing of a conflict with main, a merge GitHub
 * holds or an update on its way). Its own unit: a failed append leaves the
 * rows stored, and the sweep tells the machine again (botChangesWaiting).
 * Resolves how many were told.
 */
async function botChangesOpened(db, changed) {
  const ids = [...new Set((changed || []).filter(tryOpened).map((row) => Number(row.sessionId || row.ref)).filter((id) => id > 0))];
  if (!ids.length) return 0;
  return unit(db, async (tx) => (await tx.query(BOT_CHANGE_OPENED_SQL, [ids])).rows.length).catch((err) => {
    require('./logger').warn('work-state', 'Could not tell the bot\'s change machine a change is ready to try', { ids, message: err.message });
    return 0;
  });
}

// The bot's changes whose stored row says ready to try while their machine
// still waits to hear it and has told nobody for this approval epoch: a row
// opened where no event could be appended with it (a Pod of the release
// before this one stored it, or the append failed). `deadline_at`: a machine
// waiting on its own clock (its plan being compared) is not waiting to hear.
const BOT_CHANGES_WAITING_SQL = `
  SELECT cs.id
    FROM work_states ws
    JOIN chat_sessions cs ON cs.id = ws.item_ref AND cs.status = 'promoted'
    JOIN wf_instances wi ON wi.machine = 'bot-change' AND wi.key = 'session:' || cs.id
   WHERE ws.item_kind = 'change'
     AND (ws.vote_open OR (ws.stage = 'going_live' AND ws.line->>'code' = 'first_version'))
     AND wi.state IN ('checking', 'waiting_on_shots') AND wi.deadline_at IS NULL
     AND COALESCE(wi.data->>'told', '') <> cs.approval_epoch::text
     AND ws.updated_at < NOW() - INTERVAL '1 minute'
     AND NOT EXISTS (SELECT 1 FROM wf_events e
                      WHERE e.machine = wi.machine AND e.key = wi.key AND e.type = 'VoteOpened' AND e.status = 'pending')
   ORDER BY cs.id
   LIMIT 20`;

/** The sweep's part of botChangesOpened: tell the machine of each change it still waits to hear about. Never throws. */
async function botChangesWaiting(db) {
  try {
    const { rows } = await db.query(BOT_CHANGES_WAITING_SQL);
    if (!rows.length) return 0;
    return (await db.query(BOT_CHANGE_OPENED_SQL, [rows.map((r) => Number(r.id))])).rows.length;
  } catch (err) {
    require('./logger').warn('work-state', 'Could not read the bot\'s changes still waiting to hear they are ready to try', { message: err.message });
    return 0;
  }
}

/**
 * The pushes changed rows are carried by: their work_state, the bell of each
 * that rang, the voters asked about each change that opened for votes, each
 * ready one withdrawn, and the cards their move retired (settleCards;
 * `cards: false` leaves those to the caller). Homeroom bot's change machine
 * is told of each of its changes that became ready to try (botChangesOpened).
 */
async function pushesOf(db, changed, { cards = true } = {}) {
  const pushes = [
    ...changed.map(pushOf), ...(await bellPushes(db, changed)), ...(await votePings(db, changed)),
    ...(await withdrawReady(db, changed)),
  ];
  await botChangesOpened(db, changed);
  return cards ? [...pushes, ...(await settleCards(db, changed))] : pushes;
}

/**
 * The workflow's afterAccepted hook (kernel/pipeline.ts): refresh what an
 * accepted event's instance is about, in its own transaction, and resolve
 * the pushes of what changed, each moment's bell rung with it (bellPushes).
 */
async function afterTransition(db, info) {
  const items = await itemsOf(db, info);
  if (!items.length) return [];
  return pushesOf(db, await refresh(db, items));
}

// ── Reading the store ────────────────────────────────────────────────────

/** A person's own items (their requests' rows and their changes'), newest first. */
async function forRequester(db, userId, { limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.requester_id = $1
      ORDER BY ws.updated_at DESC
      LIMIT $2`,
    [Number(userId), Math.max(1, Math.min(Number(limit) || 200, 500))],
  );
  return rows.map(fromRow);
}

/** The stored rows of named requests on one app, by number. */
async function forRequests(db, appId, numbers) {
  const list = [...new Set((numbers || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return new Map();
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.app_id = $1 AND ws.item_kind = 'request' AND ws.item_ref = ANY($2::int[])`,
    [Number(appId), list],
  );
  return new Map(rows.map((r) => [Number(r.item_ref), fromRow(r)]));
}

/**
 * The stored rows of named requests ({ appId, issueNumber }) on any project,
 * made first for any that has none yet, in the order named.
 */
async function forItems(db, items) {
  const list = (items || []).filter((it) => Number(it.appId) > 0 && Number(it.issueNumber) > 0);
  if (!list.length) return [];
  await ensure(db, list);
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.item_kind = 'request'
        AND (ws.app_id, ws.item_ref) IN (SELECT * FROM unnest($1::int[], $2::int[]))`,
    [list.map((it) => Number(it.appId)), list.map((it) => Number(it.issueNumber))],
  );
  const byKey = new Map(rows.map((r) => [`${r.app_id}:${r.item_ref}`, fromRow(r)]));
  return list.map((it) => byKey.get(`${Number(it.appId)}:${Number(it.issueNumber)}`)).filter(Boolean);
}

/** The stored rows of named changes, by session id, made first for any that has none yet. */
async function forChanges(db, sessionIds, { ensure: make = true } = {}) {
  const list = [...new Set((sessionIds || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return new Map();
  if (make) await ensureChanges(db, list);
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.item_kind = 'change' AND ws.item_ref = ANY($1::int[])`,
    [list],
  );
  return new Map(rows.map((r) => [Number(r.item_ref), fromRow(r)]));
}

/** Pure: a stored row as the readers take it (shapeOf). */
function fromRow(r) {
  return shapeOf({
    appId: r.app_id,
    app: r.slug ? { slug: r.slug, name: r.app_name || r.slug } : null,
    kind: r.item_kind,
    ref: r.item_ref,
    issueNumber: r.issue_number,
    sessionId: r.session_id,
    stage: r.stage,
    why: r.why,
    reason: r.reason,
    line: r.line,
    whoseMove: r.whose_move,
    requesterId: r.requester_id,
    since: r.since,
    updatedAt: r.updated_at,
    voteOpen: r.vote_open === true,
    leadChangeId: r.lead_change_id,
    standing: r.standing,
  });
}

/**
 * Pure (11 Nov 2026): a row as anybody but its requester may read it. What
 * is asked of its requester is said as whether it is, never with what is
 * theirs alone: no message of their chat with Homeroom bot (its open
 * question), no private thread of theirs (a plan they are drafting), none of
 * its cards (one in their chat is theirs; `openOffers` counts them), and
 * nobody's id. The scoped push carries this shape to every viewer of the
 * project (pushOf); a reader hands the whole row to its requester only
 * (forViewer).
 */
function publicOf(row) {
  if (!row) return null;
  const asks = row.asks && typeof row.asks === 'object' ? row.asks : NO_ASKS;
  const offers = Array.isArray(asks.offers) ? asks.offers : [];
  return {
    ...row,
    requesterId: null,
    asks: {
      question: asks.question ? { messageId: null, at: asks.question.at || null } : null,
      plan: asks.plan || null,
      closeVote: asks.closeVote || null,
      draft: asks.draft ? { threadId: null } : null,
      offers: [],
      openOffers: offers.length,
      reports: Number(asks.reports) || 0,
    },
  };
}

/**
 * Pure: a row as one viewer reads it, with the per-viewer facts the store
 * never holds: `mine` (they asked for it, or decide on its project) and
 * `voteOwed` (its change is open for votes, and they still owe a vote).
 * Anybody but its requester (`viewerId`) reads it as publicOf says.
 */
function forViewer(row, { mine = false, voteOwed = false, viewerId = null, myVote = null } = {}) {
  if (!row) return null;
  const theirs = viewerId != null && row.requesterId != null && Number(row.requesterId) === Number(viewerId);
  const vote = myVote === 'yes' || myVote === 'no' ? myVote : null;
  return { ...(theirs ? row : publicOf(row)), mine: !!mine, voteOwed: !!voteOwed, ...(vote ? { myVote: vote } : {}) };
}

// ── The sweep ────────────────────────────────────────────────────────────

// Some stages move on by time alone: a build that never started stalls
// (progress.START_GRACE_MS), a reply's "about to read" lapses
// (progress.REPLY_WAIT_MS), a hold until Monday ends, a claim lapses, a
// change's shots stop holding its vote. T2.7 (19 Nov 2026): each row says
// when (`standing.dueAt`, dueOf), and the sweep reads the rows that are due.
// It read every row not closed, oldest checked first, 100 a minute, and that
// population only grew: every stopped and waiting-for-you row, forever, and
// a building row for every person's change with no request, none of which
// moves by time. A fact written where no machine or route refreshes its
// item is still caught: a few of the rows still moving (the bot's or the
// group's move), the longest unchecked first. And it seeds a row for each
// request the bot knows that has none yet.
const SWEEP_MOVING_SQL = `
  SELECT ws.app_id, ws.item_kind, ws.item_ref FROM work_states ws
   WHERE ws.stage IN ('reading', 'planning', 'building', 'checking', 'up_for_vote', 'going_live')
     AND NOT (ws.item_kind = 'request' AND ws.stage = 'reading' AND COALESCE(ws.line->>'code', '') = 'waiting')
     -- A person's change with no request of its own, being worked on: it
     -- moves only when the change is written (its marks).
     AND NOT (ws.item_kind = 'change' AND ws.stage = 'building'
              AND NOT EXISTS (SELECT 1 FROM work_states r
                               WHERE r.item_kind = 'request' AND r.app_id = ws.app_id AND r.session_id = ws.item_ref))
     AND ws.checked_at < NOW() - make_interval(secs => $1)
   ORDER BY ws.checked_at ASC LIMIT $2`;

// Rows an older derive wrote: derived again once, the longest unchecked
// first. B3: which derive wrote a row is its own column, and the standing's
// `v` for the Pods of the release before this one, which write only that;
// the lower of the two counts (versionOf), so a row such a Pod wrote again
// during a release is derived again after it.
const SWEEP_OLDER_SQL = `
  SELECT app_id, item_kind, item_ref FROM work_states
   WHERE stage <> 'closed'
     AND LEAST(COALESCE(derive_version, 0), COALESCE((standing->>'v')::int, 0)) < $1
   ORDER BY checked_at ASC LIMIT $2`;

const SWEEP_DUE_SQL = `
  SELECT app_id, item_kind, item_ref FROM work_states
   WHERE stage <> 'closed' AND standing ? 'dueAt'
     AND (standing->>'dueAt')::timestamptz <= NOW()
   ORDER BY (standing->>'dueAt')::timestamptz ASC LIMIT $1`;

async function sweep(db, { olderThanMs = 2 * 60 * 1000, limit = 100, seed = 100, moving = null } = {}) {
  const { rows: due } = await db.query(SWEEP_DUE_SQL, [limit]);
  const { rows: still } = await db.query(SWEEP_MOVING_SQL, [Math.round(olderThanMs / 1000), moving == null ? limit : moving]);
  const { rows: older } = await db.query(SWEEP_OLDER_SQL, [DERIVE_VERSION, Math.max(1, Math.round(limit / 2))]);
  const seen = new Set();
  const rows = [...due, ...still, ...older].filter((r) => {
    const k = `${r.app_id}:${r.item_kind}:${r.item_ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const { rows: missing } = seed > 0 ? await db.query(
    `SELECT k.app_id, k.issue_number FROM (
       SELECT app_id, issue_number, MAX(at) AS at FROM (
         SELECT app_id, issue_number, created_at AS at FROM homeroom_bot_requesters
         UNION ALL SELECT app_id, issue_number, created_at FROM homeroom_bot_runs WHERE mode = 'live'
         UNION ALL SELECT app_id, issue_number, enqueued_at FROM homeroom_bot_queue
       ) x GROUP BY app_id, issue_number
     ) k
     WHERE NOT EXISTS (SELECT 1 FROM work_states ws
                        WHERE ws.app_id = k.app_id AND ws.item_kind = 'request' AND ws.item_ref = k.issue_number)
       AND EXISTS (SELECT 1 FROM apps a WHERE a.id = k.app_id)
     ORDER BY k.at DESC LIMIT $1`,
    [seed],
  ) : { rows: [] };
  // 11 Nov 2026: and a row for each change up for a vote or going live that
  // has none yet (a change built for a request had none before), so Needs
  // you finds every change open for votes.
  const { rows: missingChanges } = seed > 0 ? await db.query(
    `SELECT cs.id FROM chat_sessions cs
      WHERE cs.status IN ('promoted', 'merging') AND cs.is_headless = FALSE
        AND NOT EXISTS (SELECT 1 FROM work_states ws WHERE ws.item_kind = 'change' AND ws.item_ref = cs.id)
      ORDER BY cs.id DESC LIMIT $1`,
    [seed],
  ) : { rows: [] };
  const items = [
    ...rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) })),
    ...missing.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })),
    ...missingChanges.map((r) => ({ sessionId: Number(r.id) })),
  ];
  // T2.6: whoever asked to be told when a change is ready to vote on hears
  // it once its row opens for votes, never before.
  const told = await tellVoteFollowups(db);
  // Review A3: and Homeroom bot's change machine hears of each change whose
  // row says ready to try that it has not heard about.
  if (isPool(db)) await botChangesWaiting(db);
  if (!items.length) {
    return { checked: 0, seeded: 0, due: 0, changed: [], pushes: [], told, ...(await sweepMeasure(db)) };
  }
  // T2.8: each batch (and, when it throws, each item) stores its rows and
  // rings their bells together.
  const out = await refreshUnits(db, items, { touch: true });
  for (const f of out.failed) {
    require('./logger').warn('work-state', 'The sweep could not derive an item again', { item: f.item, message: f.error && f.error.message });
  }
  let cards = [];
  if (out.changed.length) {
    try {
      cards = await settleCards(db, out.changed);
    } catch (err) {
      require('./logger').warn('work-state', 'Retiring the cards of moved rows failed', { message: err.message });
    }
  }
  return {
    checked: rows.length,
    due: due.length,
    seeded: missing.length + missingChanges.length,
    changed: out.changed,
    pushes: [...out.pushes, ...cards],
    told,
    ...(await sweepMeasure(db)),
  };
}

// T2.6 (19 Nov 2026): the changes open for votes now with somebody still
// waiting to be told they are ready to vote on (homeroom_bot_followups
// 'vote'), by the change or by a request it closes.
const VOTE_FOLLOWUPS_SQL = `
  SELECT DISTINCT cs.id
    FROM work_states ws
    JOIN chat_sessions cs ON cs.id = ws.item_ref
   WHERE ws.item_kind = 'change' AND ws.vote_open
     AND EXISTS (SELECT 1 FROM homeroom_bot_followups f
                  WHERE f.event = 'vote' AND f.state = 'waiting'
                    AND (f.session_id = cs.id
                         OR (f.session_id IS NULL AND f.app_id = cs.app_id
                             AND f.issue_number = ANY(COALESCE(cs.linked_issues, '{}'::int[])))))
   LIMIT 20`;

/**
 * T2.6: tell whoever asked to hear when a change is ready to vote on, once
 * its stored row opens for votes (thread-followups.js fire, which no longer
 * tells it while the row says the change cannot take a vote yet: a
 * conflict, an update on its way, its shots). Outside any transaction: each
 * line is a post of its own. Never throws; resolves how many were told.
 */
async function tellVoteFollowups(db) {
  if (!isPool(db)) return 0;
  let told = 0;
  try {
    const { rows } = await db.query(VOTE_FOLLOWUPS_SQL);
    const followups = require('./thread-followups');
    for (const r of rows) {
      told += Number(await followups.fire(db, { sessionId: Number(r.id), event: 'vote' }).catch((err) => {
        require('./logger').warn('work-state', 'Could not tell who asked when a change is ready to vote on', { sessionId: Number(r.id), message: err.message });
        return 0;
      })) || 0;
    }
  } catch (err) {
    require('./logger').warn('work-state', 'Could not read who waits to hear a change is ready to vote on', { message: err.message });
  }
  return told;
}

/**
 * #6821: what the sweep has to get through, so a backlog is visible in the
 * server log rather than only as stale lists: how many open rows there are,
 * how old the longest-unchecked one is (a full cycle takes at least that
 * long), and how many marks the drain has waiting and how old the oldest is.
 * Read after the sweep's own pass. Never throws: a count that cannot be read
 * says nothing rather than failing the sweep.
 */
async function sweepMeasure(db) {
  try {
    const { rows: [m] } = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM work_states WHERE stage <> 'closed') AS open_rows,
              (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(checked_at))) FROM work_states
                WHERE stage <> 'closed') AS oldest_check_age_secs,
              (SELECT COUNT(*)::int FROM work_state_dirty) AS dirty_backlog,
              (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(marked_at))) FROM work_state_dirty) AS oldest_mark_age_secs`,
    );
    return {
      openRows: Number(m.open_rows) || 0,
      oldestCheckAgeSecs: m.oldest_check_age_secs == null ? null : Math.round(Number(m.oldest_check_age_secs)),
      dirtyBacklog: Number(m.dirty_backlog) || 0,
      oldestMarkAgeSecs: m.oldest_mark_age_secs == null ? null : Math.round(Number(m.oldest_mark_age_secs)),
    };
  } catch (err) {
    require('./logger').warn('work-state', 'Could not measure the sweep', { message: err.message });
    return {};
  }
}

/**
 * Derive again what the triggers marked (work_state_dirty: a write to what
 * a work state is derived from, wherever it was made), at most `limit` at a
 * time, and resolve the changed rows. The marks are taken and the items
 * refreshed in one transaction, so a mark made meanwhile waits for it and
 * stays for the next run. T2.8 (19 Nov 2026): each item, with the bells and
 * pings its move owes, is a unit of its own (refreshUnits: a savepoint), so
 * one that throws is undone alone, and its mark is put back at the end of
 * the line, not retaken first on every pass (which stalled the drain behind
 * one deterministic failure); after DRAIN_TRIES failures in a row it is
 * parked (left out, and logged) until it is marked again. The cards their
 * moves retire go after that commit (settleCards). `db` is a pool.
 */
const DRAIN_TRIES = 3;
const drainFailures = new Map();
const markKey = (r) => (r.session_id != null ? `s:${Number(r.session_id)}` : `r:${Number(r.app_id)}:${Number(r.issue_number)}`);
const itemOfMark = (r) => (r.session_id != null
  ? { sessionId: Number(r.session_id) }
  : { appId: Number(r.app_id), issueNumber: Number(r.issue_number) });
const markOfItem = (it) => (it.sessionId != null
  ? { session_id: Number(it.sessionId), app_id: null, issue_number: null }
  : { session_id: null, app_id: Number(it.appId), issue_number: Number(it.issueNumber) });

async function drainDirty(pool, { limit = 200 } = {}) {
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM work_state_dirty
        WHERE id IN (SELECT id FROM work_state_dirty ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING app_id, issue_number, session_id`,
      [limit],
    );
    // Each moment's bell is rung with the stage, in this transaction.
    const done = rows.length ? await refreshUnits(client, rows.map(itemOfMark)) : { changed: [], pushes: [], failed: [], skipped: [] };
    // B3: an item another writer was deriving is marked again, so it is
    // derived after that writer's commit: it may have read the facts before
    // the write this mark stood for.
    for (const item of done.skipped || []) {
      const mark = markOfItem(item);
      await client.query('SELECT work_state_mark($1, $2, $3)', [mark.app_id, mark.issue_number, mark.session_id]);
    }
    const parked = [];
    for (const f of done.failed) {
      const mark = markOfItem(f.item);
      const key = markKey(mark);
      const tries = (drainFailures.get(key) || 0) + 1;
      if (tries >= DRAIN_TRIES) {
        drainFailures.delete(key);
        parked.push(key);
        require('./logger').warn('work-state', 'A marked item keeps failing to derive: parked until it is marked again', {
          item: f.item, tries, message: f.error && f.error.message,
        });
        continue;
      }
      drainFailures.set(key, tries);
      // Back at the end of the line, so the marks behind it move on.
      await client.query('SELECT work_state_mark($1, $2, $3)', [mark.app_id, mark.issue_number, mark.session_id]);
    }
    for (const r of rows) {
      const key = markKey(r);
      if (!done.failed.some((f) => markKey(markOfItem(f.item)) === key)) drainFailures.delete(key);
    }
    await client.query('COMMIT');
    out = { taken: rows.length, changed: done.changed, pushes: done.pushes, failed: done.failed.length, parked };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // The cards their moves retired, once the taken marks are let go: a tap
  // on one of them holds its card and then marks its request, so a drain
  // still holding the marks and reaching for the card would wait on the
  // tap while the tap waits on it. A failure here leaves the rows stored.
  if (out.changed.length) {
    try {
      out.pushes.push(...await settleCards(pool, out.changed));
    } catch (err) {
      require('./logger').warn('work-state', 'Retiring the cards of moved rows failed', { message: err.message });
    }
  }
  return out;
}

/**
 * The rows of requests that have none yet, made now (a reader listing
 * requests from before the table, or one the sweep has not reached), and
 * what that changed published as any refresh's is (touched: the rows'
 * pushes, the bells and the voters' pings their first state owes, the cards
 * their move retires). Review B3: it threw those away, so a row a reader
 * made first never rang its bell nor asked its voters. Resolves the changed
 * rows; never throws (a row it could not make is not read).
 */
async function ensure(db, items) {
  const list = (items || []).filter((it) => Number(it.appId) > 0 && Number(it.issueNumber) > 0);
  if (!list.length) return [];
  const { rows } = await db.query(
    `SELECT x.app_id, x.issue_number FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
      WHERE NOT EXISTS (SELECT 1 FROM work_states ws
                         WHERE ws.app_id = x.app_id AND ws.item_kind = 'request' AND ws.item_ref = x.issue_number)`,
    [list.map((it) => Number(it.appId)), list.map((it) => Number(it.issueNumber))],
  );
  if (!rows.length) return [];
  return touched(db, rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })));
}

/** The rows of changes that have none yet, made now and published (ensure, for changes). Resolves the changed rows. */
async function ensureChanges(db, sessionIds) {
  const list = [...new Set((sessionIds || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return [];
  const { rows } = await db.query(
    `SELECT x.id FROM unnest($1::int[]) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM work_states ws WHERE ws.item_kind = 'change' AND ws.item_ref = x.id)`,
    [list],
  );
  if (!rows.length) return [];
  return touched(db, rows.map((r) => ({ sessionId: Number(r.id) })));
}

module.exports = {
  STAGES,
  WHYS,
  REASONS,
  LIFTED_LIMITS,
  outdatedReason,
  LIVE_DAYS,
  phrasesOf,
  english,
  APPROVED_SQL,
  votesIn,
  stageSays,
  lineSays,
  says,
  busyNow,
  botWorkOf,
  forItems,
  derive,
  deriveChange,
  withUpdate,
  voteOpenOf,
  shotsHeld,
  changeStandingOf,
  requestStandingOf,
  shapeOf,
  publicOf,
  forViewer,
  forChanges,
  ensureChanges,
  STANDING_SQL,
  STANDING_RUNS_SQL,
  DONE_BY_SQL,
  placeFor,
  bellOf,
  REQUEST_FACTS_SQL,
  CHANGE_FACTS_SQL,
  requestsOfSession,
  refresh,
  WATCHED,
  wants,
  itemsOf,
  pushOf,
  bellSaid,
  bellPushes,
  pushesOf,
  settleCards,
  quietBell,
  publish,
  touched,
  afterTransition,
  forRequester,
  forRequests,
  fromRow,
  sweep,
  drainDirty,
  ensure,
  // Review A3: the bot's change machine is told when a row is ready to try.
  tryOpened,
  botChangesOpened,
  botChangesWaiting,
  // Review B3: one writer per item, which derive wrote a row, a bell once per moment.
  takeItems,
  versionOf,
  bellKeyOf,
  DERIVE_VERSION,
  // T2.7, T2.8
  dueOf,
  refreshUnits,
  markPlaces,
  DRAIN_TRIES,
};
