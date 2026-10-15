'use strict';

// A person's own week of Homeroom bot building time, as Settings shows it
// (GET /api/me/building-time, frontend/src/features/settings/building-time.tsx):
// how much of the week they have used, when it starts again, and which
// requests used it, so somebody who runs out can see why.
//
// Read by the allowance's own rule (homeroom-bot-dm.js weeklySpentCents and
// weeklyCapCents): the charged runs since Monday 00:00 UTC whose payer, or
// the request's requester when nobody else asked the bot to start it, is
// this person. A shadow run and a run the bot caused itself are charged to
// nobody.
//
// Shares only, never money: building time is the limit people are told
// about (homeroom-bot-dm.js says so in its own words), so the answer carries
// fractions of the week and no amount or cap a person could read one from.

const MAX_REQUESTS = 50;

// This person's charged runs this week, one row per request: its project,
// its title as the bot recorded it, how many runs, what they cost, and
// whether they asked the bot to build somebody else's request.
const REQUESTS_SQL = `
  SELECT a.slug, a.name, r.issue_number,
         MAX(q.issue_title) AS title,
         BOOL_OR(r.payer_user_id = $1 AND q.user_id IS DISTINCT FROM $1) AS asked,
         COUNT(*)::int AS runs,
         SUM(COALESCE(r.cost_usd, 0) + COALESCE(r.build_cost_usd, 0))::float8 AS usd,
         MAX(r.created_at) AS last_at
    FROM homeroom_bot_runs r
    JOIN apps a ON a.id = r.app_id
    LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
   WHERE r.charged AND COALESCE(r.payer_user_id, q.user_id) = $1 AND r.created_at >= $2
   GROUP BY a.slug, a.name, r.issue_number
   ORDER BY usd DESC, last_at DESC
   LIMIT $3`;

// A share to three places: enough to say "Under 1%", nothing finer.
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

/**
 * The week as Settings draws it, from the person's cap and spend (cents)
 * and their requests (dollars, as the ledger keeps them). Pure.
 *   { limited, usedShare, usedUp, resetsAt, requests, otherShare }
 * With a cap, a request's share is of the week's building time; with none
 * (an admin cap of 0), of what they used.
 */
function weekView({ capCents, spentCents, rows, resetsAt }) {
  const cap = Number(capCents) > 0 ? Number(capCents) : 0;
  const spent = Math.max(0, Number(spentCents) || 0);
  const whole = cap || spent;
  const requests = rows.map((r) => ({
    app: { slug: r.slug, name: r.name || r.slug },
    issueNumber: Number(r.issue_number),
    title: r.title ? String(r.title).slice(0, 200) : null,
    share: share((Number(r.usd) || 0) * 100, whole),
    asked: r.asked === true,
    runs: Number(r.runs) || 0,
  }));
  const listedCents = rows.reduce((sum, r) => sum + (Number(r.usd) || 0) * 100, 0);
  return {
    limited: cap > 0,
    usedShare: cap > 0 ? share(spent, cap) : null,
    usedUp: cap > 0 && spent >= cap,
    resetsAt,
    requests,
    // The requests past the list's end, together.
    otherShare: share(Math.max(0, spent - listedCents), whole),
  };
}

/** This person's week. Reads the bot's settings for their cap. */
async function weekFor(pool, userId, deps = {}) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const limits = deps.limits || require('./limits');
  const settings = deps.settings || await require('./homeroom-bot').readSettings(pool);
  const weekStart = limits.weekStartUtc();
  const [capCents, spentCents, { rows }] = await Promise.all([
    dm.weeklyCapCents(pool, settings, userId),
    dm.weeklySpentCents(pool, userId),
    pool.query(REQUESTS_SQL, [userId, weekStart, MAX_REQUESTS]),
  ]);
  return weekView({ capCents, spentCents, rows, resetsAt: limits.weeklyResetAt() });
}

/**
 * Staging's demo week, for `?demo=1`: staging has none of the bot's runs to
 * read. Obviously fake, written nowhere. Pure.
 */
function demoWeek(resetsAt) {
  return {
    limited: true,
    usedShare: 0.62,
    usedUp: false,
    resetsAt,
    requests: [
      { app: { slug: 'staging-demo', name: 'Staging demo board' }, issueNumber: 12, title: 'Staging demo: a dark mode for the board', share: 0.31, asked: false, runs: 3 },
      { app: { slug: 'staging-demo', name: 'Staging demo board' }, issueNumber: 15, title: 'Staging demo: export the board as a list', share: 0.18, asked: false, runs: 1 },
      { app: { slug: 'staging-garden', name: 'Staging demo garden' }, issueNumber: 4, title: 'Staging demo: water reminders', share: 0.12, asked: true, runs: 1 },
      { app: { slug: 'staging-garden', name: 'Staging demo garden' }, issueNumber: 7, title: null, share: 0.004, asked: false, runs: 1 },
    ],
    otherShare: 0,
    demo: true,
  };
}

module.exports = { MAX_REQUESTS, weekView, weekFor, demoWeek };
