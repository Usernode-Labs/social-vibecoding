'use strict';

// #3692: the activity tray in a person's DM with the Homeroom bot.
//
// The DM already carries the bot's news one message at a time (homeroom-
// bot-dm.js): a question, "I'm building this now", the proposal, live. What
// it could not show is the state in between: what the bot is doing for this
// person right now, and what it has done for them before. The tray at the
// top of the DM (frontend/src/features/messages/bot-work.tsx) is that, read
// from the platform's own records of the bot's work and nothing else:
//
//   - NOW: what the bot has in hand for this person, exactly as its own
//     answer to "how far along are you?" reads it (homeroom-bot-progress.js,
//     its entries that are inFlight): a project of theirs being set up, a
//     request it is reading, planning, building or opening a proposal for,
//     a follow-up on its proposal running or waiting its turn, a request
//     waiting in its queue, a proposal being merged. #3734: the tray used to
//     read claimed queue rows alone, and a request leaves the queue once it
//     has been read, before its plan and build, so for a whole build, and for
//     a follow-up waiting its turn, the tray said "not working on anything"
//     while the bot said it was.
//   - HISTORY: the bot's live runs on their requests (homeroom_bot_runs),
//     newest first, each with what came of it and where to open it: the
//     proposal once there is one people can open, else the request.
//
// ONE PERSON'S, ALWAYS. Every query here is keyed by the signed-in user's id
// and nothing else: the route takes no user parameter, so there is no way to
// ask for somebody else's work. A request is theirs the way the bot decides
// it everywhere else: recorded for them in homeroom_bot_requesters, or, for
// one the loop has not recorded yet, an issue they filed on Homeroom (the
// same rule as homeroom-bot.js workingNow). An app they can no longer view is
// left out, whatever the records say.
//
// NOW is drawn from the same records as the bot's own answer to "how far
// along are you?" (progressFor), so the two cannot disagree; only the shape
// differs: that one is words for a model to read, this one rows for a
// screen to draw. HISTORY is the tray's own.
//
// LIVE: the client reads it again when the bot's news lands in the DM (the
// conversation's own realtime event) and when the live loop starts or ends a
// piece of work for this person, which `noteWorkChanged` announces on their
// event sockets as `homeroom_bot_work_changed` (no payload: the client re-reads
// this endpoint under its own session, as Messages does for every event).

const log = require('./logger');
const appAccess = require('./app-access');
const progressSvc = require('./homeroom-bot-progress');

// The most history rows one read returns.
const HISTORY_LIMIT = 30;
// The most jobs "now" can show (the bot works on a few at once for anybody).
const NOW_LIMIT = 10;

// The step an in-flight progress stage is drawn as (bot-work.tsx words each).
// Every stage in progress.IN_FLIGHT_STAGES has one.
const PHASE_OF_STAGE = Object.freeze({
  setting_up: 'setting_up',
  queued: 'queued',
  reading: 'looking',
  starting: 'building',
  planning: 'building',
  building: 'building',
  proposing: 'building',
  followup_queued: 'follow_up_queued',
  fix_queued: 'follow_up_queued',
  revising: 'following_up',
  fixing: 'following_up',
  merging: 'merging',
});
const PHASES = Object.freeze([...new Set(Object.values(PHASE_OF_STAGE))]);
// The phases that are about the bot's proposal, which is where they open.
const PROPOSAL_PHASES = new Set(['follow_up_queued', 'following_up', 'merging']);

// What a run came to, as the tray names it (the client words each one).
const OUTCOMES = Object.freeze([
  'question', 'ready', 'proposed', 'live', 'closed', 'build_failed',
  'person', 'empty', 'failed', 'answer', 'revise',
]);

// A proposal people can open: the same states shared-objects.js lets anybody
// who can view the app open the bot's proposal in.
const OPENABLE_PROPOSAL = new Set(['promoted', 'merging', 'merged']);

function settingsModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }

