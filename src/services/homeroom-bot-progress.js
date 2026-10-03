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
//
// #3734: the DM's activity tray (homeroom-bot-tray.js) lists under Now what
// this module says is in flight (inFlight below), so the tray and the bot's
// own answer never disagree. They used to read it separately: the tray from
// claimed queue rows alone, so a build (whose queue row is gone) and a
// follow-up waiting its turn showed as nothing while the bot said otherwise.

const MINUTE_MS = 60 * 1000;
// A ready verdict with no build session yet is a build starting. Past this,
// nothing about it is recorded, and that is what is said.
const START_GRACE_MS = 15 * MINUTE_MS;
// What finished lately, for "is it ready yet?".
const FINISHED_WITHIN_DAYS = 14;
const MAX_FINISHED = 3;
const MAX_REQUESTS = 25;

const FIRST_VERSION_STEPS = Object.freeze([
  'Set up the project', 'Read the description', 'Write a plan', 'Build it', 'Run its checks', 'Group vote', 'Live',
]);
const REQUEST_STEPS = Object.freeze([
  'Read the request', 'Write a plan', 'Build it', 'Run its checks', 'Group vote', 'Live',
]);

// Which step each stage is part of. A request's first step is "Read".
const STEP_OF_STAGE = Object.freeze({
  setting_up: 'setup',
  queued: 'read',
  reading: 'read',
  question: 'read',
  held: 'plan',
  starting: 'plan',
  planning: 'plan',
  stalled: 'plan',
  building: 'build',
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
  'setting_up', 'reading', 'revising', 'fixing', 'starting', 'planning', 'building', 'proposing', 'merging',
]);

// #3734: what the bot has in hand for the person: doing this minute, or in
// its queue to be done (a request to read, a follow-up on its proposal).
// Not what waits on them or the group, a proposal's checks running, or a
// build held back or stalled. The activity tray's Now is exactly this.
const IN_FLIGHT_STAGES = new Set([...BUSY_STAGES, 'queued', 'followup_queued', 'fix_queued']);

// app-creation-phase.js PHASES, in words.
const SETUP_PARTS = Object.freeze({
  database: 'making its database',
  repository: 'making its code repository',
  build: 'building it for the first time',
  deploy: 'starting it up',
});

