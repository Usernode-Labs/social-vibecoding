// Topochain v4 — mobile surface (SPEC §4.5; token model + throttling at
// SPEC 1588-1599; v2+v3 merged into one token-only surface).
//
// Mounted in server.js BEFORE authMiddleware: mobile clients never hold a
// platform session cookie. Two sub-shapes live in this one router:
//   - Public, throttled auth endpoints (check-email, login, otp/request,
//     otp/verify) — share the ONE `topochainMobileAuthLimiter` bucket
//     (src/middleware/rate-limits.js), 10 req/min/IP (SPEC 1597).
//   - Session-token auth endpoints (set-password, logout, and every data
//     endpoint: me, me/ranking, me/breakdown, event/points, leaderboard,
//     challenges, seasons, terms/*, logs, zkpassport/complete,
//     delegation) — gated by `mobileTokenAuth(config, {ability})`
//     (src/middleware/topochain-auth.js); the user is ALWAYS resolved from
//     the token, never a client-supplied id (constraint #12).
//
// Task 3 built the mount-order probe below. Task 8 composed in the auth
// sub-surface (./mobile-auth.js). Task 9 (this task) adds the five data
// endpoints every mobile client needs on first render: GET /me,
// /me/ranking, /me/breakdown, /event/points, /leaderboard (SPEC 1748-1932;
// 883-895 for the §4.8 contract deltas; 2936-2959 for the standings reuse
// + challenge-progress placeholder ruling). Task 10 will add the rest
// (challenges, seasons, terms, logs, zkpassport, delegation).
//
// ── Rename decisions applied in this file (§4.8 rule 1 + §8.2 map) ──────
//   1. Every mobile `event_id` param/key becomes `season_event_id` — SPEC
//      883 calls this out by name ("the mobile API already speaks in
//      events, but its event_id parameters and keys become season_event_id
//      too"). Applied to GET /event/points's `data.event_id` (SPEC 1884
//      literal) and GET /leaderboard's `event_id` query param (SPEC 1900).
//   2. `participant_total_points` (SPEC 1884) -> `user_total_points`: the
//      §8.2 map lists `participant_id` -> `user_id` and
//      `participant_totals` -> `user_totals`; neither is a literal string
//      match for this key, but it is unambiguously a `participant_*`
//      reference key, so the same rename direction applies here per the
//      task brief's explicit instruction. Its VALUE is documented at the
//      route below (a judgment call: the source computes this identically
//      to `event_total_points`, so v4 keeps them equal rather than
//      inventing a second, undocumented aggregate).
//   3. `sub_category` -> `kind` (§8.2, SPEC 324/379): breakdown's
//      `activity_sub_category` (SPEC 1849) is the OLD serializer's name for
//      a challenge's `sub_category` (now `challenge_templates.kind`)
//      joined onto each activity row — so the JSON key becomes
//      `activity_kind` here, carrying the challenge's `kind` value.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { mobileTokenAuth } = require('../../middleware/topochain-auth');
const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('./helpers');
const { computeStandings, assignSharedRanks } = require('../../services/topochain/standings');
const { topochainMobileAuthRoutes, computeLevel } = require('./mobile-auth');

// ─── Small shared formatters (duplicated in miniature from public.js — ──
// that file doesn't export its identifier/display-name helpers, and these
// are small enough pure functions that re-deriving them locally beats
// wiring a cross-route-module dependency for a handful of one-liners).

// Path/query param -> positive integer id, or null (malformed/absent) —
// same convention as public.js's toIntId: null means "not provided" for
// an optional param.
function toIntId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

// `include_activity` (breakdown) — bool query param, default TRUE (SPEC
// 1826). Only an explicit falsy string turns it off; anything else
// (including garbage) keeps the SPEC default.
function parseBoolDefaultTrue(raw) {
  if (raw === undefined) return true;
  const s = String(raw).trim().toLowerCase();
  return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
}