function issueHref(slug, issueNumber) {
  return `#app/${encodeURIComponent(slug)}/dev/issues/${Number(issueNumber)}`;
}

function proposalHref(slug, sessionId) {
  return `#app/${encodeURIComponent(slug)}/dev/proposals/${Number(sessionId)}`;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Pure: one of progressFor's in-flight entries as a row of Now, or null for
 * an entry that is not in flight. It opens its proposal while the step is
 * about the proposal, its request otherwise, and a project being set up its
 * project.
 */
function jobOfProgress(item) {
  const phase = progressSvc.inFlight(item) ? PHASE_OF_STAGE[item.stage] : null;
  if (!phase || !item.project) return null;
  const firstVersion = !!item.firstVersion;
  const issueNumber = Number(item.number) || null;
  const proposalId = Number(item.proposal?.proposal) || null;
  let href = `#app/${encodeURIComponent(item.project)}/app`;
  if (proposalId && PROPOSAL_PHASES.has(phase)) href = proposalHref(item.project, proposalId);
  else if (issueNumber) href = issueHref(item.project, issueNumber);
  return {
    appSlug: item.project,
    appName: item.projectName || item.project,
    issueNumber,
    title: firstVersion ? null : (item.title || null),
    firstVersion,
    phase,
    since: iso(item.since),
    href,
  };
}

/**
 * Pure: what one live run came to. A ready verdict is told by its build: the
 * proposal it opened (and where that went), or a build that failed.
 */
function outcomeOf(row) {
  switch (row.verdict) {
    case 'ready':
      if (row.proposal_session_id) {
        if (row.proposal_status === 'merged') return 'live';
        if (row.proposal_status === 'closed') return 'closed';
        return 'proposed';
      }
      return row.build_ok === false ? 'build_failed' : 'ready';
    case 'question': case 'person': case 'empty': case 'failed': case 'answer': case 'revise':
      return row.verdict;
    default:
      return 'failed';
  }
}

/** Pure: where a row opens. Its proposal once people can open it, else its request. */
function hrefOf(row) {
  if (row.proposal_session_id && OPENABLE_PROPOSAL.has(row.proposal_status)) {
    return proposalHref(row.slug, row.proposal_session_id);
  }
  return row.issue_number ? issueHref(row.slug, row.issue_number) : `#app/${encodeURIComponent(row.slug)}/app`;
}

function jobOf(row) {
  const firstVersion = !!row.first_version;
  const issueNumber = Number(row.issue_number) || null;
  return {
    appSlug: row.slug,
    appName: row.name || row.slug,
    issueNumber,
    title: firstVersion ? null : (row.issue_title || null),
    firstVersion,
  };
}

/**
 * What the bot has in hand for this person now: progressFor's in-flight
 * entries (see the note at the top), what it is doing this minute first.
 * Nothing while it is switched off, or on a staging copy, which never acts.
 */
async function currentJobs(pool, { userId, settings, deps = {} }) {
  if (!settings || settings.mode === 'off' || liveModule(deps).isStaging()) return [];
  const progress = await progressSvc.progressFor(pool, {
    userId, settings, facts: false, deps: { botSvc: deps.botSvc, creationPhase: deps.creationPhase, domain: null },
  });
  const items = progress.rightNow.filter((item) => progressSvc.inFlight(item));
  const busy = items.filter((item) => item.busyNow);
  return [...busy, ...items.filter((item) => !item.busyNow)]
    .map(jobOfProgress)
    .filter(Boolean)
    .slice(0, NOW_LIMIT);
}

/** The bot's live runs on this person's requests, newest first. */
async function pastJobs(pool, { userId, limit = HISTORY_LIMIT }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.issue_number, r.verdict, r.build_ok, r.proposal_session_id, r.created_at,
            cs.status AS proposal_status, a.slug, a.name, q.issue_title, q.first_version
       FROM homeroom_bot_requesters q
       JOIN homeroom_bot_runs r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN chat_sessions cs ON cs.id = r.proposal_session_id
      WHERE q.user_id = $1 AND r.mode = 'live'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    ...jobOf(row),
    outcome: outcomeOf(row),
    ...(row.proposal_session_id && OPENABLE_PROPOSAL.has(row.proposal_status)
      ? { proposalId: Number(row.proposal_session_id) } : {}),
    at: iso(row.created_at),
    href: hrefOf(row),
  }));
}