function stepNumber(stage, firstVersion) {
  const key = STEP_OF_STAGE[stage];
  if (!key) return null;
  const order = ['setup', 'read', 'plan', 'build', 'checks', 'vote', 'live'];
  const at = order.indexOf(key);
  return firstVersion ? at + 1 : at;
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function minutesSince(value, now) {
  if (!value) return null;
  const ms = now.getTime() - new Date(value).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / MINUTE_MS)) : null;
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
    return Number.isInteger(n) && n > 0 ? `failed (${plural(n, 'check')} did not pass)` : 'failed';
  }
  if (state === 'error' || state === 'unknown') return 'could not run (the preview or the test run broke)';
  if (state === 'pending' || state === 'running') {
    if (phase === 'building') return 'running: building the preview first';
    const p = progress && typeof progress === 'object' ? progress : {};
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

function links(domain, { slug, number = null, proposal = null }) {
  if (!domain || !slug) return {};
  const base = `https://${domain}/#app/${encodeURIComponent(slug)}`;
  return {
    project: base,
    ...(number ? { request: `${base}/dev/issues/${Number(number)}` } : {}),
    ...(proposal ? { proposal: `${base}/dev/proposals/${Number(proposal)}` } : {}),
  };
}

/**
 * Pure: the stage of one of the person's requests, from one row of
 * requestRows below, or null when nothing about it is in progress.
 * `{ stage, since, doing, waitingOn?, limit? }`, where `limit` names which
 * clock applies ('reading', 'plan' or 'build').
 */
function stageOf(row, { now = new Date() } = {}) {
  const proposalOpen = row.proposal_status === 'promoted' || row.proposal_status === 'merging';
  const it = row.first_version ? 'the description' : 'the request';
  if (proposalOpen) {
    if (row.started_at) {
      return row.queue_reason === 'checks_failing'
        ? { stage: 'fixing', since: row.started_at, doing: 'fixing its failing checks' }
        : { stage: 'revising', since: row.started_at, doing: 'reading the newest replies on its proposal' };
    }
    // #3734: a follow-up waiting its turn (a reply on the proposal, a change
    // asked for in the DM, its own failing checks). Only while it is up for
    // a vote: the loop does not follow up on a proposal being merged.
    if (row.queue_id && row.proposal_status === 'promoted') {
      const at = row.queue_position ? ` (number ${row.queue_position})` : '';
      return row.queue_reason === 'checks_failing'
        ? { stage: 'fix_queued', since: row.enqueued_at, doing: `waiting in the queue${at} to fix its failing checks` }
        : { stage: 'followup_queued', since: row.enqueued_at, doing: `waiting in the queue${at} to follow up on the newest replies on its proposal` };
    }
    if (row.question_at) {
      return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
    }
    if (row.proposal_status === 'merging') {
      return { stage: 'merging', since: null, doing: 'approved; merging it now' };
    }
    const checks = checksWords({ ...row, failed_checks: row.failed_checks ?? failedCount(row.test_results) });
    if (row.check_state === 'passing' || row.check_state === 'skipped') {
      return { stage: 'vote', since: row.proposal_at, doing: 'its proposal is up for the group\'s vote', waitingOn: 'the group' };
    }
    if (row.check_state === 'failing' || row.check_state === 'error' || row.check_state === 'unknown') {
      return { stage: 'checks_failed', since: row.checks_at || row.proposal_at, doing: `its proposal is up, and its checks ${checks}` };
    }
    return { stage: 'checks', since: row.checks_at || row.proposal_at, doing: `its proposal is up, and its checks are ${checks}` };
  }
  if (row.started_at) {
    return { stage: 'reading', since: row.started_at, doing: `reading ${it} to decide whether to ask a question or build it`, limit: 'reading' };
  }
  if (row.question_at) {
    return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
  }
  // The newest look decided to build it, and nothing has finished it yet.
  if (row.mode === 'live' && row.verdict === 'ready' && row.build_ok == null && !row.run_proposal) {
    if (row.cap_suppressed) {
      return {
        stage: 'held',
        since: row.run_at,
        doing: row.cap_suppressed === 'proposals_per_app' || row.cap_suppressed === 'proposals_total'
          ? 'ready to build, but held back until one of the open proposals is merged or closed (only so many may be open at once)'
          : 'ready to build, but held back by the daily limit on questions and notes on this project',
      };
    }
    if (!row.build_session_id) {
      if (now.getTime() - new Date(row.run_at).getTime() <= START_GRACE_MS) {
        return { stage: 'starting', since: row.run_at, doing: 'starting a workspace to build it in' };
      }
      return { stage: 'stalled', since: row.run_at, doing: 'it was found ready to build, but nothing about the build has been recorded since' };
    }
    if (row.build_status === 'archived') return null;
    if (row.build_status === 'paused' || row.build_status === 'promoted') {
      return { stage: 'proposing', since: row.build_last_activity || null, doing: 'the build finished; opening its proposal now' };
    }
    // Building once its plan is posted, or once the build turn itself runs
    // (a plan that failed is not posted, and the build goes ahead without).
    if (row.spec_at || row.build_turn_mode === 'build') {
      return { stage: 'building', since: row.spec_at || row.build_turn_at || row.build_started_at, doing: 'building it', limit: 'build' };
    }
    return { stage: 'planning', since: row.build_started_at || row.run_at, doing: 'writing the plan for the build', limit: 'plan' };
  }
  if (row.queue_id) {
    const at = row.queue_position ? ` (number ${row.queue_position})` : '';
    return { stage: 'queued', since: row.enqueued_at, doing: `waiting in the queue${at} to be read` };
  }
  return null;
}

/** Pure: what a request that is not in progress came to, or null. */
function outcomeOf(row) {
  if (row.proposal_status === 'merged') return 'approved and live';
  if (row.proposal_status === 'closed') return 'its proposal was closed without merging';
  if (row.mode !== 'live') return null;
  if (row.build_ok === false) return `the build did not succeed${row.build_error ? `: ${String(row.build_error).slice(0, 200)}` : ''}`;
  switch (row.verdict) {
    case 'person': return 'left for the group to decide';
    case 'empty': return 'nothing to build was found in it';
    case 'failed': return 'the last look at it failed';
    default: return null;
  }
}

/** The time limits of the steps that have one, in minutes, for this request. */
function limitsFor(row, { settings, config, botSvc }) {
  try {
    const turnSeconds = Number(settings?.turnSeconds) || botSvc.DEFAULTS.turnSeconds;
    const budgets = botSvc.buildBudgets({ repo_url: row.repo_url }, config || {}, turnSeconds * 1000, {
      firstVersion: !!row.first_version,
    });
    return {
      reading: Math.round(turnSeconds / 60),
      plan: Math.round(budgets.specBudgetMs / MINUTE_MS),
      build: Math.round(budgets.turnBudgetMs / MINUTE_MS),
    };
  } catch {
    return {};
  }
}

/**
 * Every request recorded as the person's (homeroom_bot_requesters), and
 * anything of theirs waiting in the bot's queue, with each record the steps
 * above read. Newest first.
 */
async function requestRows(pool, userId) {
  const { rows } = await pool.query(
    `WITH mine AS (
       SELECT r.app_id, r.issue_number, r.issue_title, r.first_version
         FROM homeroom_bot_requesters r WHERE r.user_id = $1
       UNION
       SELECT q.app_id, q.issue_number, i.title, FALSE
         FROM homeroom_bot_queue q
         JOIN issues i ON i.app_id = q.app_id AND i.github_issue_number = q.issue_number
        WHERE i.created_by = $1
          AND NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters r2
                           WHERE r2.app_id = q.app_id AND r2.issue_number = q.issue_number)
     )
     SELECT m.app_id, a.slug, a.name, a.repo_url, m.issue_number, m.issue_title, m.first_version,
            q.id AS queue_id, q.started_at, q.enqueued_at, q.reason AS queue_reason,
            run.id AS run_id, run.mode, run.verdict, run.created_at AS run_at, run.duration_ms AS run_duration_ms,
            run.cap_suppressed,
            run.build_ok, run.build_error, run.build_session_id, run.proposal_session_id AS run_proposal,
            bs.status AS build_status, bs.created_at AS build_started_at, bs.last_activity_at AS build_last_activity,
            bs.active_turn->>'mode' AS build_turn_mode, bs.active_turn->>'startedAt' AS build_turn_at,
            spec.created_at AS spec_at,
            prop.proposal_session_id, cs.status AS proposal_status, cs.check_state, cs.check_phase,
            cs.checks_progress, cs.checks_checked_at AS checks_at, cs.test_results,
            COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.merged_at,
            oq.created_at AS question_at
       FROM mine m
       JOIN apps a ON a.id = m.app_id
       LEFT JOIN homeroom_bot_queue q ON q.app_id = m.app_id AND q.issue_number = m.issue_number
       LEFT JOIN LATERAL (
         SELECT id, mode, verdict, created_at, duration_ms, cap_suppressed, build_ok, build_error, build_session_id,
                proposal_session_id
           FROM homeroom_bot_runs
          WHERE app_id = m.app_id AND issue_number = m.issue_number
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
          WHERE app_id = m.app_id AND issue_number = m.issue_number AND proposal_session_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
       ) prop ON TRUE
       LEFT JOIN chat_sessions cs ON cs.id = prop.proposal_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_dm_messages
          WHERE user_id = $1 AND app_id = m.app_id AND issue_number = m.issue_number AND question_status = 'open'
          ORDER BY created_at DESC LIMIT 1
       ) oq ON TRUE
      ORDER BY GREATEST(COALESCE(run.created_at, 'epoch'::timestamptz), COALESCE(q.enqueued_at, 'epoch'::timestamptz),
                        COALESCE(q.started_at, 'epoch'::timestamptz)) DESC
      LIMIT ${MAX_REQUESTS}`,
    [userId],
  );
  return rows;
}

/** Where each of `rows`' waiting requests is in the live queue, by queue id. */
async function queuePositions(pool, rows, settings) {
  const position = new Map();
  const liveSlugs = [...new Set([...(settings?.liveApps || []), ...(settings?.firstVersionApps || [])])];
  if (!liveSlugs.length || !rows.some((r) => r.queue_id && !r.started_at)) return position;
  const { rows: queue } = await pool.query(
    `SELECT q.id FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      WHERE q.started_at IS NULL AND a.slug = ANY($1::text[])
      ORDER BY q.priority, q.enqueued_at LIMIT 500`,
    [liveSlugs],
  );
  queue.forEach((q, i) => position.set(Number(q.id), i + 1));
  return position;
}

/**
 * A proposal's facts as the DM reads them: its title, where it stands, its
 * checks in words, the votes for and against and how many it needs, and its
 * link. Null when there is no such proposal.
 */
async function proposalFacts(pool, sessionId, { domain = null } = {}) {
  if (!sessionId) return null;
  const revision = require('./pr-vote-revision');
  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, a.slug, cs.status, cs.check_state, cs.check_phase, cs.checks_progress,
            cs.test_results, cs.session_title, cs.pr_title, cs.promoted_at, cs.created_at,
            (SELECT COUNT(*)::int FROM pr_votes pv WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${revision.currentVotePredicateSql('pv', 'cs')}) AS yes,
            (SELECT COUNT(*)::int FROM pr_votes pv WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${revision.currentVotePredicateSql('pv', 'cs')}) AS no
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [sessionId],
  );
  const s = rows[0];
  if (!s) return null;
  let needed = null;
  if (s.status === 'promoted') {
    try {
      const governance = require('./governance');
      const gov = await governance.getGovernance(pool, s.app_id);
      const electorate = await governance.getElectorate(pool, s.app_id, gov);
      needed = governance.computeGate(gov, electorate.active, s.yes, s.no, s.promoted_at || s.created_at).required;
    } catch { needed = null; }
  }
  const link = links(domain, { slug: s.slug, proposal: s.id }).proposal;
  return {
    proposal: Number(s.id),
    title: s.session_title || s.pr_title || null,
    status: { promoted: 'up for a vote', merging: 'being merged', merged: 'merged and live', closed: 'closed' }[s.status] || s.status,
    checks: checksWords({ ...s, failed_checks: failedCount(s.test_results) }),
    yesVotes: s.yes,
    noVotes: s.no,
    votesNeeded: Number.isFinite(needed) ? needed : null,
    ...(link ? { link } : {}),
  };
}

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

