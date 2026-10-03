'use strict';

// #3692: the activity tray in a person's DM with the Homeroom bot.
//
// The DM already carries the bot's news one message at a time (homeroom-
// bot-dm.js): a question, "I'm building this now", the proposal, live. What
// it could not show is the state in between: what the bot is doing for this
// person right now, and what it has done for them before. The tray in the
// DM (frontend/src/features/messages/bot-work.tsx: a status line in the
// chat header that opens a panel of tiles) is that, read from the
// platform's own records of the bot's work and nothing else. ONE ENTRY PER
// REQUEST, in the first group that fits:
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
//     while the bot said it was. Each carries its step of the request's
//     steps, as the activity cards in the transcript do.
//   - NEEDS YOU: what waits on this person. What the bot's progress says is
//     waiting on them (a question of the bot's still open in the DM, a new
//     project waiting for its secrets), and any other request whose newest
//     run ended in a way the activity cards call "Needs you": a question
//     asked, a request it cannot build as written, nothing to build in it.
//   - HISTORY: everything else the bot ran on their requests
//     (homeroom_bot_runs), the request's newest news first, each with what
//     came of it and where to open it: the proposal once there is one people
//     can open, else the request.
//
// Every entry carries the request's other runs as `earlier`, so a request
// the bot came back to five times is one entry with four earlier runs, not
// five rows that look alike.
//
// ONE VOCABULARY. What a run came to is said in the activity cards' words
// (homeroom-bot-activity.js OUTCOMES): a build held back by a cap is
// `held`, not the verdict it would have sent; a build that could not go
// ahead as the request is written is `blocked`, not a failed build.
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
// differs: that one is words for a model to read, this one tiles for a
// screen to draw.
//
// LIVE: the client reads it again when the bot's news lands in the DM (the
// conversation's own realtime event) and when the live loop starts or ends a
// piece of work for this person, which `noteWorkChanged` announces on their
// event sockets as `homeroom_bot_work_changed` (no payload: the client re-reads
// this endpoint under its own session, as Messages does for every event).

const log = require('./logger');
const appAccess = require('./app-access');
const progressSvc = require('./homeroom-bot-progress');
const activitySvc = require('./homeroom-bot-activity');

// The most requests History lists.
const HISTORY_LIMIT = 30;
// The most jobs "now" can show (the bot works on a few at once for anybody).
const NOW_LIMIT = 10;
// The most of the bot's runs one read looks through, newest first, and the
// most earlier runs one entry carries.
const RUN_LIMIT = 150;
const EARLIER_LIMIT = 5;

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

// What a run came to: the activity cards' words, every one of them.
const OUTCOMES = activitySvc.OUTCOMES;
// The endings that wait on the person: the cards' "Needs you".
const NEEDS_YOU = new Set(['question', 'blocked', 'empty']);

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

