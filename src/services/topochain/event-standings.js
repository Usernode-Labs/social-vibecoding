// Topochain per-event standings — the ONE definition of "which event does a
// public surface show, whose rows are in it, and what is each row called".
//
// This file was extracted from src/routes/topochain/public.js when the home
// screen's Challenges widget started previewing these standings (the
// leaderboard-primary change). Rank is now a number the user sees in two
// places — the Leaderboard screen's table and the widget's fill — so it
// cannot be computed two ways, and neither can the display name: a widget
// that unmasks a row the table masks would be a privacy bug with no obvious
// owner. Same shape, and the same reason, as src/services/leaderboard-users.js
// (the kudos ranking behind the Kudos tab AND the widget's fallback board).
//
// public.js requires everything below and is otherwise unchanged — the SQL
// text, the masking chain and the type-branch are moved verbatim, so
// tests/topochain-public-api.test.js's SQL-shape mock still matches.
//
// The additions this file owns (used by the widget, harmless to the routes):
//   - resolveDefaultPublicEvent() — the server-side twin of
//     public/js/topochain-events.js's pickDefault({ requireLeaderboard: true }).
//   - eventStandingsBoard() — a viewer-INDEPENDENT board (top rows + a
//     user_id -> row index) the caller can memoise and then personalise.
'use strict';

const { num } = require('../../routes/topochain/helpers');
const { computeStandings } = require('./standings');

// ─── Identifier masking + display-name fallback (SPEC 958, 1246) ────────

// Which raw channel backs this user's public "identifier" (judgment
// call #2: email > telegram > discord, no priority given in the spec).
function resolveIdentifier(user) {
  if (user.email) return { type: 'email', value: user.email };
  if (user.telegram) return { type: 'telegram', value: user.telegram };
  if (user.discord) return { type: 'discord', value: user.discord };
  return { type: null, value: null };
}

function maskGeneric(value) {
  return `${String(value).slice(0, 3)}***`;
}

// email -> abc***@***.tld; telegram/discord -> abc*** (SPEC 958).
function maskIdentifier({ type, value }) {
  if (!value) return null;
  if (type === 'email') {
    const at = value.indexOf('@');
    if (at === -1) return maskGeneric(value);
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    const tld = dot === -1 ? '' : domain.slice(dot);
    return `${local.slice(0, 3)}***@***${tld}`;
  }
  return maskGeneric(value);
}

// discord -> display_name -> masked identifier (SPEC 1246's fallback
// chain, reused everywhere a display name is shown).
//
// `includeDiscord: false` (security-review finding) drops the raw discord
// handle from the head of the chain — used ONLY by /leaderboard/global for
// non-admin callers: SPEC 988 marks `discord` ADMIN ONLY on that endpoint
// ("key absent for anonymous callers"), and emitting the same handle
// verbatim as `display_name` would defeat that redaction entirely. Every
// other endpoint keeps the full SPEC 1246 chain (spec mandates it there);
// note the masked-identifier tail may still derive from discord, but only
// in its masked `abc***` form (SPEC 958), never the raw handle.
function resolveDisplayName(user, { includeDiscord = true } = {}) {
  if (includeDiscord && user.discord) return user.discord;
  if (user.display_name) return user.display_name;
  return maskIdentifier(resolveIdentifier(user));
}

// ─── GET /leaderboard: per-event row shape + fetch ───────────────────────

