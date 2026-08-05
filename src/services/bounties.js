// Issue-bounty placement — one definition, two callers.
//
// A "bounty" is a symbolic off-chain pledge (no tokens) that debits the
// giver's SHARED weekly kudos allowance. When a merged PR closes the issue,
// the open bounty is awarded to that PR's author (routes/votes.js
// resolveIssueBounty) and counts as kudos everywhere kudos are counted.
//
// Two surfaces create one:
//   1. POST /api/apps/:slug/issues/:number/bounty (src/routes/issues.js) —
//      the "Pledge kudos" button on a Dev-screen issue row. It verifies the
//      target is a currently-open GitHub issue BEFORE calling in here.
//   2. POST /api/feedback with `bounty: true` (src/routes/feedback.js) — the
//      Send Feedback dialog's "Put a kudos bounty on this" checkbox, which
//      pledges on the issue it just filed. No open-issue verification: the
//      platform created the issue microseconds earlier, so it is open by
//      construction.
//
// The allowance constant and its counter live HERE rather than in
// routes/kudos.js for the same reason weekStartUtc lives in
// services/leaderboard-users.js: a service must not depend on a route that
// depends on IT. routes/kudos.js re-exports both unchanged, so every existing
// importer (src/routes/issues.js, tests/kudos.test.js) is unaffected.
'use strict';

const log = require('./logger');
const events = require('./events');
const { weekStartUtc } = require('./leaderboard-users');

// Weekly quota per giver, shared across PR kudos and issue bounties. Moving
// this number is the whole of the "give users way more kudos" half of #964 —
// every read site (the /api/me/kudos-budget badge, both 429 messages, the
// `remaining` figure in four responses, the leaderboard's kudos_given clamp)
// interpolates it rather than hardcoding a literal.
const WEEKLY_KUDOS_LIMIT = 20;

// The SHARED weekly "give" allowance: PR kudos + issue bounties draw from the
// same WEEKLY_KUDOS_LIMIT pool, so a user can't exceed that many total
// combined gives per week. Both the PR-kudos give endpoint and the two
// bounty-creating surfaces gate on this combined figure. One round-trip across
// both ledgers; uses idx_pr_kudos_giver_week + idx_issue_bounties_giver_week.
//
// A pledged bounty normally keeps consuming its slot whatever its outcome
// (open → awarded), but a VOIDED bounty is refunded: it no longer counts
// against the limit. The only thing that voids a bounty is the self-kudos
// guard at merge time (routes/votes.js resolveIssueBounty) — when a user
// pledged on an issue their own PR then closed. That void is a system-imposed
// outcome the pledger can't avoid, so the slot is returned for them to spend
// on someone else's PR. Hence the `status <> 'voided'` filter below.
async function countWeeklyAllowanceUsed(pool, userId, weekStart) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM pr_kudos
          WHERE giver_user_id = $1 AND week_start = $2)
       +
       (SELECT COUNT(*) FROM issue_bounties
          WHERE giver_user_id = $1 AND week_start = $2
            AND status <> 'voided') AS c`,
    [userId, weekStart]
  );
  return parseInt(rows[0]?.c, 10) || 0;
}

// Place one bounty. `app` is an ALREADY-RESOLVED app row carrying at least
// { id, slug }; `user` is req.user; `issueNumber` is the GitHub issue number
// on that app's repo. The caller owns access control (collab gate) and, where
// it matters, open-issue verification — this function owns the ledger.
//
// Returns a discriminated result rather than throwing, so the two callers can
// pick their own HTTP semantics:
//   { ok: true,  bountyId, bountyCount, remaining, limit }
//   { ok: false, code: 'quota'|'duplicate', error, remaining, limit }
// A genuine failure (DB down) still throws — the standalone route turns that
// into its 500, and the feedback path catches it so a filed issue is never
// lost over a bounty.
//
// The side effects after the insert (event, chat messages, WS push) mirror
// what the standalone route did inline before the extraction, byte for byte in
// wording, so the chat history reads identically whichever surface pledged.
async function placeBounty(pool, { app, user, issueNumber }) {
  const weekStart = weekStartUtc();

  // Allowance check. Race window: two parallel requests from the same user
  // could both pass and both insert, letting one user overshoot the cap by at
  // most 1. Bounded, rare, not security-critical — same documented trade-off
  // as the PR-kudos give path, and the leaderboard's LEAST(COUNT(*), limit)
  // clamp hides it from the one place it would otherwise show.
  const used = await countWeeklyAllowanceUsed(pool, user.id, weekStart);
  if (used >= WEEKLY_KUDOS_LIMIT) {
    return {
      ok: false,
      code: 'quota',
      error: `Weekly kudos quota exceeded (${WEEKLY_KUDOS_LIMIT}/week). Resets every Monday 00:00 UTC.`,
      remaining: 0,
      limit: WEEKLY_KUDOS_LIMIT,
    };
  }

  let inserted;
  try {
    const { rows } = await pool.query(
      `INSERT INTO issue_bounties (app_id, github_issue_number, giver_user_id, week_start, status)
       VALUES ($1, $2, $3, $4, 'open')
       RETURNING id, created_at`,
      [app.id, issueNumber, user.id, weekStart]
    );
    inserted = rows[0];
  } catch (err) {
    // Partial unique index on open bounties → already pledged.
    if (err.code === '23505') {
      return {
        ok: false,
        code: 'duplicate',
        error: 'You already placed a bounty on this issue',
        remaining: Math.max(0, WEEKLY_KUDOS_LIMIT - used),
        limit: WEEKLY_KUDOS_LIMIT,
      };
    }
    throw err;
  }

  events.record(pool, {
    type: events.EVENT_TYPES.BOUNTY_CREATED,
    userId: user.id,
    appId: app.id,
    metadata: { issueNumber },
  });

  // Open-bounty count for this issue after the insert, for live FE update.
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM issue_bounties
      WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
    [app.id, issueNumber]
  );
  const bountyCount = countRows[0]?.c || 0;

  // Required lazily: services/ws.js pulls in a wide slice of the server, and
  // this module is imported by routes/kudos.js at load time.
  const { sendSystemMessage, pushIssueUpdate } = require('./ws');
  const bountyMsg = `${user.username} placed a bounty (kudos) on issue #${issueNumber}`;
  await sendSystemMessage(pool, app.id, bountyMsg, 'system')
    .catch((err) => log.warn('bounties', 'Bounty chat message failed', { err: err.message }));
  // Dual-post into the issue's thread (lifecycle in context).
  await sendSystemMessage(pool, app.id, bountyMsg, 'system',
    null, { type: 'issue', ref: issueNumber }).catch(() => {});

  pushIssueUpdate({
    action: 'bounty', appSlug: app.slug, appId: app.id,
    issueNumber, bountyCount,
  });

  const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - (used + 1));
  log.info('bounties', 'Bounty created', {
    appId: app.id, issueNumber, giverId: user.id, remaining,
  });
  return {
    ok: true,
    bountyId: inserted.id,
    bountyCount,
    remaining,
    limit: WEEKLY_KUDOS_LIMIT,
  };
}

module.exports = {
  WEEKLY_KUDOS_LIMIT,
  countWeeklyAllowanceUsed,
  placeBounty,
};
