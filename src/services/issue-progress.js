'use strict';

// WHICH ISSUES SOMEBODY IS ACTUALLY WORKING ON, and the two rules that
// decide it. Both halves are described on `issue_claims` in schema.sql:
//
//   hand-set   a row in issue_claims — somebody pressed Claim
//   automatic  a live dev session whose linked_issues names the issue
//
// The Board has computed this since the status existed (GET /github-issues
// in routes/issues.js). The WORKSHOP did not: it pushed every issue as
// `state: 'open'` and reached `underway` only for a shared dev session, so
// an issue you had claimed sat in the open lane while your own session sat
// in the underway lane — one piece of work, two cards, two places. That is
// #1903.
//
// This module exists so that gap does not close into a SECOND COPY of the
// rules. The liveness predicates are the subtle half — a claim ages out on
// the freshest of its own `claimed_at` and the issue thread's last message,
// which is not a thing anybody reimplements the same way twice — and #1894
// was the same shape of bug one layer down: an address written twice, one
// copy of which stopped being true.
//
// routes/issues.js keeps its own bulk read rather than calling
// inProgressIssueNumbers(): it needs per-issue DETAIL (who, which sessions,
// each claim's expiry) for the chip, and it already holds the thread
// timestamps that read needs, so a second query on that hot path would buy
// nothing. What it shares is the part worth sharing — the constants and the
// two predicates below.

// "In progress" status windows. Two separate 7-day constants on purpose —
// they protect different things and may be tuned independently:
//  - IN_PROGRESS_PAUSED_WINDOW_DAYS: how long a PAUSED (never-promoted,
//    never-archived) session keeps counting toward an issue's derived
//    in-progress status. Active/promoted/merging sessions always count;
//    archived/merged never do; paused ones age out on last_activity_at
//    because nothing ever archives them automatically.
//  - ISSUE_CLAIM_TTL_DAYS: how long a manual issue_claims row stays live
//    without activity. Activity = the claim's own claimed_at (renewed by
//    re-POSTing) OR any message in the issue's discussion thread, so an
//    issue under active discussion keeps its claims alive with no writes.
const IN_PROGRESS_PAUSED_WINDOW_DAYS = 7;
const ISSUE_CLAIM_TTL_DAYS = 7;

const CLAIM_TTL_MS = ISSUE_CLAIM_TTL_DAYS * 24 * 3600 * 1000;

/** Epoch ms for a loose timestamp, 0 when it does not parse. */
function ms(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * The instant a claim stops counting: the TTL measured from the FRESHEST of
 * its own `claimed_at` and the issue thread's last message. Expiry is a
 * read-time filter — no row is ever swept — so this is the only definition
 * of "live", and both readers take it from here.
 */
function claimExpiresAt(claimedAt, threadLastAt) {
  return new Date(Math.max(ms(claimedAt), ms(threadLastAt)) + CLAIM_TTL_MS);
}

/** Whether a claim still counts, at `now` (default: this instant). */
function claimIsLive(claimedAt, threadLastAt, now) {
  const at = now == null ? Date.now() : (now instanceof Date ? now.getTime() : now);
  return claimExpiresAt(claimedAt, threadLastAt).getTime() > at;
}

/**
 * The issue numbers somebody is working on in this app, both halves folded
 * together. A Set, because the caller asking this question wants to place a
 * card, not to describe who is on it — routes/issues.js is where the second
 * question is answered.
 *
 * Three reads rather than one join: the sessions and the claims have
 * different liveness rules (one in SQL, one at read time against thread
 * activity), and the thread timestamps are needed for the second. Bounded
 * by app, and the Workshop already runs several queries of this size.
 */
async function inProgressIssueNumbers(pool, appId) {
  const out = new Set();
  if (!pool || !appId) return out;

  // The automatic half. Same predicate as the Board's: active, promoted and
  // merging always count; paused ages out on last_activity_at; archived and
  // merged exclude themselves. Headless runs are deliberately absent — they
  // ship as their own field and are ORed by the client, not here.
  const { rows: sessionRows } = await pool.query(
    `SELECT DISTINCT UNNEST(cs.linked_issues) AS n
       FROM chat_sessions cs
      WHERE cs.app_id = $1 AND cs.is_headless = FALSE
        AND cardinality(cs.linked_issues) > 0
        AND (cs.status IN ('active','promoted','merging')
             OR (cs.status = 'paused'
                 AND cs.last_activity_at > NOW() - make_interval(days => $2)))`,
    [appId, IN_PROGRESS_PAUSED_WINDOW_DAYS]
  );
  for (const r of sessionRows) {
    const n = Number(r.n);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }

  // The hand-set half. Every claim row, filtered at read time against the
  // freshest of its own clock and the issue thread's.
  const { rows: claimRows } = await pool.query(
    `SELECT ic.github_issue_number AS n, ic.claimed_at
       FROM issue_claims ic
      WHERE ic.app_id = $1`,
    [appId]
  );
  if (!claimRows.length) return out;

  // Thread activity for exactly the issues that have a claim, so an issue
  // under discussion keeps its claims alive without anybody re-pressing.
  const claimed = [...new Set(claimRows.map((c) => Number(c.n)).filter(Boolean))];
  const { rows: threadRows } = await pool.query(
    `SELECT thread_ref AS n, MAX(created_at) AS last_at
       FROM chat_messages
      WHERE app_id = $1 AND thread_type = 'issue'
        AND thread_ref = ANY($2::int[])
      GROUP BY thread_ref`,
    [appId, claimed]
  );
  const lastAtByNumber = new Map(threadRows.map((r) => [Number(r.n), r.last_at]));

  const now = Date.now();
  for (const c of claimRows) {
    const n = Number(c.n);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (claimIsLive(c.claimed_at, lastAtByNumber.get(n), now)) out.add(n);
  }
  return out;
}

module.exports = {
  IN_PROGRESS_PAUSED_WINDOW_DAYS,
  ISSUE_CLAIM_TTL_DAYS,
  claimExpiresAt,
  claimIsLive,
  inProgressIssueNumbers,
};