function projectHref(slug) {
  return `#app/${encodeURIComponent(slug)}/app`;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Pure: the one key a request goes by here, whichever record it came from. */
function keyOf(slug, issueNumber) {
  return `${slug}#${Number(issueNumber) || 'first'}`;
}

/** Pure: where an entry's links go: its request, its proposal, or (with no request) its project. */
function linksFor(slug, issueNumber, proposalId) {
  const request = Number(issueNumber) ? issueHref(slug, issueNumber) : null;
  return {
    request,
    proposal: proposalId ? proposalHref(slug, proposalId) : null,
    project: request ? null : projectHref(slug),
  };
}

/** Pure: who an entry is about, from one of progressFor's entries. */
function jobOfEntry(item) {
  const firstVersion = !!item.firstVersion;
  const issueNumber = Number(item.number) || null;
  return {
    key: keyOf(item.project, issueNumber),
    appSlug: item.project,
    appName: item.projectName || item.project,
    issueNumber,
    title: firstVersion ? null : (item.title || null),
    firstVersion,
  };
}

/**
 * Pure: one of progressFor's in-flight entries as an entry of Now, or null
 * for an entry that is not in flight. It opens its proposal while the step
 * is about the proposal, its request otherwise, and a project being set up
 * its project; its step of the request's steps is the one the activity
 * cards draw.
 */
function jobOfProgress(item) {
  const phase = progressSvc.inFlight(item) ? PHASE_OF_STAGE[item.stage] : null;
  if (!phase || !item.project) return null;
  const job = jobOfEntry(item);
  const proposalId = PROPOSAL_PHASES.has(phase) ? Number(item.proposal?.proposal) || null : null;
  const links = linksFor(item.project, job.issueNumber, proposalId);
  const stepped = Number.isInteger(item.step) && Number.isInteger(item.of) && item.step > 0 && item.step <= item.of;
  return {
    ...job,
    phase,
    stage: item.stage,
    step: stepped ? item.step : null,
    of: stepped ? item.of : null,
    stepName: stepped ? item.stepName || null : null,
    doing: item.doing || null,
    since: iso(item.since),
    href: links.proposal || links.request || links.project,
    links,
    earlier: [],
  };
}

/**
 * Pure: what one live run came to, in the activity cards' words, or null
 * for a build nothing has finished yet. A ready verdict is told by its
 * build: the proposal it opened (and where that went), or a build that did
 * not go ahead. A verdict a cap held back was never sent.
 */
function outcomeOf(row) {
  if (row.cap_suppressed) return 'held';
  switch (row.verdict) {
    case 'ready':
      if (row.proposal_session_id) {
        if (row.proposal_status === 'merged') return 'live';
        if (row.proposal_status === 'closed') return 'closed';
        return 'proposed';
      }
      if (row.build_ok === true) return 'proposed';
      if (row.build_ok === false) return /^blocked:/.test(String(row.build_error || '')) ? 'blocked' : 'build_failed';
      return null;
    case 'question': case 'person': case 'empty': case 'failed': case 'answer': case 'revise':
      return row.verdict;
    default:
      return 'failed';
  }
}

/** Pure: when what a run came to happened: a proposal's own moments, else the run. */
function atOf(row, outcome) {
  if (outcome === 'live') return iso(row.merged_at) || iso(row.proposal_at) || iso(row.created_at);
  if (outcome === 'proposed' || outcome === 'closed') return iso(row.proposal_at) || iso(row.created_at);
  return iso(row.created_at);
}

/** Pure: where a run opens. Its proposal once people can open it, else its request. */
function hrefOf(row) {
  if (row.proposal_session_id && OPENABLE_PROPOSAL.has(row.proposal_status)) {
    return proposalHref(row.slug, row.proposal_session_id);
  }
  return row.issue_number ? issueHref(row.slug, row.issue_number) : projectHref(row.slug);
}

/** Pure: a run as one of an entry's earlier runs. A build still going reads as one that stopped. */
function runOf(row) {
  const outcome = outcomeOf(row) || 'stopped';
  return { id: Number(row.id), outcome, at: atOf(row, outcome) };
}

/**
 * Pure: the runs of `rows` (newest first) by request, each request's runs
 * newest first, in the order its newest run came.
 */
function groupRuns(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row.slug, row.issue_number);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/**
 * Pure: one request's runs (newest first) as an entry of Needs you or
 * History: what came of it last, when, where it opens, and its other runs.
 * A follow-up's answer on a proposal that has since been merged or closed
 * is not the news: the proposal's end is.
 */
function entryOfRuns(runs) {
  const newest = runs[0];
  const withProposal = runs.find((row) => row.proposal_session_id);
  let lead = newest;
  if (withProposal && withProposal !== newest && ['answer', 'revise'].includes(newest.verdict)
    && ['merged', 'closed'].includes(withProposal.proposal_status)) {
    lead = withProposal;
  }
  const outcome = outcomeOf(lead) || 'stopped';
  const proposalRow = withProposal && OPENABLE_PROPOSAL.has(withProposal.proposal_status) ? withProposal : null;
  const firstVersion = !!newest.first_version;
  const issueNumber = Number(newest.issue_number) || null;
  const links = linksFor(newest.slug, issueNumber, proposalRow ? proposalRow.proposal_session_id : null);
  return {
    key: keyOf(newest.slug, issueNumber),
    id: Number(lead.id),
    appSlug: newest.slug,
    appName: newest.name || newest.slug,
    issueNumber,
    title: firstVersion ? null : (newest.issue_title || null),
    firstVersion,
    outcome,
    doing: null,
    at: atOf(lead, outcome),
    ...(proposalRow ? { proposalId: Number(proposalRow.proposal_session_id) } : {}),
    href: links.proposal || links.request || links.project,
    links,
    earlier: runs.filter((row) => row !== lead).slice(0, EARLIER_LIMIT).map(runOf),
  };
}

/**
 * Pure: a request's runs as the earlier runs of an entry of Now: the ones
 * that came to something. A build that has not finished is the work Now is
 * showing, not an earlier run.
 */
function earlierOf(runs = []) {
  return runs.filter((row) => outcomeOf(row)).slice(0, EARLIER_LIMIT).map(runOf);
}

/**
 * Pure: one of progressFor's entries that waits on the person as an entry
 * of Needs you: an open question of the bot's in the DM (its runs say the
 * rest), or a new project waiting for its secrets (its own words).
 */
function needsYouOfProgress(item, runs = []) {
  const job = jobOfEntry(item);
  const links = linksFor(item.project, job.issueNumber, Number(item.proposal?.proposal) || null);
  const question = item.stage === 'question';
  const asked = question ? runs.find((row) => row.verdict === 'question') : null;
  return {
    ...job,
    id: asked ? Number(asked.id) : 0,
    outcome: question ? 'question' : null,
    doing: question ? null : (item.doing || null),
    at: iso(item.since) || (asked ? iso(asked.created_at) : null),
    href: links.proposal || links.request || links.project,
    links,
    earlier: runs.filter((row) => row !== asked).slice(0, EARLIER_LIMIT).map(runOf),
  };
}

const newestFirst = (a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0);

/**
 * Pure: the tray's three groups, from progressFor's entries (empty while
 * the bot is off) and the person's live runs, newest first. Each request
 * appears once: in Now while the bot has it in hand, else in Needs you
 * while it waits on them, else in History.
 */
function arrange(entries, rows) {
  const groups = groupRuns(rows);
  const items = entries.filter((item) => progressSvc.inFlight(item));
  const busy = items.filter((item) => item.busyNow);
  const now = [...busy, ...items.filter((item) => !item.busyNow)]
    .map(jobOfProgress)
    .filter(Boolean)
    .slice(0, NOW_LIMIT);
  const placed = new Set();
  for (const job of now) {
    job.earlier = earlierOf(groups.get(job.key));
    placed.add(job.key);
  }
  const needsYou = [];
  for (const item of entries) {
    if (item.waitingOn !== 'them' || !item.project) continue;
    const key = keyOf(item.project, item.number);
    if (placed.has(key)) continue;
    needsYou.push(needsYouOfProgress(item, groups.get(key)));
    placed.add(key);
  }
  const history = [];
  for (const [key, runs] of groups) {
    if (placed.has(key)) continue;
    const entry = entryOfRuns(runs);
    (NEEDS_YOU.has(entry.outcome) ? needsYou : history).push(entry);
  }
  return { now, needsYou: needsYou.sort(newestFirst), history: history.sort(newestFirst).slice(0, HISTORY_LIMIT) };
}

/**
 * Everything the bot's own progress answer says about this person's
 * requests (progressFor's rightNow): what it has in hand, and what waits on
 * them. Nothing while it is switched off, or on a staging copy, which never
 * acts.
 */
async function progressEntries(pool, { userId, settings, deps = {} }) {
  if (!settings || settings.mode === 'off' || liveModule(deps).isStaging()) return [];
  const progress = await progressSvc.progressFor(pool, {
    userId, settings, facts: false, deps: { botSvc: deps.botSvc, creationPhase: deps.creationPhase, domain: null },
  });
  return progress.rightNow || [];
}

/** What the bot has in hand for this person now: Now alone (see arrange). */
async function currentJobs(pool, { userId, settings, deps = {} }) {
  return arrange(await progressEntries(pool, { userId, settings, deps }), []).now;
}

/** The bot's live runs on this person's requests, newest first. */
async function pastRuns(pool, { userId, limit = RUN_LIMIT }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.issue_number, r.verdict, r.build_ok, r.build_error, r.cap_suppressed,
            r.proposal_session_id, r.created_at,
            cs.status AS proposal_status, COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.merged_at,
            a.slug, a.name, q.issue_title, q.first_version
       FROM homeroom_bot_requesters q
       JOIN homeroom_bot_runs r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN chat_sessions cs ON cs.id = r.proposal_session_id
      WHERE q.user_id = $1 AND r.mode = 'live'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** The slugs among `items`' this person can still view. */
async function viewableSlugs(pool, user, items) {
  const slugs = [...new Set(items.map((item) => item.appSlug).filter(Boolean))];
  if (!slugs.length) return new Set();
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
  return allowed;
}

/**
 * Everything the tray shows for `user`, the signed-in person:
 * { now, needsYou, history }. Never anybody else's: see the note at the top.
 */
async function workFor(pool, { user, settings = null, deps = {} }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return { now: [], needsYou: [], history: [] };
  const s = settings || await settingsModule(deps).readSettings(pool);
  const [entries, rows] = await Promise.all([
    progressEntries(pool, { userId, settings: s, deps }),
    pastRuns(pool, { userId }),
  ]);
  // An app they cannot view is left out before anything is arranged, so its
  // runs are not anybody's earlier runs either.
  const allowed = await viewableSlugs(pool, user, [
    ...entries.map((item) => ({ appSlug: item.project })),
    ...rows.map((row) => ({ appSlug: row.slug })),
  ]);
  return arrange(
    entries.filter((item) => allowed.has(item.project)),
    rows.filter((row) => allowed.has(row.slug)),
  );
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
 * staging-messages.js): one request being built (the step its activity card
 * in the fixture shows), a change asked for on one of its proposals waiting
 * its turn (#3734), a question waiting on the viewer, and a few things done
 * before, one of them a request the bot came back to. A staging copy never
 * runs the bot, so without it the tray could not be seen there. Times are
 * relative to `now` so it always reads fresh. No project stands behind it
 * (as behind the fixture's own messages), so it links nowhere: `href` and
 * every link are null and the tray draws tiles without links.
 */
function demoWork(now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const app = { appSlug: null, appName: 'Staging demo app' };
  const nowhere = { href: null, links: { request: null, proposal: null, project: null } };
  const request = (issueNumber, title) => ({ key: `demo#${issueNumber}`, ...app, issueNumber, title, firstVersion: false });
  return {
    now: [{
      ...request(14, 'Staging demo, show a total under the list'),
      phase: 'building', stage: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
      since: ago(4), ...nowhere, earlier: [],
    }, {
      ...request(9, 'Staging demo, show item counts'),
      phase: 'follow_up_queued', stage: 'followup_queued', step: 5, of: 6, stepName: 'Group vote',
      doing: 'waiting in the queue (number 1) to follow up on the newest replies on its proposal',
      since: ago(1), ...nowhere, earlier: [{ id: 2, outcome: 'proposed', at: ago(60 * 26) }],
    }],
    needsYou: [{
      ...request(12, 'Staging demo, sort the list by date'),
      id: 4, outcome: 'question', doing: null, at: ago(35), ...nowhere, earlier: [],
    }],
    history: [{
      ...request(6, 'Staging demo, add a dark theme'),
      id: 3, outcome: 'answer', doing: null, at: ago(60 * 20), ...nowhere,
      earlier: [{ id: 5, outcome: 'revise', at: ago(60 * 21) }, { id: 6, outcome: 'proposed', at: ago(60 * 30) }],
    }, {
      key: 'demo#first', ...app, issueNumber: 1, title: null, firstVersion: true,
      id: 1, outcome: 'live', doing: null, at: ago(60 * 24 * 3), ...nowhere, earlier: [],
    }],
  };
}

module.exports = {
  workFor, currentJobs, pastRuns, arrange, noteWorkChanged, demoWork,
  jobOfProgress, needsYouOfProgress, entryOfRuns, outcomeOf, hrefOf, keyOf,
  OUTCOMES, NEEDS_YOU, PHASES, PHASE_OF_STAGE, HISTORY_LIMIT, NOW_LIMIT,
};
