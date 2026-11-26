'use strict';

// #7215: the project a Homeroom report is about.
//
// Pressing Suggest while another project's page is open files a report on
// Homeroom's own board, which says only (by app id) which project it was
// about: the board is public and the project may be private. This reads that
// back for triage, so the bot speaks and plans from that project's facts (its
// repository host, the requests that closed around the time of the report)
// instead of Homeroom's own.
//
// It reads only what the reporter could see then and can see now. Never
// throws: an unreadable project, or one deleted since, simply adds nothing.

const log = require('./logger');
const appAccess = require('./app-access');
const repoRef = require('./repo-ref');
const { aboutAppFor } = require('./feedback-reports');
const { resolveIssueProposalRefs } = require('./issue-proposal-ref');

const WINDOW_BEFORE_MS = 10 * 60 * 1000;
const WINDOW_AFTER_MS = 1 * 60 * 1000;
const MAX_CLOSED = 5;

/** Pure: how a project is named on a public board. */
function aboutProjectLabel(aboutId, isPrivate) {
  return `${isPrivate ? 'a private project' : 'a project'} (app id ${aboutId})`;
}

/** The platform's own slug, without a top-level circular require. */
function platformSlugOf(deps) {
  if (typeof deps?.platformSlug === 'string' && deps.platformSlug) return deps.platformSlug;
  try { return require('./homeroom-bot').PLATFORM_SELF_APP_SLUG; } catch { return 'usernode-2d5619'; }
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The requests `github.fetchClosedIssues` shows closing around `reportedAt`
 * (10 minutes before it to 1 minute after, at most five), with the state of
 * whatever change addressed each one and when that change merged.
 * `readFully` is false when the board could not be read or was truncated, so
 * the prompt never claims the reported problem has gone from a partial list.
 */
async function closedNearReport(pool, { github, about, parsed, reportedAt }) {
  const at = new Date(reportedAt).getTime();
  if (!Number.isFinite(at)) return { closedNear: [], readFully: false };
  let read;
  try {
    read = await github.fetchClosedIssues(parsed.owner, parsed.repo);
  } catch (err) {
    log.warn('homeroom-bot-about-project', 'Could not read the about project\'s closed requests', {
      appId: about.id, err: err.message,
    });
    return { closedNear: [], readFully: false };
  }
  const readFully = !read?.note && !read?.truncatedList;
  const near = [];
  for (const issue of Array.isArray(read?.issues) ? read.issues : []) {
    const closedMs = new Date(issue.closedAt || '').getTime();
    if (!Number.isFinite(closedMs)) continue;
    if (closedMs < at - WINDOW_BEFORE_MS || closedMs > at + WINDOW_AFTER_MS) continue;
    const number = Number(issue.number);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    near.push({ issue, number, closedMs });
  }
  near.sort((a, b) => Math.abs(a.closedMs - at) - Math.abs(b.closedMs - at) || a.number - b.number);
  const kept = near.slice(0, MAX_CLOSED);
  const numbers = kept.map((n) => n.number);
  if (!numbers.length) return { closedNear: [], readFully };

  let refs = new Map();
  try {
    refs = await resolveIssueProposalRefs(pool, about.id, numbers);
  } catch (err) {
    log.warn('homeroom-bot-about-project', 'Could not read the about project\'s changes', {
      appId: about.id, err: err.message,
    });
  }
  // When each merged change merged. A merged ref is the record of what
  // closed the request; its merge time is what makes "closed by itself a few
  // seconds after the merge" sayable.
  const mergedIds = [];
  for (const ref of refs.values()) {
    if (ref?.state === 'merged' && Number.isSafeInteger(Number(ref.sessionId))) mergedIds.push(Number(ref.sessionId));
  }
  const mergedAt = new Map();
  if (mergedIds.length) {
    try {
      const { rows } = await pool.query(
        `SELECT id, merged_at FROM chat_sessions WHERE id = ANY($1::int[])`,
        [mergedIds],
      );
      for (const row of rows) mergedAt.set(Number(row.id), iso(row.merged_at));
    } catch (err) {
      log.warn('homeroom-bot-about-project', 'Could not read when a change merged', {
        appId: about.id, err: err.message,
      });
    }
  }

  const closedNear = kept.map(({ issue, number, closedMs }) => {
    const ref = refs.get(number) || null;
    return {
      number,
      title: String(issue.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      closedAt: iso(issue.closedAt),
      how: ref?.state || 'closed',
      mergedAt: ref ? (mergedAt.get(Number(ref.sessionId)) || null) : null,
      secondsBeforeReport: Math.round((at - closedMs) / 1000),
    };
  });
  return { closedNear, readFully };
}

/**
 * The project a Homeroom report is about, for the triage prompt:
 * `{ appId, private, host, reportedAt, closedNear, readFully }`, or null.
 * Only this platform's own board has one; a project's own board already
 * knows which project it is about.
 */
async function readAboutProject(pool, { app, issueNumber, deps = {} } = {}) {
  try {
    if (!app || app.slug !== platformSlugOf(deps)) return null;
    const github = deps.github || require('./github');
    const report = await aboutAppFor(pool, { issueNumber });
    if (!report || !Number.isSafeInteger(report.aboutAppId) || report.aboutAppId <= 0) return null;

    const { rows } = await pool.query(
      `SELECT ${appAccess.ACCESS_COLUMNS}, repo_url FROM apps WHERE id = $1`,
      [report.aboutAppId],
    );
    const about = rows[0];
    if (!about) return null;
    // The reporter must still be able to see it. Read the account's own row
    // so an admin reporter is checked as an admin, as at filing time; a
    // private project they have since left is not described, and never named.
    const { rows: people } = await pool.query(
      'SELECT id, is_admin FROM users WHERE id = $1',
      [report.userId],
    );
    const person = people[0];
    if (!person) return null;
    const reporter = { id: person.id, isAdmin: person.is_admin === true };
    if (!(await appAccess.checkAppAccess(pool, about, reporter, 'view'))) return null;

    const parsed = repoRef.parse(about.repo_url);
    const host = parsed && parsed.host === 'github' ? 'github' : 'homeroom';
    const { closedNear, readFully } = parsed
      ? await closedNearReport(pool, { github, about, parsed, reportedAt: report.createdAt })
      : { closedNear: [], readFully: false };
    return {
      appId: about.id,
      private: about.view_visibility !== 'public',
      host,
      reportedAt: report.createdAt,
      closedNear,
      readFully,
    };
  } catch (err) {
    log.warn('homeroom-bot-about-project', 'Could not read the project a report is about', {
      app: app?.slug, issueNumber, err: err.message,
    });
    return null;
  }
}

/**
 * Pure: the note beside the app's own state. It names the project only as
 * "a private project (app id N)" or "a project (app id N)", gives its
 * repository host and the requests that closed around the report, and says
 * that a problem that has already gone is answered rather than built.
 */
function aboutProjectNote(about) {
  if (!about) return null;
  const label = aboutProjectLabel(about.appId, about.private);
  const lines = [
    `PROJECT THIS REPORT IS ABOUT: ${label}. Do not name it in your reply.`,
    `Its repository is on ${about.host === 'github' ? 'GitHub' : "Homeroom's own git host"}. Explain and plan from that project's facts, not from Homeroom's own.`,
  ];
  if (!about.readFully) {
    lines.push('Its closed requests could not be read in full, so do not say that what the report describes has gone.');
  } else if (!about.closedNear?.length) {
    lines.push('No request on it closed around the time of the report.');
  } else {
    lines.push('Requests on it that closed around the time of the report:');
    for (const closed of about.closedNear) {
      const when = closed.secondsBeforeReport >= 0
        ? `closed ${closed.secondsBeforeReport} seconds before the report`
        : `closed ${-closed.secondsBeforeReport} seconds after the report`;
      const merged = closed.mergedAt ? `, its change merged at ${closed.mergedAt}` : '';
      lines.push(`- request #${closed.number} "${closed.title}" ${when}${merged} (${closed.how})`);
    }
  }
  lines.push('Before planning a fix for "X still shows", check whether X is still true now. If it is no longer true, answer `person` with `go_ahead` false and `cannot_because` "explanation", say in `reason` what happened and when, and build nothing.');
  return lines.join('\n');
}

module.exports = {
  readAboutProject,
  aboutProjectNote,
  aboutProjectLabel,
  WINDOW_BEFORE_MS,
  WINDOW_AFTER_MS,
  MAX_CLOSED,
};
