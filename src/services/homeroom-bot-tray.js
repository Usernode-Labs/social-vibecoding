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
//   - NOW: the queue rows the live loop has claimed (homeroom_bot_queue
//     started_at) on a request that is this person's, on an app the bot acts
//     on for real, with the step it is at: looking at it, building it (its
//     spec was posted during this turn of work), or following up on its
//     proposal. A project they described that is still being set up (its
//     first version not filed yet) is in flight too.
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
// It is deliberately separate from the bot's own answer to "how far along
// are you?" (homeroom-bot-mayor.js my_work): that one is words for a model to
// read; this one is rows for a screen to draw.
//
// LIVE: the client reads it again when the bot's news lands in the DM (the
// conversation's own realtime event) and when the live loop starts or ends a
// piece of work for this person, which `noteWorkChanged` announces on their
// event sockets as `homeroom_bot_work_changed` (no payload: the client re-reads
// this endpoint under its own session, as Messages does for every event).

const log = require('./logger');
const appAccess = require('./app-access');

// The most history rows one read returns.
const HISTORY_LIMIT = 30;
// The most jobs "now" can show (the bot works on a few at once for anybody).
const NOW_LIMIT = 10;

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
 * Pure: the step a claimed request is at. Building once its spec was posted
 * during this turn of work; following up while its proposal is up for a
 * vote (the loop answers what people said there); else looking at it.
 */
function phaseOf(row) {
  const started = row.started_at ? new Date(row.started_at).getTime() : NaN;
  const spec = row.spec_at ? new Date(row.spec_at).getTime() : NaN;
  if (Number.isFinite(started) && Number.isFinite(spec) && spec >= started) return 'building';
  if (row.proposal_status === 'promoted' || row.proposal_status === 'merging') return 'following_up';
  return 'looking';
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

/** The claimed queue rows that are this person's, on apps the bot acts on for real. */
async function currentJobs(pool, { userId, settings, deps = {} }) {
  const { rows } = await pool.query(
    `SELECT q.app_id, q.issue_number, q.started_at, a.slug, a.name,
            COALESCE(r.issue_title, i.title) AS issue_title, COALESCE(r.first_version, FALSE) AS first_version,
            spec.created_at AS spec_at, prop.id AS proposal_session_id, prop.status AS proposal_status
       FROM homeroom_bot_queue q
       JOIN apps a ON a.id = q.app_id
       LEFT JOIN homeroom_bot_requesters r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
       LEFT JOIN LATERAL (
         SELECT created_by, title FROM issues
          WHERE app_id = q.app_id AND github_issue_number = q.issue_number
          ORDER BY id LIMIT 1
       ) i ON TRUE
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_posts
          WHERE app_id = q.app_id AND issue_number = q.issue_number AND kind = 'spec'
          ORDER BY created_at DESC LIMIT 1
       ) spec ON TRUE
       LEFT JOIN LATERAL (
         SELECT cs.id, cs.status FROM homeroom_bot_runs br
           JOIN chat_sessions cs ON cs.id = br.proposal_session_id
          WHERE br.app_id = q.app_id AND br.issue_number = q.issue_number
          ORDER BY br.id DESC LIMIT 1
       ) prop ON TRUE
      WHERE q.started_at IS NOT NULL
        AND COALESCE(r.user_id, i.created_by) = $1
      ORDER BY q.started_at, q.id
      LIMIT $2`,
    [userId, NOW_LIMIT],
  );
  const live = liveModule(deps);
  const jobs = rows
    // Shadow triage of an app the bot does not act on says nothing to anybody:
    // it is not work for them.
    .filter((row) => live.isLiveFor(settings, { slug: row.slug }))
    .map((row) => ({
      ...jobOf(row),
      phase: phaseOf(row),
      since: iso(phaseOf(row) === 'building' ? row.spec_at : row.started_at),
      href: hrefOf(row),
    }));
  // A project they described, still being set up: its first version is
  // filed (and the loop above takes it) once the project is running.
  const { rows: firsts } = await pool.query(
    `SELECT a.slug, a.name, f.created_at FROM homeroom_bot_first_versions f
       JOIN apps a ON a.id = f.app_id
      WHERE f.user_id = $1 AND f.bot_builds AND f.status IN ('waiting', 'filing')
      ORDER BY f.created_at, f.app_id
      LIMIT $2`,
    [userId, NOW_LIMIT],
  );
  if (settings?.mode !== 'off') {
    for (const row of firsts) {
      jobs.push({
        appSlug: row.slug, appName: row.name || row.slug, issueNumber: null, title: null, firstVersion: true,
        phase: 'setting_up', since: iso(row.created_at), href: `#app/${encodeURIComponent(row.slug)}/app`,
      });
    }
  }
  return jobs;
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
 * staging-messages.js): one request being built and a few things done
 * before. A staging copy never runs the bot, so without it the tray could
 * not be seen there. Times are relative to `now` so it always reads fresh.
 * No project stands behind it (as behind the fixture's own messages), so
 * its rows open nothing: `href` is null and the tray draws plain rows.
 */
function demoWork(now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const app = { appSlug: null, appName: 'Staging demo app' };
  return {
    now: [{
      ...app, issueNumber: 14, title: 'Staging demo, show a total under the list', firstVersion: false,
      phase: 'building', since: ago(4), href: null,
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
  phaseOf, outcomeOf, hrefOf, OUTCOMES, HISTORY_LIMIT,
};
