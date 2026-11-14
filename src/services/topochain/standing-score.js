// Topochain standing score — the ONE definition of "where does a player
// stand", shared by every surface that ranks a board.
//
// Request #6039: the Standings board used to be ordered by points alone.
// A player whose work was judged useful, and who scored on a wider spread
// of the season's challenges, should be able to sit above a player with
// the same points who only produced blocks. This module pins that as one
// small, capped score built from data the app already stores, plus an
// explicit tie-break chain — the "smarter rank" first version the spec
// describes.
//
// Why it lives on its own: three writers and readers must agree on the
// SAME number, or the stored per-event board and the live season
// aggregate would disagree about the same person (the spec calls this out
// as the reason both go through one factor function):
//   - snapshot-builder.js computes the score at snapshot time and writes
//     it to leaderboard_snapshots.standings_score (the sort key every
//     per-event read uses);
//   - standings.js re-derives it over the SUMS of the stored inputs for
//     the season board (STANDINGS_SQL) and the one-row answer
//     (OWN_STANDING_SQL);
//   - both sort by the SAME tie-break chain below, expressed once in
//     `STANDING_ORDER_BY` so a per-event list and a season list cannot
//     drift apart.
//
// Everything in the arithmetic half is pure over plain numbers, so
// tests/topochain-scoring.test.js can pin it without a database.
'use strict';

// The two factors, as named constants rather than magic numbers buried in
// a formula: the spec calls the weights a judgment call, deliberately
// small and capped so this ships as an ordering tweak, not a change to
// what points mean. Raising either later is a one-line change here.
const QUALITY_WEIGHT = 0.25;      // quality_factor tops out at 1.25
const BREADTH_PER_CHALLENGE = 0.02; // 2% per challenge scored on...
const BREADTH_CAP = 0.20;         // ...capped at +20% (10 challenges)

const round2 = (n) => Math.round(n * 100) / 100;

// quality_factor = 1 + 0.25 x (graded_points / total_points), and exactly
// 1 when there are no points or nothing was graded. Both guards matter:
// dividing by zero would be Infinity, and a zero-point player must stay
// at 1 so the score never falls below their (zero) points.
function qualityFactor(gradedPoints, totalPoints) {
  const total = Number(totalPoints) || 0;
  const graded = Number(gradedPoints) || 0;
  if (total <= 0 || graded <= 0) return 1;
  // Clamped at 1: graded_points is a subset of total_points, so the ratio
  // cannot exceed 1 in practice, but the spec states the factor's bound as
  // 1.00–1.25 and this is where that bound is enforced.
  return 1 + QUALITY_WEIGHT * Math.min(graded / total, 1);
}

// breadth_factor = 1 + MIN(0.20, 0.02 x distinct_challenges). Zero
// challenges scores 1, and ten or more clamps at 1.20.
function breadthFactor(distinctChallenges) {
  const count = Number(distinctChallenges) || 0;
  if (count <= 0) return 1;
  return 1 + Math.min(BREADTH_CAP, BREADTH_PER_CHALLENGE * count);
}

// The one standing score: total_points x quality_factor x breadth_factor,
// rounded to 2 dp. Both factors are >= 1, so the score is monotone in
// points — a player can never fall below their own point total, and the
// caps stop it being inflated without bound.
function standingScore({ totalPoints = 0, gradedPoints = 0, distinctChallenges = 0 } = {}) {
  const total = Number(totalPoints) || 0;
  return round2(total * qualityFactor(gradedPoints, total) * breadthFactor(distinctChallenges));
}

// The tie-break chain, in ONE place: score descending, then the rate the
// player actually delivered at, then the raw block count, then how many
// challenges they scored on, then user_id ascending (stable and internal;
// never serialized to a public response). Each term carries the SAME
// table alias the caller's query uses, so the two standings queries and
// the builder's in-memory sort can share the expression.
//
// `rateExpr` is `event_success_rate` on a per-event row and the
// re-derived season rate on the aggregate. A NULL rate sorts LAST
// (`NULLS LAST`), which is what "a null or 0 rate sorts last" means for a
// player who never won a slot; a stored 0 sorts above it by value, which
// is correct — 0 is "won slots but produced none", still an observation.
//
// The expression returns a STRING for use after ORDER BY. In SQL a NULL
// and a 0 are different, and this preserves that: the caller keeps
// `NULLS LAST` on the rate term.
function standingOrderBy({ score = 'standings_score', rate = 'event_success_rate', blocks = 'event_total_produced_blocks', challenges = 'distinct_challenges', user = 'user_id' } = {}) {
  return `${score} DESC, ${rate} DESC NULLS LAST, ${blocks} DESC, ${challenges} DESC, ${user} ASC`;
}