// Same "real zero, never null" success-rate convention public.js documents
// (judgment call #4 there) — mobile leaderboard's SEASON scope computes
// `success_rate` live from summed won/produced slots (SPEC 1928: "Season
// scope computes success_rate from won/produced slots").
function pctLocal(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function maskGeneric(value) {
  return `${String(value).slice(0, 3)}***`;
}

function resolveIdentifier(user) {
  if (user.email) return { type: 'email', value: user.email };
  if (user.telegram) return { type: 'telegram', value: user.telegram };
  if (user.discord) return { type: 'discord', value: user.discord };
  return { type: null, value: null };
}

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

// discord -> display_name -> masked identifier (SPEC 1859's fallback
// chain for breakdown's `display_name`; also used for leaderboard rows).
function resolveDisplayName(user) {
  if (user.discord) return user.discord;
  if (user.display_name) return user.display_name;
  return maskIdentifier(resolveIdentifier(user));
}

// ─── Terms gate (SPEC 1791/2957: un-gates /me/ranking's total_tokens) ───
//
// "Current published terms" = the terms_versions row with the latest
// published_at (published_at IS NOT NULL). No published version at all ->
// gate open (SPEC 1791's "if no terms version is published the gate is
// open") — modeled here as termsAccepted: true with both other fields
// null, so a caller's `if (!terms_accepted) tokens = 0` short-circuits
// correctly without a special case at every call site.
async function getTermsGate(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, version, terms_link FROM terms_versions
      WHERE published_at IS NOT NULL
      ORDER BY published_at DESC, id DESC LIMIT 1`
  );
  const current = rows[0];
  if (!current) {
    return { termsAccepted: true, termsVersionRequired: null, termsLink: null };
  }
  const { rows: consentRows } = await pool.query(
    'SELECT status FROM user_terms_consents WHERE user_id = $1 AND terms_version_id = $2',
    [userId, current.id]
  );
  const accepted = consentRows.length > 0 && consentRows[0].status === 'accepted';
  return { termsAccepted: accepted, termsVersionRequired: current.version, termsLink: current.terms_link };
}

// ─── Token totals (token_allocation — SPEC 504-526, staging:private) ───
//
// "total_tokens" reads `token_allocation.allocated_tokens` (the amount
// actually allocated TO this user), not `total_season_tokens` (the
// season-wide pool total) — a judgment call, since SPEC's ranking block
// only names the response key, not which token_allocation column backs
// it; `allocated_tokens` is the only per-user token quantity the table
// carries. Querying a user's OWN allocation row is not the kind of bulk
// exposure the table's staging:private classification guards against.
async function sumSeasonTokens(pool, userId, seasonId) {
  const { rows } = await pool.query(
    'SELECT allocated_tokens FROM token_allocation WHERE user_id = $1 AND season_id = $2',
    [userId, seasonId]
  );
  return rows.length ? (num(rows[0].allocated_tokens) ?? 0) : 0;
}

// Global scope: summed across every season the user has an allocation in,
// restricted to public (non-internal) seasons — mirrors the standings
// query's own internal-season exclusion.
async function sumAllTokens(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ta.allocated_tokens), 0) AS total
       FROM token_allocation ta
       JOIN seasons s ON s.id = ta.season_id
      WHERE ta.user_id = $1 AND s.internal = FALSE`,
    [userId]
  );
  return num(rows[0].total) ?? 0;
}

// ─── /me/breakdown building blocks (SPEC 1821-1865) ─────────────────────

async function fetchEventSnapshot(pool, userId, eventId) {
  const { rows } = await pool.query(
    `SELECT rank, total_points, extra_points, first_block_points, top_3_points,
            success_50_percent_points, event_total_produced_blocks,
            vrf_total_won_slots, event_success_rate
       FROM leaderboard_snapshots
      WHERE season_event_id = $1 AND user_id = $2
      ORDER BY snapshot_at DESC, id DESC LIMIT 1`,
    [eventId, userId]
  );
  return rows[0] || null;
}