/** Pure: whether a `progressFor` entry is in the bot's hands now (IN_FLIGHT_STAGES). */
function inFlight(item) {
  return !!item && IN_FLIGHT_STAGES.has(item.stage) && !item.waitingOn;
}

function entry({ row, number = null, title = null, firstVersion, state, proposal = null, limits = {}, domain, now }) {
  const steps = firstVersion ? FIRST_VERSION_STEPS : REQUEST_STEPS;
  const step = stepNumber(state.stage, firstVersion);
  const minutes = minutesSince(state.since, now);
  const limit = state.limit && Number.isFinite(limits[state.limit]) ? limits[state.limit] : null;
  return {
    project: row.slug,
    projectName: row.name || row.slug,
    ...(number ? { number: Number(number) } : {}),
    title: firstVersion ? 'First version' : (title || null),
    ...(firstVersion ? { firstVersion: true } : {}),
    stage: state.stage,
    step,
    of: steps.length,
    stepName: step ? steps[step - 1] : null,
    doing: state.doing,
    busyNow: BUSY_STAGES.has(state.stage) && !state.waitingOn,
    ...(state.since ? { since: iso(state.since), minutesSoFar: minutes } : {}),
    ...(limit ? { stepTimeLimitMinutes: limit } : {}),
    ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
    ...(proposal ? { proposal } : {}),
    links: links(domain, { slug: row.slug, number, proposal: proposal?.proposal }),
  };
}