// Single-event leaderboard rows: the latest snapshot per user (SPEC 960)
// joined to the user's identity columns and their onchain account for
// this event (falling back to a season-wide account when no event-scoped
// one exists — same nullable-event-scope idiom `onchain_accounts` itself
// uses). Rank comes straight off the stored `leaderboard_snapshots.rank`
// column — this is the 'regular' event path (see fetchEventLeaderboardRows).
const EVENT_LEADERBOARD_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (ls.user_id) ls.*
      FROM leaderboard_snapshots ls
     WHERE ls.season_event_id = $1
     ORDER BY ls.user_id, ls.snapshot_at DESC, ls.id DESC
  ),
  accounts AS (
    SELECT DISTINCT ON (oa.user_id) oa.user_id, oa.public_key, oa.address
      FROM onchain_accounts oa
     WHERE oa.user_id IS NOT NULL
       AND (oa.season_event_id = $1
            OR (oa.season_event_id IS NULL
                AND oa.season_id = (SELECT season_id FROM season_events WHERE id = $1)))
     ORDER BY oa.user_id, (oa.season_event_id IS NULL) ASC, oa.id DESC
  )
  SELECT l.*, u.email, u.telegram, u.discord, u.display_name, u.exclude_podium,
         a.public_key AS wallet_address, a.address AS bech32m
    FROM latest l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN accounts a ON a.user_id = l.user_id
   ORDER BY l.rank ASC, l.total_points DESC
