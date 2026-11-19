'use strict';

// #6869: the same report on another project.
//
// When a read says a report is about Homeroom itself, and another project
// reported the same thing within the last week, the note says so ("Family
// Tree reported the same yesterday") instead of every project getting its
// own dead end. This finds those reports: other PUBLIC projects' open
// requests from the last seven days whose titles share most of their words
// with this one (request-similarity.js's rule), or whose own latest live
// read put them on Homeroom itself.
//
// Cheap on purpose: plain words rather than a model, and a bounded read.
// Never throws.

const log = require('./logger');
const { titleWords } = require('./request-similarity');

const WINDOW_DAYS = 7;
const MAX_REPORTS = 5;
const MIN_SHARED = 2;
const MIN_OVERLAP = 0.6;

/** Whole days between `createdAt` and now, or null. */
function ageDaysOf(createdAt, now = Date.now()) {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)));
}

/**
 * Other public projects' open requests from the last seven days that look
 * like this one: { project, number, ageDays, title, aboutPlatform, reason }
 * (at most five). `reason` is the other read's own words, clipped.
 */
async function sameReports(pool, { app, issueNumber = null, title = null } = {}) {
  try {
    if (!app?.id) return [];
    const { rows } = await pool.query(
      `SELECT i.github_issue_number AS number, i.title, i.created_at, COALESCE(a.name, a.slug) AS project,
              r.about_platform, r.reason AS bot_reason
         FROM issues i
         JOIN apps a ON a.id = i.app_id
         LEFT JOIN LATERAL (
           SELECT rr.about_platform, rr.reason
             FROM homeroom_bot_runs rr
            WHERE rr.app_id = i.app_id AND rr.issue_number = i.github_issue_number AND rr.mode = 'live'
            ORDER BY rr.id DESC LIMIT 1
         ) r ON TRUE
        WHERE i.app_id <> $1
          AND i.status = 'open'
          AND i.github_issue_number IS NOT NULL
          AND (i.kind IS NULL OR i.kind = 'general')
          AND a.view_visibility = 'public'
          AND i.created_at > NOW() - INTERVAL '${WINDOW_DAYS} days'
        ORDER BY i.created_at DESC
        LIMIT 300`,
      [Number(app.id)],
    );
    const mine = titleWords(title || '');
    const now = Date.now();
    const scored = [];
    for (const row of rows) {
      const aboutPlatform = row.about_platform === true;
      let shared = 0;
      let overlap = 0;
      if (mine.size >= MIN_SHARED) {
        const theirs = titleWords(row.title);
        if (theirs.size >= MIN_SHARED) {
          for (const word of mine) if (theirs.has(word)) shared += 1;
          overlap = shared / Math.min(mine.size, theirs.size);
        }
      }
      const titleMatch = shared >= MIN_SHARED && overlap >= MIN_OVERLAP;
      if (!titleMatch && !aboutPlatform) continue;
      const number = Number(row.number);
      if (!Number.isInteger(number) || number <= 0) continue;
      scored.push({
        project: String(row.project || '').trim(),
        number,
        ageDays: ageDaysOf(row.created_at, now),
        title: String(row.title || '').trim(),
        aboutPlatform,
        reason: row.bot_reason ? String(row.bot_reason).replace(/\s+/g, ' ').trim().slice(0, 200) : null,
        score: (aboutPlatform ? 2 : 0) + overlap,
      });
    }
    scored.sort((a, b) => b.score - a.score
      || (a.ageDays ?? 99) - (b.ageDays ?? 99) || a.number - b.number);
    return scored.slice(0, MAX_REPORTS).map(({ score, ...report }) => report);
  } catch (err) {
    log.warn('homeroom-bot-same-report', 'Could not read the same report on other projects', {
      app: app?.slug, err: err.message,
    });
    return [];
  }
}

/** Pure: the lines the triage prompt gets, or null when there are none. */
function sameReportNote(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.project && Number.isInteger(Number(r.number)) && Number(r.number) > 0)
    .slice(0, MAX_REPORTS);
  if (!list.length) return null;
  const when = (days) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);
  return [
    'Other projects reported the same thing in the last seven days (public projects only). When one of them points the same way, name it once in `reason`, for example "Family Tree reported the same yesterday":',
    ...list.map((r) => `- ${r.project} reported request #${Number(r.number)} ${when(r.ageDays)}: ${r.title}`
      + (r.aboutPlatform ? ' (my read put that one on Homeroom itself)' : '')
      + (r.reason ? `. What I said: ${r.reason}` : '')),
  ].join('\n');
}

module.exports = {
  sameReports,
  sameReportNote,
  ageDaysOf,
  MAX_REPORTS,
};