/**
 * Each of the person's requests (requestRows), newest first, beside the
 * stage it is at (stageOf; null when nothing about it is in progress):
 * `{ row, state }`. What progressFor below says of each, and what the
 * activity cards read (homeroom-bot-activity.js catchUpCards) to find the
 * work under way that has no card yet, so the two cannot disagree on what
 * that work is.
 */
async function requestStates(pool, { userId, settings = null, now = new Date() }) {
  // #3734: a queue row is the bot's work only on a project it acts on for
  // real. On any other the queue is its background triage, which says
  // nothing to anybody, so it is neither "waiting in the queue" nor "reading
  // it" for them. Whether the bot is switched on is said apart (botIsOn).
  const acts = settings
    ? new Set([...(settings.liveApps || []), ...(settings.firstVersionApps || [])])
    : null;
  const rows = (await requestRows(pool, userId)).map((row) => (!acts || acts.has(row.slug) ? row : {
    ...row, queue_id: null, started_at: null, enqueued_at: null, queue_reason: null,
  }));
  const position = await queuePositions(pool, rows, settings);
  return rows.map((row) => {
    const queuePosition = row.queue_id ? position.get(Number(row.queue_id)) || null : null;
    return { row, state: stageOf({ ...row, queue_position: queuePosition }, { now }) };
  });
}

