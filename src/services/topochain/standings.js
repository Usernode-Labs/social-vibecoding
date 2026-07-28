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
// of this SQL.
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
//   - identity columns (`email`, `telegram`, `discord`, `display_name`)
//     and `is_non_podium` (`users.exclude_podium`) — every caller needs
//     these to mask/format a row, so they're joined once here instead of
//     N times by each consumer.
const STANDINGS_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (ls.season_event_id, ls.user_id)
           ls.user_id, ls.season_event_id, ls.total_points, ls.extra_points,
           ls.event_total_produced_blocks, se.starts_at
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
         u.exclude_podium AS is_non_podium,
         u.email, u.telegram, u.discord, u.display_name
    FROM latest l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN last_event le ON le.user_id = l.user_id
   GROUP BY l.user_id, u.exclude_podium, u.email, u.telegram, u.discord, u.display_name
   ORDER BY SUM(l.total_points) DESC, l.user_id ASC
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
// Returns rows pre-sorted by total_points DESC (then user_id ASC to keep
// ties deterministic) with `rank` assigned per the shared-rank rule
// above. Numbers are already cast (num()/Number()) so callers can hand
// them straight to `ok()` without a second pass.
async function computeStandings(pool, { seasonId = null } = {}) {
  const { rows } = await pool.query(STANDINGS_SQL, [seasonId]);
  const cast = rows.map((r) => ({
    user_id: Number(r.user_id),
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    events_participated: Number(r.events_participated) || 0,
    total_produced_blocks: Number(r.total_produced_blocks) || 0,
    total_produced_blocks_last_event: Number(r.total_produced_blocks_last_event) || 0,
    is_non_podium: !!r.is_non_podium,
    email: r.email,
    telegram: r.telegram,
    discord: r.discord,
    display_name: r.display_name,
  }));
  return assignSharedRanks(cast);
}

module.exports = { computeStandings, assignSharedRanks, STANDINGS_SQL };