`;

// Resolves the leaderboard rows for one `season_events` row. 'regular'
// events (the common case, and every event Task 4's fixtures create for
// day-to-day display) read the stored per-event snapshot rows straight —
// SPEC 960. Any other `type` (e.g. the 'season' wrap-up fixture event) has
// no per-event snapshots of its own to rank; SPEC 2935/2957 says this
// rank column is instead "served by the standings query", so it's
// computed live via the shared §4.10 aggregate (judgment call #1) and
// mapped onto the same row shape — per-event-only breakdown fields
// (bug_report_points and friends) aren't part of that aggregate and are
// reported as 0 for this path.
//
// `user_id` rides along on BOTH paths (the 'regular' one gets it from
// `l.*`). No public response ever serializes it — formatLeaderboardRow
// builds an explicit shape — but the widget's "which row is me" step
// matches on it, and the platform `users.id` IS the topochain `users.id`
// (migration plan Global Constraint #7).
async function fetchEventLeaderboardRows(pool, event) {
  if (event.type === 'regular') {
    const { rows } = await pool.query(EVENT_LEADERBOARD_SQL, [event.id]);
    return rows;
  }

  const seasonId = event.type === 'season' ? Number(event.season_id) : null;
  const standings = await computeStandings(pool, { seasonId });
  return standings.map((s) => ({
    user_id: s.user_id,
    rank: s.rank,
    total_points: s.total_points,
    extra_points: s.extra_points,
    exclude_podium: s.is_non_podium,
    email: s.email,
    telegram: s.telegram,
    discord: s.discord,
    display_name: s.display_name,
    wallet_address: null,
    bech32m: null,
    bug_report_points: 0,
    inviting_new_participant_points: 0,
    community_contribution_points: 0,
    last_epoch_total_produced_blocks: 0,
    event_total_produced_blocks: s.total_produced_blocks,
    vrf_total_won_slots: 0,
    canonical_total_won_slots: 0,
    canonical_total_produced_blocks: 0,
    canonical_won_slots_up_to_current: 0,
    canonical_produced_blocks_up_to_current: 0,
    max_bp_success_rate_up_to_current: 0,
    event_success_rate: 0,
    epoch_success_rate: 0,
    first_block_points: 0,
    produced_half_blocks_points: 0,
    top_3_points: 0,
    success_50_percent_points: 0,
  }));
}

// ─── "Which event should a standings surface open on?" ──────────────────
//
// The server-side twin of `TopochainEvents.pickDefault(events, {
// requireLeaderboard: true })` in public/js/topochain-events.js — KEEP THE
// TWO IN STEP. Same FOUR-step rule, in one round trip:
//
//   1. the season's own `type = 'season'` event, once it has STARTED — a
//      season's standings are the dataset people mean by "the
//      leaderboard"; individual events remain in the picker. Without this
//      step the rule below silently opened on whichever sub-event started
//      LAST, which in production was "Season 1 Beta" (started 48h after
//      the "Season 1" season event) — a three-week slice showing
//      four-figure totals where the season shows five (issue #999).
//   2. the event running right now (temporally, and organiser-enabled);
//   3. otherwise the most recent one that has already STARTED — this is
//      the between-seasons case, and it is production's normal state;
//   4. otherwise the SOONEST upcoming one, rather than nothing at all.
//
// Steps 2-4 are byte-for-byte the original rule, so a season with no
// season-type event (or one that hasn't started) behaves exactly as
// before. The `starts_at <= NOW()` guard on step 1 is what makes that
// true and matters on its own: without it an organiser creating NEXT
// season's wrap-up event in advance would instantly hijack the current
// board with a hero that reads "upcoming".
//
// Scoped like every public standings view: `internal = FALSE` (internal
// events never surface publicly) and `display_leaderboard = TRUE` (an
// event whose standings are switched off renders an empty table, which on
// a board whose whole job is the table reads as a bug).
//
// The two CASE keys give each group its own direction — newest-first among
// started events, soonest-first among upcoming ones — and can't interfere,
// because the `(starts_at <= NOW())` key has already separated the groups.
// They also serve step 1's own group: every member of it has started, so
// the `starts_at DESC` key picks the most recently started season event —
// correct once a Season 2 exists.
const DEFAULT_PUBLIC_EVENT_SQL = `
  SELECT id, name, season_id, type, starts_at, ends_at
    FROM season_events
   WHERE internal = FALSE AND display_leaderboard = TRUE
   ORDER BY (type = 'season' AND starts_at <= NOW()) DESC,
            (is_active = TRUE AND starts_at <= NOW() AND ends_at >= NOW()) DESC,
            (starts_at <= NOW()) DESC,
            CASE WHEN starts_at <= NOW() THEN starts_at END DESC NULLS LAST,
            CASE WHEN starts_at >  NOW() THEN starts_at END ASC  NULLS LAST,
            id DESC
   LIMIT 1
`;

async function resolveDefaultPublicEvent(pool) {
  const { rows } = await pool.query(DEFAULT_PUBLIC_EVENT_SQL);
  return rows[0] || null;
}

// One board row as any compact standings preview wants it: a rank, a
// public display name and a single number. `rank` is null for a
// podium-excluded row (the screen's table renders those as "—").
function boardRow(r) {
  return {
    rank: r.exclude_podium ? null : (Number(r.rank) || null),
    name: resolveDisplayName(r) || 'anonymous',
    // total_points is a Postgres NUMERIC (production values look like
    // 59145.66). One rounded integer is what a one-line preview can show;
    // the full figure stays on the screen's table.
    score: Math.round(num(r.total_points) ?? 0),
  };
}

// The VIEWER-INDEPENDENT board for the default public event:
//
//   { event: { id, name }, top: [row…], total, byUserId: Map<number, row> }
//
// Everything here is identical for every viewer, which is what makes it
// safe to memoise (see home-panels.js's TTL cache); the "which row is me"
// step is the caller's, off `byUserId`. Returns null when there is no
// public event with standings at all — the caller falls back.
//
// Podium-excluded rows are dropped from `top` (they are excluded from
// podium ranking by definition) but kept in `byUserId`, so an excluded
// viewer still sees their own line, rank-less.
async function eventStandingsBoard(pool, { topRows = 3 } = {}) {
  const event = await resolveDefaultPublicEvent(pool);
  if (!event) return null;
  const rows = await fetchEventLeaderboardRows(pool, event);
  if (!Array.isArray(rows) || !rows.length) return null;

  const byUserId = new Map();
  for (const r of rows) {
    if (r.user_id == null) continue;
    const id = Number(r.user_id);
    if (!byUserId.has(id)) byUserId.set(id, boardRow(r));
  }

  return {
    event: { id: Number(event.id), name: event.name },
    top: rows.filter((r) => !r.exclude_podium).slice(0, topRows).map(boardRow),
    total: rows.length,
    byUserId,
  };
}

module.exports = {
  resolveIdentifier,
  maskGeneric,
  maskIdentifier,
  resolveDisplayName,
  EVENT_LEADERBOARD_SQL,
  fetchEventLeaderboardRows,
  DEFAULT_PUBLIC_EVENT_SQL,
  resolveDefaultPublicEvent,
  eventStandingsBoard,
};