// `challenge_progress` covers every ENABLED challenge in the event (SPEC
// 1863), zero-filled per the §4.10 placeholder ruling (state "none",
// current null, pending_points 0) — earned_points is the one real field,
// summed from user_activities. `target` reads `challenge_templates
// .metric_target` only (never merged with `challenges.metric_target`) —
// following the same precedent public.js documents for `kind`/`metric_*`/
// friends: those columns exist on `challenges` too but are, by that
// file's own established judgment call, "excluded from the override set
// ... they come straight off the template, never the challenge row".
// `description` DOES merge (challenges row overrides the template, same
// as public.js's OVERRIDE_KEYS list).
async function fetchChallengeProgress(pool, userId, eventId) {
  const { rows: challenges } = await pool.query(
    `SELECT c.id, c.description AS c_description, ct.description AS t_description, ct.metric_target
       FROM challenges c
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE c.season_event_id = $1 AND c.enabled = TRUE
      ORDER BY c.display_order ASC, c.id ASC`,
    [eventId]
  );
  if (!challenges.length) return [];

  const ids = challenges.map((c) => Number(c.id));
  const { rows: earnedRows } = await pool.query(
    `SELECT challenge_id, COALESCE(SUM(points), 0) AS earned
       FROM user_activities
      WHERE user_id = $1 AND challenge_id = ANY($2::bigint[])
      GROUP BY challenge_id`,
    [userId, ids]
  );
  const earnedMap = new Map(earnedRows.map((r) => [Number(r.challenge_id), num(r.earned) ?? 0]));

  return challenges.map((c) => ({
    challenge_id: Number(c.id),
    // §4.10 placeholder ruling (SPEC 2955-2957): nothing populates these
    // three yet — return the literal placeholders, not computed values.
    state: 'none',
    current: null,
    target: num(c.metric_target),
    pending_points: 0,
    earned_points: earnedMap.get(Number(c.id)) || 0,
    description: c.c_description != null ? c.c_description : c.t_description,
  }));
}

// `activities[]` entries (SPEC 1849), only when include_activity. Rename
// #3 above: `activity_sub_category` -> `activity_kind`, sourced from the
// activity's own challenge's template `kind` (INNER JOIN is safe here —
// user_activities.challenge_id CASCADEs with its challenge row, so no
// activity can outlive the challenge it points at).
async function fetchBreakdownActivities(pool, userId, eventId) {
  const { rows } = await pool.query(
    `SELECT ua.id, ua.challenge_id, ua.activity_type, ua.points, ua.description, ua.activity_at,
            ct.kind AS activity_kind
       FROM user_activities ua
       JOIN challenges c ON c.id = ua.challenge_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE ua.user_id = $1 AND ua.season_event_id = $2
      ORDER BY ua.activity_at DESC`,
    [userId, eventId]
  );
  return rows.map((r) => ({
    activity_id: Number(r.id),
    challenge_id: Number(r.challenge_id),
    activity_type: r.activity_type,
    activity_kind: r.activity_kind,
    points: num(r.points) ?? 0,
    description: r.description,
    activity_at: iso(r.activity_at),
  }));
}

// Builds one "event object" (SPEC 1833-1848's event-scope shape), reused
// verbatim as an item of `events[]` (season scope) / `seasons[].events[]`
// (global scope). `omitBonusKeys` drops first_block_points/top_3_points/
// success_50_percent_points entirely — SPEC 1855: global scope's nested
// event objects omit those three, season scope's don't.
//
// v4 zero-fill delta (SPEC 1862): the source only carries total_points/
// extra_points/rank when no snapshot exists for this (user, event); v4
// zero-fills every other key instead of omitting them. `hasSnapshot` is
// returned alongside so the two list-building call sites (season/global)
// can implement the OTHER SPEC 1865 rule — "events/seasons without a
// snapshot are skipped" — by dropping the object rather than including a
// zero-filled placeholder. The single, DIRECT event-scope response (this
// same builder, called once) always keeps its object and zero-fills,
// mirroring /me/ranking's own "no data still 200, zeroed" rule.
async function buildEventBreakdown(pool, userId, event, { includeActivity, omitBonusKeys }) {
  const snap = await fetchEventSnapshot(pool, userId, event.id);

  const obj = {
    event: { id: Number(event.id), name: event.name },
    total_points: snap ? (num(snap.total_points) ?? 0) : 0,
    extra_points: snap ? (num(snap.extra_points) ?? 0) : 0,
    rank: snap ? Number(snap.rank) : null,
  };
  if (!omitBonusKeys) {
    obj.first_block_points = snap ? Number(snap.first_block_points) || 0 : 0;
    obj.top_3_points = snap ? Number(snap.top_3_points) || 0 : 0;
    obj.success_50_percent_points = snap ? Number(snap.success_50_percent_points) || 0 : 0;
  }
  obj.produced_blocks = snap ? Number(snap.event_total_produced_blocks) || 0 : 0;
  obj.vrf_won_slots = snap ? Number(snap.vrf_total_won_slots) || 0 : 0;
  obj.success_rate = snap ? (num(snap.event_success_rate) ?? 0) : 0;
  obj.challenge_progress = await fetchChallengeProgress(pool, userId, event.id);
  if (includeActivity) obj.activities = await fetchBreakdownActivities(pool, userId, event.id);

  return { obj, hasSnapshot: !!snap };
}