// The in-memory twin of `standingOrderBy`, for the builder, which sorts
// plain rows before writing them. Same chain, same directions, so a row's
// rank is the same whether it was ranked here or read back from SQL.
function compareStandingRows(a, b) {
  const byScore = (Number(b.standings_score) || 0) - (Number(a.standings_score) || 0);
  if (byScore) return byScore;
  // NULL rate sorts last, exactly as `NULLS LAST` does in SQL.
  const rateA = a.event_success_rate === null || a.event_success_rate === undefined ? -1 : Number(a.event_success_rate);
  const rateB = b.event_success_rate === null || b.event_success_rate === undefined ? -1 : Number(b.event_success_rate);
  if (rateB !== rateA) return rateB - rateA;
  const byBlocks = (Number(b.event_total_produced_blocks) || 0) - (Number(a.event_total_produced_blocks) || 0);
  if (byBlocks) return byBlocks;
  const byChallenges = (Number(b.distinct_challenges) || 0) - (Number(a.distinct_challenges) || 0);
  if (byChallenges) return byChallenges;
  return (Number(a.user_id) || 0) - (Number(b.user_id) || 0);
}

// ─── SQL mirrors ────────────────────────────────────────────────────────
//
// The season board and the one-row answer rank in SQL (a season is a SUM
// over snapshots, and OWN_STANDING_SQL computes its rank in a window), so
// the same arithmetic needs an SQL spelling. These two helpers are the
// ONLY place it is written in SQL, and tests/topochain-scoring.test.js
// pins the JS spellings above; tests/topochain-own-standing.test.js pins
// the SQL rank against the JS-ordered list on real Postgres. Every
// argument is a SQL expression, so the same helper serves a per-event
// column and a SUM over a CTE.

// `totalPoints x quality_factor x breadth_factor`, rounded to 2 dp — the
// SQL twin of standingScore() above. `CASE WHEN ... THEN ... ELSE 0 END`
// is the guard that keeps a zero-point or ungraded player at factor 1
// instead of dividing by zero.
function standingScoreSql({ totalPoints, gradedPoints, distinctChallenges }) {
  return `ROUND((${totalPoints})::numeric
       * (1 + 0.25 * CASE WHEN (${totalPoints}) > 0 AND (${gradedPoints}) > 0
                           THEN LEAST((${gradedPoints})::numeric / (${totalPoints}), 1) ELSE 0 END)
       * (1 + LEAST(0.20, 0.02 * GREATEST((${distinctChallenges})::numeric, 0))), 2)`;
}

// The season's success rate: produced blocks over the won slots implied
// by each snapshot's own rate (won = produced / (rate / 100)). Kept NULL
// when no slots were won anywhere, so a scope with no block production
// has no rate to rank by — exactly the "null sorts last" case. `100.0`
// forces numeric division.
function seasonSuccessRateSql({ producedBlocks, successRate }) {
  const won = `CASE WHEN (${successRate}) > 0
                    THEN (${producedBlocks})::numeric / ((${successRate})::numeric / 100)
               END`;
  return `CASE WHEN SUM(${won}) > 0
               THEN ROUND(SUM((${producedBlocks})::numeric) / SUM(${won}) * 100, 2)
          END`;
}

// The per-event factor inputs, one aggregate over the points ledger for
// the event. `graded_points` is the points from rows the grader judged
// (`metadata.grade`), and `distinct_challenges` is how many different
// challenges the player scored on. Rows for the same (user, event) come
// back keyed by user_id so the builder can fold them onto its snapshot
// rows.
const ACTIVITY_STANDING_INPUTS_SQL = `
  SELECT user_id,
         COALESCE(SUM(points) FILTER (WHERE metadata->'grade' IS NOT NULL), 0) AS graded_points,
         COUNT(DISTINCT challenge_id) AS distinct_challenges
    FROM user_activities
   WHERE season_event_id = $1
   GROUP BY user_id
`;

module.exports = {
  QUALITY_WEIGHT,
  BREADTH_PER_CHALLENGE,
  BREADTH_CAP,
  qualityFactor,
  breadthFactor,
  standingScore,
  standingOrderBy,
  standingScoreSql,
  seasonSuccessRateSql,
  compareStandingRows,
  ACTIVITY_STANDING_INPUTS_SQL,
};
