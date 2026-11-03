// Topochain v4 — the shared cross-event standings query (SPEC §4.10,
// lines 2922-2959: "Implement it ONCE as a shared query and reuse it").
//
// Three consumers need a cross-event ranking that the target schema has
// no dedicated table for (the source's `global_leaderboard` is excluded
// from this migration): `GET /leaderboard/global` (Task 5, this file's
// first caller), the rank column on `GET /leaderboard` in season/all-time
// modes (see the route comment in public.js for what "mode" means here),
// and the `global` scope of mobile `GET /me/ranking` (Task 9). All three
// get their numbers from `computeStandings()` below — never a second copy
// of this SQL. The one exception lives in this same file and is pinned to
// it: `computeOwnStanding()` answers "where does ONE user sit" for
// `/me/ranking` without materialising everyone else's row (#2777).
//
// The §4.10 aggregate itself is exactly four columns per user: SUM
// total_points, SUM extra_points, COUNT DISTINCT season_event_id, SUM
// event_total_produced_blocks — computed over the LATEST leaderboard
// snapshot per (user, event) (max snapshot_at, ties broken by max id,
// SPEC 960) within the events "in scope" (a season, or none for
// all-time), restricted to public (non-internal) events since internal
// events never surface in any public standings view (mirrors the
// `season_events` list endpoint's own "internal events are never
// returned" rule). Everything past those four columns below
// (`total_produced_blocks_last_event`, the identity columns, and
// `is_non_podium`) is this module's own value-add so callers don't have
// to re-join `users`/`season_events` themselves; it does not change what
// the §4.10 aggregate computes.
'use strict';

const { num } = require('../../routes/topochain/helpers');
const {
  standingOrderBy,
  standingScoreSql,
  seasonSuccessRateSql,
} = require('./standing-score');

// The §4.10 aggregate, extended with:
//   - `total_produced_blocks_last_event` — SPEC's `GET /leaderboard/global`
//     response carries `total_produced_blocks_last_phase` (source name);
//     per the v4 phase->event rename (Global Constraints #10 — every
//     reference to an event is renamed, not just the FK columns) this
//     becomes `total_produced_blocks_last_event` here: the
//     `event_total_produced_blocks` value from whichever of the user's
//     in-scope events has the latest `starts_at` (their most recent
//     event), picked via a ROW_NUMBER() window over the same `latest`
//     CTE the aggregate already builds.
//   - identity columns (`email`, `telegram`, `discord`, `display_name`,
//     `username`) and `is_non_podium` (`users.exclude_podium`) — every
//     caller needs these to mask/format a row, so they're joined once here
//     instead of N times by each consumer.
const STANDINGS_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (ls.season_event_id, ls.user_id)
           ls.user_id, ls.season_event_id, ls.total_points, ls.extra_points,
           ls.event_total_produced_blocks, ls.event_success_rate,
           ls.graded_points, ls.distinct_challenges, se.starts_at
      FROM leaderboard_snapshots ls
      JOIN season_events se ON se.id = ls.season_event_id
     WHERE se.internal = FALSE
       AND ($1::bigint IS NULL OR se.season_id = $1)
     ORDER BY ls.season_event_id, ls.user_id, ls.snapshot_at DESC, ls.id DESC
  ),
  last_event AS (
    SELECT DISTINCT ON (user_id) user_id,
           event_total_produced_blocks AS total_produced_blocks_last_event
      FROM latest
     ORDER BY user_id, starts_at DESC, season_event_id DESC
  )
  SELECT l.user_id,
         SUM(l.total_points)                      AS total_points,
         SUM(l.extra_points)                       AS extra_points,
         COUNT(DISTINCT l.season_event_id)         AS events_participated,
         SUM(l.event_total_produced_blocks)        AS total_produced_blocks,
         MAX(le.total_produced_blocks_last_event)  AS total_produced_blocks_last_event,
         -- #6039: the season board re-derives the SAME two factors the
         -- per-event board applies, over the SUMS of the stored inputs —
         -- so one rule ranks both surfaces. The tie-break rate is the
         -- scope's own produced ÷ won, kept NULL when no slots were won
         -- anywhere (the "null sorts last" case); the two factors and the
         -- score come from standing-score.js, never a second spelling.
         SUM(l.graded_points)                      AS graded_points,
         SUM(l.distinct_challenges)                AS distinct_challenges,
         ${standingScoreSql({
           totalPoints: 'SUM(l.total_points)',
           gradedPoints: 'SUM(l.graded_points)',
           distinctChallenges: 'SUM(l.distinct_challenges)',
         })}                                        AS standings_score,
         ${seasonSuccessRateSql({
           producedBlocks: 'l.event_total_produced_blocks',
           successRate: 'l.event_success_rate',
         })}                                        AS season_success_rate,
         u.exclude_podium AS is_non_podium,
         u.email, u.telegram, u.discord, u.display_name, u.username
    FROM latest l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN last_event le ON le.user_id = l.user_id
   GROUP BY l.user_id, u.exclude_podium, u.email, u.telegram, u.discord, u.display_name,
            u.username
   ORDER BY ${standingOrderBy({
     score: 'standings_score',
     rate: 'season_success_rate',
     blocks: 'SUM(l.event_total_produced_blocks)',
     challenges: 'SUM(l.distinct_challenges)',
     user: 'l.user_id',
   })}