// ─── Mobile leaderboard building blocks (SPEC 1895-1932) ────────────────

// Event scope (SPEC 1929: "event scope uses the stored snapshot rank and
// omits events_participated") — the same "latest snapshot per user for
// one event" shape public.js's EVENT_LEADERBOARD_SQL uses, trimmed to the
// columns this endpoint's row shape needs.
async function fetchEventScopeLeaderboard(pool, eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (ls.user_id) ls.user_id, ls.rank, ls.total_points, ls.extra_points,
              ls.event_total_produced_blocks AS total_produced_blocks, ls.vrf_total_won_slots,
              ls.event_success_rate, u.exclude_podium AS is_non_podium, u.email, u.telegram,
              u.discord, u.display_name
         FROM leaderboard_snapshots ls
         JOIN users u ON u.id = ls.user_id
        WHERE ls.season_event_id = $1
        ORDER BY ls.user_id, ls.snapshot_at DESC, ls.id DESC
     ) latest
     ORDER BY latest.rank ASC`,
    [eventId]
  );
  return rows.map((r) => ({
    user_id: Number(r.user_id),
    rank: Number(r.rank),
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    total_produced_blocks: Number(r.total_produced_blocks) || 0,
    vrf_total_won_slots: Number(r.vrf_total_won_slots) || 0,
    event_success_rate: num(r.event_success_rate) ?? 0,
    is_non_podium: !!r.is_non_podium,
    email: r.email,
    telegram: r.telegram,
    discord: r.discord,
    display_name: r.display_name,
  }));
}

// Season scope. This is a SEPARATE aggregate from services/topochain/
// standings.js's shared §4.10 query, not a reuse of it — that query's
// four columns (total_points, extra_points, events_participated,
// total_produced_blocks) don't include `vrf_total_won_slots`, which this
// endpoint's row shape needs to compute `success_rate` (SPEC 1928: "from
// won/produced slots"). It DOES reuse the shared-rank algorithm
// (`assignSharedRanks`, exported by standings.js) rather than
// re-implementing podium-exclusion — only the SQL aggregate itself is
// extended, per the task brief's "reuse standings.js for the global
// scope" (this is the mobile LEADERBOARD's season scope, a different
// endpoint from /me/ranking, hence the separate query).
//
// Code review fix: `se.display_leaderboard = TRUE` is required here, not
// just `se.internal = FALSE` — the `events[]` list on this same endpoint
// (built a few lines below in the router) already filters
// `display_leaderboard = TRUE`, and a hidden event's points/blocks/slots
// must not silently leak into the season-wide totals of an event that
// isn't shown anywhere. Without this, an event an operator hid from the
// leaderboard mid-event would still move every user's season rank.
const SEASON_LEADERBOARD_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (ls.season_event_id, ls.user_id)
           ls.user_id, ls.season_event_id, ls.total_points, ls.extra_points,
           ls.event_total_produced_blocks, ls.vrf_total_won_slots
      FROM leaderboard_snapshots ls
      JOIN season_events se ON se.id = ls.season_event_id
     WHERE se.internal = FALSE AND se.display_leaderboard = TRUE AND se.season_id = $1
     ORDER BY ls.season_event_id, ls.user_id, ls.snapshot_at DESC, ls.id DESC
  )
  SELECT l.user_id,
         SUM(l.total_points) AS total_points,
         SUM(l.extra_points) AS extra_points,
         COUNT(DISTINCT l.season_event_id) AS events_participated,
         SUM(l.event_total_produced_blocks) AS total_produced_blocks,
         SUM(l.vrf_total_won_slots) AS vrf_total_won_slots,
         u.exclude_podium AS is_non_podium, u.email, u.telegram, u.discord, u.display_name
    FROM latest l
    JOIN users u ON u.id = l.user_id
   GROUP BY l.user_id, u.exclude_podium, u.email, u.telegram, u.discord, u.display_name
   ORDER BY SUM(l.total_points) DESC, l.user_id ASC
`;