/** Keep only the rows on apps this person can still view. */
async function viewable(pool, user, items) {
  const slugs = [...new Set(items.map((item) => item.appSlug).filter(Boolean))];
  if (!slugs.length) return items;
  // The columns checkAppAccess reads (app-access.js ACCESS_COLUMNS), written
  // out so the query stays static SQL.
  const { rows } = await pool.query(
    `SELECT id, slug, created_by, self_hosted, collab_visibility, view_visibility, moderation_suspended_at
       FROM apps WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const allowed = new Set();
  for (const app of rows) {
    if (await appAccess.checkAppAccess(pool, app, user, 'view')) allowed.add(app.slug);
  }
  return items.filter((item) => allowed.has(item.appSlug));
}

/**
 * Everything the tray shows for `user`, the signed-in person: { now, history }.
 * Never anybody else's: see the note at the top.
 */
async function workFor(pool, { user, settings = null, deps = {} }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return { now: [], history: [] };
  const s = settings || await settingsModule(deps).readSettings(pool);
  const [now, history] = await Promise.all([
    currentJobs(pool, { userId, settings: s, deps }),
    pastJobs(pool, { userId }),
  ]);
  const shown = await viewable(pool, user, [...now, ...history]);
  const keep = new Set(shown);
  return { now: now.filter((job) => keep.has(job)), history: history.filter((job) => keep.has(job)) };
}

/**
 * The live loop started or finished a piece of work for this person: their
 * open tray reads itself again. Best-effort and never throws: a missed nudge
 * is caught up by the next one, or the next time the DM opens.
 */
function noteWorkChanged(userId, deps = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  try {
    const ws = deps.ws || require('./ws');
    return ws.pushToUser(id, { type: 'homeroom_bot_work_changed' }) || 0;
  } catch (err) {
    log.warn('homeroom-bot-tray', 'Could not announce a work change', { userId: id, err: err.message });
    return 0;
  }
}

/**
 * The staging demo's tray (`?demo=1`, beside the bot DM fixture in
 * staging-messages.js): one request being built, a change asked for on one
 * of its proposals waiting its turn (#3734), and a few things done before.
 * A staging copy never runs the bot, so without it the tray could not be
 * seen there. Times are relative to `now` so it always reads fresh. No
 * project stands behind it (as behind the fixture's own messages), so its
 * rows open nothing: `href` is null and the tray draws plain rows.
 */
function demoWork(now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const app = { appSlug: null, appName: 'Staging demo app' };
  return {
    now: [{
      ...app, issueNumber: 14, title: 'Staging demo, show a total under the list', firstVersion: false,
      phase: 'building', since: ago(4), href: null,
    }, {
      ...app, issueNumber: 9, title: 'Staging demo, show item counts', firstVersion: false,
      phase: 'follow_up_queued', since: ago(1), href: null,
    }],
    history: [
      { id: 3, ...app, issueNumber: 12, title: 'Staging demo, sort the list by date', firstVersion: false,
        outcome: 'question', at: ago(35), href: null },
      { id: 2, ...app, issueNumber: 9, title: 'Staging demo, show item counts', firstVersion: false,
        outcome: 'proposed', at: ago(60 * 26), href: null },
      { id: 1, ...app, issueNumber: 1, title: null, firstVersion: true,
        outcome: 'live', at: ago(60 * 24 * 3), href: null },
    ],
  };
}

module.exports = {
  workFor, currentJobs, pastJobs, noteWorkChanged, demoWork,
  jobOfProgress, outcomeOf, hrefOf, OUTCOMES, PHASES, PHASE_OF_STAGE, HISTORY_LIMIT,
};