`;

// ─── Shared-rank rule (SPEC 959, 2957) ──────────────────────────────────
//
// "Podium-excluded users take the next rank without consuming a slot":
// walking the already-points-ordered rows top to bottom, a normal user
// gets the current counter value and then bumps it; a podium-excluded
// user gets the CURRENT counter value too (so it visibly shares a rank
// with whoever ends up getting that same number next) but never bumps
// the counter — the next normal user effectively "reuses" the slot the
// excluded user sat in. A run of excluded users at the very end of the
// list (no further normal user to share with) still just gets the
// counter's current value; nothing consumes it, so nothing is skipped.
function assignSharedRanks(rows) {
  let counter = 1;
  return rows.map((row) => {
    const withRank = { ...row, rank: counter };
    if (!row.is_non_podium) counter += 1;
    return withRank;
  });
}

// computeStandings(pool, { seasonId }) -> ranked rows for one scope.
//   seasonId undefined/null -> all-time (every public event, any season).
//   seasonId set            -> that one season's public events only.
// Returns rows pre-sorted by the standing score and its tie-break chain
// (#6039, the SAME order the builder writes the per-event board in) with
// `rank` assigned per the shared-rank rule above. Numbers are already
// cast (num()/Number()) so callers can hand them straight to `ok()`
// without a second pass.
async function computeStandings(pool, { seasonId = null } = {}) {
  const { rows } = await pool.query(STANDINGS_SQL, [seasonId]);
  const cast = rows.map((r) => ({
    user_id: Number(r.user_id),
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    events_participated: Number(r.events_participated) || 0,
    total_produced_blocks: Number(r.total_produced_blocks) || 0,
    total_produced_blocks_last_event: Number(r.total_produced_blocks_last_event) || 0,
    // #6039: the standing score and its two inputs, carried so a caller can
    // show why a row sits where it does (the drill-down's figures).
    standings_score: num(r.standings_score) ?? 0,
    graded_points: num(r.graded_points) ?? 0,
    distinct_challenges: Number(r.distinct_challenges) || 0,
    is_non_podium: !!r.is_non_podium,
    email: r.email,
    telegram: r.telegram,
    discord: r.discord,
    display_name: r.display_name,
    username: r.username,
  }));
  return assignSharedRanks(cast);
}

// ─── One user's row of the same aggregate (#2777) ───────────────────────
//
// `GET /me/ranking` needs exactly one row of the standings — the caller's —
// plus the participant count. It used to call computeStandings() and
// `.find()` its own user, which pulled every participant's row (with their
// identity columns and the `last_event` window it never reads) into Node to
// throw all but one away. That was the slowest request behind the Profile tab.
//
// This is the SAME §4.10 aggregate, ranked by the SAME shared-rank rule, in
// SQL, filtered to one user at the end:
//   - "latest snapshot per (user, event)" is resolved with MAX(snapshot_at)
//     and a join back, rather than DISTINCT ON … ORDER BY snapshot_at DESC,
//     id DESC. The two pick the same row because (season_event_id, user_id,
//     snapshot_at) is UNIQUE on leaderboard_snapshots, so the id tie-break
//     never decides anything — and a hash aggregate does not have to sort
//     the whole scope (the DISTINCT ON sort spilled to disk on a seeded
//     576k-snapshot table).
//   - rank = 1 + the number of NON-podium-excluded users ordered strictly
//     ahead (points DESC, user_id ASC), which is what assignSharedRanks()
//     computes walking the list: only a normal user bumps the counter.
//     `exclude_podium` NULL counts as a normal user, as `!!` does there.
//   - total_participants = every ranked row, as `standings.length` was.
// tests/topochain-own-standing.test.js pins it against computeStandings().
const OWN_STANDING_SQL = `
  WITH latest_at AS (
    SELECT ls.season_event_id, ls.user_id, MAX(ls.snapshot_at) AS snapshot_at
      FROM leaderboard_snapshots ls
      JOIN season_events se ON se.id = ls.season_event_id
     WHERE se.internal = FALSE
       AND ($1::bigint IS NULL OR se.season_id = $1)
     GROUP BY ls.season_event_id, ls.user_id
  ),
  totals AS (
    SELECT ls.user_id,
           SUM(ls.total_points)                AS total_points,
           SUM(ls.extra_points)                AS extra_points,
           COUNT(DISTINCT ls.season_event_id)  AS events_participated,
           SUM(ls.event_total_produced_blocks) AS total_produced_blocks,
           -- #6039: the same inputs the season aggregate carries, so this
           -- one-row answer ranks by the same rule (see STANDINGS_SQL).
           SUM(ls.graded_points)               AS graded_points,
           SUM(ls.distinct_challenges)         AS distinct_challenges,
           ${standingScoreSql({
             totalPoints: 'SUM(ls.total_points)',
             gradedPoints: 'SUM(ls.graded_points)',
             distinctChallenges: 'SUM(ls.distinct_challenges)',
           })}                                  AS standings_score,
           ${seasonSuccessRateSql({
             producedBlocks: 'ls.event_total_produced_blocks',
             successRate: 'ls.event_success_rate',
           })}                                  AS season_success_rate
      FROM latest_at la
      JOIN leaderboard_snapshots ls
        ON ls.season_event_id = la.season_event_id
       AND ls.user_id = la.user_id
       AND ls.snapshot_at = la.snapshot_at
     GROUP BY ls.user_id
  ),
  ranked AS (
    SELECT t.user_id, t.total_points, t.extra_points, t.events_participated,
           t.total_produced_blocks, t.standings_score, t.graded_points,
           t.distinct_challenges,
           COUNT(*) OVER () AS total_participants,
           1 + COALESCE(SUM(CASE WHEN u.exclude_podium THEN 0 ELSE 1 END) OVER (
                 ORDER BY ${standingOrderBy({
                   score: 't.standings_score',
                   rate: 't.season_success_rate',
                   blocks: 't.total_produced_blocks',
                   challenges: 't.distinct_challenges',
                   user: 't.user_id',
                 })}
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0) AS rank
      FROM totals t
      JOIN users u ON u.id = t.user_id
  )
  SELECT user_id, total_points, extra_points, events_participated,
         total_produced_blocks, standings_score, graded_points,
         distinct_challenges, total_participants, rank
    FROM ranked
   WHERE user_id = $2
`;

// Participant count when the user has no row of their own (so the query
// above returns nothing): the same scope, counted.
const PARTICIPANT_COUNT_SQL = `
  SELECT COUNT(DISTINCT ls.user_id)::int AS total_participants
    FROM leaderboard_snapshots ls
    JOIN season_events se ON se.id = ls.season_event_id
    JOIN users u ON u.id = ls.user_id
   WHERE se.internal = FALSE
     AND ($1::bigint IS NULL OR se.season_id = $1)
`;

// computeOwnStanding(pool, { seasonId, userId })
//   -> { own: <row as computeStandings would have found it> | null,
//        totalParticipants: <what standings.length was> }
async function computeOwnStanding(pool, { seasonId = null, userId } = {}) {
  const { rows } = await pool.query(OWN_STANDING_SQL, [seasonId, userId]);
  const r = rows[0];
  if (r) {
    return {
      own: {
        user_id: Number(r.user_id),
        rank: Number(r.rank),
        total_points: num(r.total_points) ?? 0,
        extra_points: num(r.extra_points) ?? 0,
        events_participated: Number(r.events_participated) || 0,
        total_produced_blocks: Number(r.total_produced_blocks) || 0,
        // #6039: the standing score and its two inputs, matching what
        // computeStandings() carries so the two agree field for field.
        standings_score: num(r.standings_score) ?? 0,
        graded_points: num(r.graded_points) ?? 0,
        distinct_challenges: Number(r.distinct_challenges) || 0,
      },
      totalParticipants: Number(r.total_participants) || 0,
    };
  }
  const { rows: countRows } = await pool.query(PARTICIPANT_COUNT_SQL, [seasonId]);
  return { own: null, totalParticipants: Number(countRows[0] && countRows[0].total_participants) || 0 };
}

module.exports = {
  computeStandings,
  computeOwnStanding,
  assignSharedRanks,
  STANDINGS_SQL,
  OWN_STANDING_SQL,
  PARTICIPANT_COUNT_SQL,
};