async function fetchSeasonScopeLeaderboard(pool, seasonId) {
  const { rows } = await pool.query(SEASON_LEADERBOARD_SQL, [seasonId]);
  const cast = rows.map((r) => ({
    user_id: Number(r.user_id),
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    events_participated: Number(r.events_participated) || 0,
    total_produced_blocks: Number(r.total_produced_blocks) || 0,
    vrf_total_won_slots: Number(r.vrf_total_won_slots) || 0,
    is_non_podium: !!r.is_non_podium,
    email: r.email,
    telegram: r.telegram,
    discord: r.discord,
    display_name: r.display_name,
  }));
  return assignSharedRanks(cast);
}

// SPEC 1917 row shape, minus the SEASON-only `events_participated` key
// (event scope omits it entirely — SPEC 1929).
function formatMobileLeaderboardRow(r, isSeasonScope) {
  const row = {
    rank: r.rank == null ? null : Number(r.rank),
    total_points: r.total_points,
    extra_points: r.extra_points,
  };
  if (isSeasonScope) row.events_participated = r.events_participated;
  row.total_produced_blocks = r.total_produced_blocks;
  row.vrf_total_won_slots = r.vrf_total_won_slots;
  row.success_rate = isSeasonScope ? pctLocal(r.total_produced_blocks, r.vrf_total_won_slots) : r.event_success_rate;
  row.user_id = r.user_id;
  row.is_non_podium = r.is_non_podium;
  row.display_name = resolveDisplayName(r);
  return row;
}

// ─── Router ───────────────────────────────────────────────────────────

function topochainMobileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Mount-order probe (plan Task 3). Deliberately NOT gated by
  // mobileTokenAuth — it exists only to prove this router sits ahead of
  // authMiddleware; the real per-route auth lives on each endpoint below.
  router.get('/api/v4/mobile/__ping', (_req, res) => ok(res, {}));

  // Task 8: the six auth endpoints (their own throttle/token gating).
  router.use(topochainMobileAuthRoutes(config));

  // ── GET /me (SPEC 1748-1767) ─────────────────────────────────────────
  router.get('/api/v4/mobile/me', mobileTokenAuth(config), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, email, display_name, email_confirmed, is_in_waitlist, github, x, password_set
           FROM users WHERE id = $1`,
        [req.user.id]
      );
      const user = rows[0];
      // The token resolved to a real row a moment ago (mobileTokenAuth's
      // own JOIN would have failed otherwise) — a row missing here would
      // mean the user was deleted between that lookup and this one; fail
      // closed as the same 401 a dead token gets, rather than a 500.
      if (!user) return fail(res, 401, 'Unauthenticated.');

      const level = await computeLevel(pool, user.id, !!user.password_set);
      return ok(res, {
        data: {
          id: Number(user.id),
          email: user.email,
          display_name: user.display_name,
          email_confirmed: !!user.email_confirmed,
          is_in_waitlist: !!user.is_in_waitlist,
          github: user.github,
          x: user.x,
          level,
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'GET /me failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /me/ranking (SPEC 1769-1820) ─────────────────────────────────
  // Scope resolution: season_event_id > season_id > neither (global) —
  // SPEC 1774's "takes precedence over season_id".
  router.get('/api/v4/mobile/me/ranking', mobileTokenAuth(config), async (req, res) => {
    try {
      // `req.user.id` comes off `mobile_auth_tokens.user_id` (BIGINT) —
      // node-postgres returns BIGINT columns as STRINGS (no custom type
      // parser is configured in src/db/pool.js), while computeStandings()
      // below Number()-casts its own `user_id` column. Casting once here
      // keeps every later `===` comparison (`standings.find(...)`)
      // correct against a real database, not just this file's mock-pool
      // tests (whose fixtures happen to store ids as JS numbers already).
      const userId = Number(req.user.id);
      const seasonEventId = toIntId(req.query.season_event_id);
      const seasonIdParam = toIntId(req.query.season_id);
      const termsGate = await getTermsGate(pool, userId);
      const termsFields = {
        terms_accepted: termsGate.termsAccepted,
        terms_version_required: termsGate.termsVersionRequired,
        terms_link: termsGate.termsLink,
      };

      if (seasonEventId) {
        const { rows } = await pool.query(
          'SELECT id, name, internal, display_leaderboard FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        const event = rows[0];
        if (!event) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        if (event.internal || !event.display_leaderboard) {
          return fail(res, 404, 'Event not found or has no leaderboard.');
        }

        const snap = await fetchEventSnapshot(pool, userId, event.id);
        const { rows: countRows } = await pool.query(
          'SELECT COUNT(DISTINCT user_id)::int AS c FROM leaderboard_snapshots WHERE season_event_id = $1',
          [event.id]
        );

        const data = {
          scope: 'event',
          season_event_id: Number(event.id),
          event_name: event.name,
          rank: snap ? Number(snap.rank) : null,
          total_points: snap ? (num(snap.total_points) ?? 0) : 0,
          // SPEC 1783: hardcoded 0 in event scope, regardless of the
          // terms gate (the gate would force it to 0 anyway).
          total_tokens: 0,
          total_participants: countRows[0].c,
          ...termsFields,
        };
        // SPEC 1784: omitted entirely (not zero) when no snapshot exists.
        if (snap) data.extra_points = num(snap.extra_points) ?? 0;
        return ok(res, { data });
      }

      if (seasonIdParam) {
        const { rows } = await pool.query('SELECT id, name, internal FROM seasons WHERE id = $1', [seasonIdParam]);
        const season = rows[0];
        if (!season) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_id: ['The selected season_id is invalid.'] },
          });
        }
        if (season.internal) return fail(res, 404, 'Season not found.');

        // Season scope reuses the shared §4.10 aggregate too (not just
        // global) — computeStandings already accepts a seasonId filter,
        // so there's no separate query to write; SPEC's "three
        // consumers" list for this aggregate doesn't name this exact
        // call site, but it's the identical shape with a season filter.
        const standings = await computeStandings(pool, { seasonId: season.id });
        const own = standings.find((s) => s.user_id === userId) || null;
        const totalTokens = termsGate.termsAccepted ? await sumSeasonTokens(pool, userId, season.id) : 0;

        return ok(res, {
          data: {
            scope: 'season',
            season_id: Number(season.id),
            season_name: season.name,
            rank: own ? own.rank : null,
            total_points: own ? own.total_points : 0,
            total_tokens: totalTokens,
            extra_points: own ? own.extra_points : 0,
            total_participants: standings.length,
            ...termsFields,
          },
        });
      }

      // Global scope (SPEC 1798-1805; §4.10's third listed consumer).
      const standings = await computeStandings(pool, { seasonId: null });
      const own = standings.find((s) => s.user_id === userId) || null;
      const totalTokens = termsGate.termsAccepted ? await sumAllTokens(pool, userId) : 0;

      return ok(res, {
        data: {
          scope: 'global',
          rank: own ? own.rank : null,
          total_points: own ? own.total_points : 0,
          total_tokens: totalTokens,
          events_participated: own ? own.events_participated : 0,
          total_produced_blocks: own ? own.total_produced_blocks : 0,
          total_participants: standings.length,
          ...termsFields,
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'GET /me/ranking failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /me/breakdown (SPEC 1821-1865) ───────────────────────────────
  router.get('/api/v4/mobile/me/breakdown', mobileTokenAuth(config), async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      const seasonIdParam = toIntId(req.query.season_id);
      const includeActivity = parseBoolDefaultTrue(req.query.include_activity);

      const { rows: userRows } = await pool.query(
        'SELECT discord, display_name, email, telegram FROM users WHERE id = $1',
        [req.user.id]
      );
      const displayName = resolveDisplayName(userRows[0] || {});

      if (seasonEventId) {
        const { rows } = await pool.query(
          'SELECT id, name, internal, display_leaderboard FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        const event = rows[0];
        if (!event) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        if (event.internal || !event.display_leaderboard) {
          return fail(res, 404, 'Event not found or has no leaderboard.');
        }

        const { obj } = await buildEventBreakdown(pool, req.user.id, event, {
          includeActivity, omitBonusKeys: false,
        });
        return ok(res, { data: { display_name: displayName, scope: 'event', ...obj } });
      }

      if (seasonIdParam) {
        const { rows } = await pool.query('SELECT id, name, internal FROM seasons WHERE id = $1', [seasonIdParam]);
        const season = rows[0];
        if (!season) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_id: ['The selected season_id is invalid.'] },
          });
        }
        if (season.internal) return fail(res, 404, 'Season not found.');

        const { rows: eventRows } = await pool.query(
          'SELECT id, name FROM season_events WHERE season_id = $1 AND internal = FALSE ORDER BY starts_at ASC',
          [season.id]
        );
        const events = [];
        for (const eventRow of eventRows) {
          // eslint-disable-next-line no-await-in-loop -- small per-user
          // fixture-scale lists; sequential keeps the query count obvious.
          const { obj, hasSnapshot } = await buildEventBreakdown(pool, req.user.id, eventRow, {
            includeActivity, omitBonusKeys: false,
          });
          // SPEC 1865: events without a snapshot are skipped, not
          // returned zero-filled (that zero-fill only applies to the
          // single direct event-scope response above).
          if (hasSnapshot) events.push(obj);
        }
        return ok(res, { data: { display_name: displayName, scope: 'season', events } });
      }

      // Global scope: seasons[].events[], events omit the three bonus
      // keys (SPEC 1855), seasons with no in-scope events are skipped
      // (SPEC 1865, extended to the season level).
      const { rows: seasonRows } = await pool.query(
        'SELECT id, name FROM seasons WHERE internal = FALSE ORDER BY display_order ASC, starts_at DESC'
      );
      const seasons = [];
      for (const seasonRow of seasonRows) {
        // eslint-disable-next-line no-await-in-loop
        const { rows: eventRows } = await pool.query(
          'SELECT id, name FROM season_events WHERE season_id = $1 AND internal = FALSE ORDER BY starts_at ASC',
          [seasonRow.id]
        );
        const events = [];
        for (const eventRow of eventRows) {
          // eslint-disable-next-line no-await-in-loop
          const { obj, hasSnapshot } = await buildEventBreakdown(pool, req.user.id, eventRow, {
            includeActivity, omitBonusKeys: true,
          });
          if (hasSnapshot) events.push(obj);
        }
        if (events.length) seasons.push({ id: Number(seasonRow.id), name: seasonRow.name, events });
      }
      return ok(res, { data: { display_name: displayName, scope: 'global', seasons } });
    } catch (err) {
      log.error('topochain-mobile', 'GET /me/breakdown failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /event/points (SPEC 1867-1893) ───────────────────────────────
  // Rename #1: `event_id` -> `season_event_id`. Rename #2:
  // `participant_total_points` -> `user_total_points` (value documented
  // at the field below). SPEC 1893: v4 paginates `total_points_per_user`
  // (unpaginated + unfiltered in the source, flagged as a data-exposure
  // note) via the shared page/per_page + `meta` envelope.
  router.get('/api/v4/mobile/event/points', mobileTokenAuth(config), async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      if (!seasonEventId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The season_event_id field is required.'] },
        });
      }

      const { rows } = await pool.query('SELECT id, name, internal FROM season_events WHERE id = $1', [seasonEventId]);
      const event = rows[0];
      if (!event) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }
      if (event.internal) return fail(res, 404, 'Event not found.');

      const { page, perPage } = paginate(req); // may throw ValidationError (422)

      const { rows: latestRows } = await pool.query(
        `SELECT DISTINCT ON (user_id) user_id, total_points
           FROM leaderboard_snapshots
          WHERE season_event_id = $1
          ORDER BY user_id, snapshot_at DESC, id DESC`,
        [seasonEventId]
      );
      const sorted = latestRows
        .map((r) => ({ user_id: Number(r.user_id), total_points: num(r.total_points) ?? 0 }))
        .sort((a, b) => b.total_points - a.total_points || a.user_id - b.user_id);

      const eventTotalPoints = sorted.reduce((acc, r) => acc + r.total_points, 0);
      const start = (page - 1) * perPage;
      const totalPointsPerUser = sorted.slice(start, start + perPage);

      return ok(res, {
        data: {
          season_event_id: Number(event.id),
          event_name: event.name,
          event_total_points: eventTotalPoints,
          // Rename #2 judgment call: the source computes this identically
          // to event_total_points (both are "sum of every participant's
          // total_points for the event") — kept equal rather than
          // inventing a second, undocumented aggregate.
          user_total_points: eventTotalPoints,
          total_points_per_user: totalPointsPerUser,
          total_participants: sorted.length,
        },
      }, { meta: meta(page, perPage, sorted.length) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-mobile', 'GET /event/points failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /leaderboard (SPEC 1895-1932) ────────────────────────────────
  // Rename #1: `event_id` -> `season_event_id`.
  router.get('/api/v4/mobile/leaderboard', mobileTokenAuth(config), async (req, res) => {
    try {
      const seasonId = toIntId(req.query.season_id);
      if (!seasonId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_id: ['The season_id field is required.'] },
        });
      }

      const { rows } = await pool.query('SELECT id, name, internal FROM seasons WHERE id = $1', [seasonId]);
      const season = rows[0];
      if (!season) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_id: ['The selected season_id is invalid.'] },
        });
      }
      if (season.internal) return fail(res, 404, 'Season not found.');

      const seasonEventId = toIntId(req.query.season_event_id);
      let event = null;
      if (seasonEventId) {
        const { rows: evRows } = await pool.query(
          'SELECT id, name, season_id, internal FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        event = evRows[0];
        // Judgment call: an id that doesn't exist, OR exists but belongs
        // to a different season, is treated the same as an unknown id
        // (422) — the request is asking for an event that isn't "this
        // season's". An existing, same-season but internal event 404s
        // like every other internal-event lookup in this migration.
        if (!event || Number(event.season_id) !== Number(season.id)) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        if (event.internal) return fail(res, 404, 'Event not found.');
      }

      const { page, perPage } = paginate(req, { defaultPerPage: 50 }); // may throw ValidationError

      // SPEC 1931-1932: only public events with a leaderboard; the
      // season-type wrap-up event is renamed "<Season name> Global
      // Challenges".
      const { rows: eventRows } = await pool.query(
        `SELECT id, name, type, starts_at, ends_at, is_active
           FROM season_events
          WHERE season_id = $1 AND internal = FALSE AND display_leaderboard = TRUE
          ORDER BY starts_at DESC`,
        [season.id]
      );
      const events = eventRows.map((r) => ({
        id: Number(r.id),
        name: r.type === 'season' ? `${season.name} Global Challenges` : r.name,
        type: r.type,
        starts_at: iso(r.starts_at),
        ends_at: iso(r.ends_at),
        is_active: r.is_active,
      }));

      const isSeasonScope = !event;
      const scopedRows = isSeasonScope
        ? await fetchSeasonScopeLeaderboard(pool, season.id)
        : await fetchEventScopeLeaderboard(pool, event.id);

      const total = scopedRows.length;
      const start = (page - 1) * perPage;
      const leaderboard = scopedRows.slice(start, start + perPage).map((r) => formatMobileLeaderboardRow(r, isSeasonScope));

      return ok(res, {
        data: {
          season: { id: Number(season.id), name: season.name },
          events,
          leaderboard,
          // SPEC's own example nests pagination under `data`, distinct
          // from the shared top-level `meta` envelope every other
          // paginated v4 endpoint uses — "specification wins" (Global
          // Constraints), so this one key is deliberately not `meta`.
          pagination: meta(page, perPage, total),
        },
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-mobile', 'GET /leaderboard failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { topochainMobileRoutes };