/**
 * How far along the bot is with everything it does for `userId`, newest
 * first: `rightNow` (in progress, each with its step of the steps above,
 * what it is doing, since when, the step's time limit and links) and
 * `finishedLately` (the last few that came to something). `facts: false`
 * leaves a proposal as its id alone, without its checks and votes (the
 * activity tray draws no more than that, and reads this on every change).
 */
async function progressFor(pool, { userId, settings = null, config = null, deps = {}, now = new Date(), facts = true }) {
  const botSvc = deps.botSvc || require('./homeroom-bot');
  const phases = deps.creationPhase || require('./app-creation-phase');
  const domain = deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
  const rightNow = [];
  const finished = [];

  for (const row of await firstVersionRows(pool, userId)) {
    const state = setupOf(row, { phase: row.app_status === 'creating' ? phases.read(row.slug) : null });
    if (state.outcome) {
      finished.push({ project: row.slug, projectName: row.name || row.slug, title: 'First version', outcome: state.outcome, links: links(domain, { slug: row.slug }) });
    } else {
      rightNow.push(entry({ row, firstVersion: true, state, domain, now }));
    }
  }

  const cutoff = now.getTime() - FINISHED_WITHIN_DAYS * 24 * 60 * MINUTE_MS;
  for (const { row, state } of await requestStates(pool, { userId, settings, now })) {
    if (state) {
      const open = row.proposal_session_id && row.proposal_status && row.proposal_status !== 'closed';
      let proposal = null;
      if (open) {
        proposal = facts
          ? await proposalFacts(pool, Number(row.proposal_session_id), { domain })
          : { proposal: Number(row.proposal_session_id) };
      }
      rightNow.push(entry({
        row, number: row.issue_number, title: row.issue_title, firstVersion: !!row.first_version, state, proposal,
        limits: state.limit ? limitsFor(row, { settings, config, botSvc }) : {}, domain, now,
      }));
      continue;
    }
    const outcome = outcomeOf(row);
    const when = row.merged_at || row.run_at;
    if (outcome && when && new Date(when).getTime() >= cutoff && finished.length < MAX_FINISHED) {
      finished.push({
        project: row.slug,
        projectName: row.name || row.slug,
        number: Number(row.issue_number),
        title: row.first_version ? 'First version' : (row.issue_title || null),
        outcome,
        when: iso(when),
        links: links(domain, { slug: row.slug, number: row.issue_number, proposal: row.proposal_session_id }),
      });
    }
  }
  return {
    botIsOn: settings?.mode !== 'off',
    rightNow,
    finishedLately: finished.slice(0, MAX_FINISHED),
  };
}

/**
 * Pure: `progressFor`'s answer as a short message in plain words, for the
 * DM to send from the records alone when its model could not answer.
 */
function progressText(progress) {
  const lines = [];
  for (const item of (progress?.rightNow || []).slice(0, 5)) {
    const what = item.number
      ? `${item.projectName} request #${item.number}${item.title ? ` (${item.title})` : ''}`
      : `${item.projectName}, its ${String(item.title || 'first version').toLowerCase()}`;
    const step = item.step ? `step ${item.step} of ${item.of}, ` : '';
    const time = Number.isInteger(item.minutesSoFar)
      ? `, for ${item.minutesSoFar < 1 ? 'under a minute' : plural(item.minutesSoFar, 'minute')} so far`
      : '';
    lines.push(`- ${what}: ${step}${item.doing}${time}.`);
  }
  if (!lines.length) {
    const done = (progress?.finishedLately || [])[0];
    return done
      ? `I'm not working on anything for you right now. Most recently, ${done.projectName}${done.number ? ` request #${done.number}` : ''}: ${done.outcome}.`
      : 'I\'m not working on anything for you right now.';
  }
  const off = progress.botIsOn === false ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : '';
  return `Here is where things stand, from my records:\n\n${lines.join('\n')}${off}`;
}

module.exports = {
  FIRST_VERSION_STEPS,
  REQUEST_STEPS,
  SETUP_PARTS,
  BUSY_STAGES,
  IN_FLIGHT_STAGES,
  START_GRACE_MS,
  inFlight,
  stageOf,
  outcomeOf,
  setupOf,
  stepNumber,
  checksWords,
  failedCount,
  links,
  proposalFacts,
  requestStates,
  progressFor,
  progressText,
};
