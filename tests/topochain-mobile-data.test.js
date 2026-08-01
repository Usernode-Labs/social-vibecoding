// Topochain v4 mobile data endpoints (plan Task 9; SPEC §4.5 lines
// 1748-1932 for the five endpoint contracts, 883-895 for the §4.8
// contract deltas, 2936-2959 for the standings reuse + challenge-progress
// placeholder ruling).
//
// HTTP-level tests against a throwaway express app + a substring-
// dispatching mock pool (same idiom as tests/topochain-public-api.test.js
// and tests/board-order.test.js) — no live DB. Auth goes through the REAL
// mobileTokenAuth middleware (src/middleware/topochain-auth.js) against a
// seeded `mobile_auth_tokens` fixture, so every request below carries a
// real `Authorization: Bearer <token>` header rather than faking req.user.
//
// Run with: node --test tests/topochain-mobile-data.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// ─── Fixture data ─────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// alice: no discord/display_name -> falls back to masked email.
// bob: has a discord handle -> display_name resolves to it directly.
// carol: podium-excluded (exclude_podium), used to exercise the
// shared-rank rule (SPEC 959) in the mobile leaderboard's season scope.
const USERS = [
  {
    id: 1, email: 'alice@example.com', telegram: null, discord: null, display_name: null,
    github: 'alicegh', x: 'aliceX', is_in_waitlist: false, email_confirmed: true,
    password_set: true, exclude_podium: false,
  },
  {
    id: 2, email: 'bob@example.com', telegram: null, discord: 'bobdiscord', display_name: null,
    github: null, x: null, is_in_waitlist: false, email_confirmed: true,
    password_set: true, exclude_podium: false,
  },
  {
    id: 3, email: 'carol@example.com', telegram: null, discord: null, display_name: 'Carol D',
    github: null, x: null, is_in_waitlist: false, email_confirmed: true,
    password_set: true, exclude_podium: true,
  },
  // dave: a real user with NO leaderboard_snapshots/token_allocation/terms
  // consent rows at all anywhere — the genuine "no data" fixture used to
  // exercise /me/ranking's "still 200, rank null, zeroed totals" rule.
  {
    id: 4, email: 'dave@example.com', telegram: null, discord: null, display_name: null,
    github: null, x: null, is_in_waitlist: false, email_confirmed: true,
    password_set: true, exclude_podium: false,
  },
  // erin: exists ONLY to hold a snapshot in a display_leaderboard=false
  // event (301, below) — proves that a hidden event's real points don't
  // leak into the mobile leaderboard's season-scope totals (code review
  // fix). Deliberately given a SMALL point value (1) so she sorts last
  // and doesn't perturb alice/bob/carol's ranks in the OTHER standings-
  // based tests that share this fixture set (see the comment on season
  // 30 below for why she still shows up in /me/ranking's global scope).
  {
    id: 5, email: 'erin@example.com', telegram: null, discord: null, display_name: null,
    github: null, x: null, is_in_waitlist: false, email_confirmed: true,
    password_set: true, exclude_podium: false,
  },
];

const SEASONS = [
  { id: 10, name: 'Season Alpha', internal: false, display_order: 0 },
  { id: 20, name: 'Hidden Season', internal: true, display_order: 1 },
  // A separate, public season whose ONLY event is display_leaderboard =
  // false — isolated from season 10 so this fixture can't perturb any of
  // the season-10-scoped assertions elsewhere in this file. It's still
  // public (internal: false), so /me/ranking's GLOBAL scope (which has no
  // display_leaderboard filter — services/topochain/standings.js's shared
  // aggregate never had one, and that's explicitly out of scope for this
  // fix) still picks up erin's event-301 snapshot; only the two global-
  // scope total_participants assertions below account for her (3 -> 4).
  { id: 30, name: 'Season Beta', internal: false, display_order: 2 },
];

const SEASON_EVENTS = [
  {
    id: 100, name: 'Sprint One', internal: false, display_leaderboard: true, type: 'regular',
    season_id: 10, starts_at: T(-10), ends_at: T(10), is_active: true,
  },
  {
    id: 101, name: 'Hidden Leaderboard Event', internal: false, display_leaderboard: false, type: 'regular',
    season_id: 10, starts_at: T(-20), ends_at: T(-10), is_active: true,
  },
  {
    id: 102, name: 'Internal Event', internal: true, display_leaderboard: true, type: 'regular',
    season_id: 10, starts_at: T(-2), ends_at: T(2), is_active: true,
  },
  {
    id: 103, name: 'Wrap-up raw name', internal: false, display_leaderboard: true, type: 'season',
    season_id: 10, starts_at: T(20), ends_at: T(30), is_active: true,
  },
  {
    id: 105, name: 'No Data Event', internal: false, display_leaderboard: true, type: 'regular',
    season_id: 10, starts_at: T(-5), ends_at: T(5), is_active: true,
  },
  // Season 30's only event: public (internal: false) but hidden from the
  // leaderboard (display_leaderboard: false) — AND it has a real snapshot
  // (below), unlike event 101 above which has none. This is the exact
  // shape the code review flagged as untested.
  {
    id: 301, name: 'Beta Hidden', internal: false, display_leaderboard: false, type: 'regular',
    season_id: 30, starts_at: T(-10), ends_at: T(10), is_active: true,
  },
];

// Only event 100 has any snapshots — events 101 (hidden), 102 (internal),
// 103 (season wrap, used only for the leaderboard rename check) and 105
// (no data) all have none, exercising the "skipped"/"zero-filled" rules.
//
// Numbers are chosen so success_rate = produced/won*100 comes out clean,
// and so carol (excluded) sits BETWEEN alice and bob in total_points —
// that ordering is what makes the shared-rank rule (SPEC 959) visible:
// season-scope ranks come out 1, 2, 2 (carol and bob share rank 2) while
// event-scope's STORED ranks are 1, 2, 3.
const LEADERBOARD_SNAPSHOTS = [
  {
    id: 1, season_event_id: 100, user_id: 1, rank: 1, total_points: '200.00', extra_points: '10.00',
    snapshot_at: T(-1), first_block_points: 5, top_3_points: 10, success_50_percent_points: 15,
    event_total_produced_blocks: 20, vrf_total_won_slots: 40, event_success_rate: '50.00',
  },
  {
    id: 2, season_event_id: 100, user_id: 3, rank: 2, total_points: '150.00', extra_points: '0.00',
    snapshot_at: T(-1), first_block_points: 0, top_3_points: 0, success_50_percent_points: 0,
    event_total_produced_blocks: 10, vrf_total_won_slots: 30, event_success_rate: '33.33',
  },
  {
    id: 3, season_event_id: 100, user_id: 2, rank: 3, total_points: '100.00', extra_points: '5.00',
    snapshot_at: T(-1), first_block_points: 0, top_3_points: 0, success_50_percent_points: 0,
    event_total_produced_blocks: 10, vrf_total_won_slots: 20, event_success_rate: '50.00',
  },
  // erin's snapshot in the HIDDEN event 301 — real points (1) that must
  // NOT surface in the mobile leaderboard's season-scope totals for
  // season 30 (code review fix: SEASON_LEADERBOARD_SQL must filter
  // display_leaderboard = TRUE, matching the events[] list on the same
  // endpoint, not just internal = FALSE).
  {
    id: 6, season_event_id: 301, user_id: 5, rank: 1, total_points: '1.00', extra_points: '0.00',
    snapshot_at: T(-1), first_block_points: 0, top_3_points: 0, success_50_percent_points: 0,
    event_total_produced_blocks: 1, vrf_total_won_slots: 2, event_success_rate: '50.00',
  },
];

const TOKEN_ALLOCATION = [
  { user_id: 1, season_id: 10, allocated_tokens: '500.00000000' },
  { user_id: 2, season_id: 10, allocated_tokens: '300.00000000' },
];

// One published terms version; alice has accepted it, bob has not (no
// consent row at all) — drives the terms-gate tests.
const TERMS_VERSIONS = [
  { id: 1, version: 'v1', terms_link: 'https://example.com/terms/v1', published_at: T(-30) },
];
const USER_TERMS_CONSENTS = [
  { user_id: 1, terms_version_id: 1, status: 'accepted' },
];

const CHALLENGE_TEMPLATES = [
  { id: 10, description: 'Report a bug (template)', metric_target: '5.0000', kind: 'REPORT_BUG' },
  { id: 11, description: 'Disabled challenge (template)', metric_target: null, kind: 'OTHER' },
];
const CHALLENGES = [
  { id: 1, season_event_id: 100, challenge_template_id: 10, enabled: true, description: null, display_order: 1 },
  { id: 2, season_event_id: 100, challenge_template_id: 11, enabled: false, description: null, display_order: 2 },
];
const USER_ACTIVITIES = [
  {
    id: 1, user_id: 1, season_event_id: 100, challenge_id: 1, activity_type: 'bug_report',
    points: '20.00', description: 'Found an XSS', activity_at: T(-2),
  },
];

// ─── Mock pool: SQL shape -> in-memory computation ──────────────────────

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const TOKENS = [
  { id: 1, user_id: 1, token_hash: hashToken('alice-token'), ability: 'session', expires_at: T(1) },
  { id: 2, user_id: 2, token_hash: hashToken('bob-token'), ability: 'session', expires_at: T(1) },
  { id: 3, user_id: 3, token_hash: hashToken('carol-token'), ability: 'session', expires_at: T(1) },
  { id: 4, user_id: 4, token_hash: hashToken('dave-token'), ability: 'session', expires_at: T(1) },
];

function latestPerUserForEvent(eventId) {
  const byUser = new Map();
  for (const s of LEADERBOARD_SNAPSHOTS) {
    if (s.season_event_id !== eventId) continue;
    const cur = byUser.get(s.user_id);
    if (!cur || s.snapshot_at > cur.snapshot_at || (s.snapshot_at.getTime() === cur.snapshot_at.getTime() && s.id > cur.id)) {
      byUser.set(s.user_id, s);
    }
  }
  return [...byUser.values()];
}

// Mirrors services/topochain/standings.js's STANDINGS_SQL (the §4.10
// shared aggregate) over the fixtures above — used for /me/ranking's
// season and global scopes.
function computeStandingsRows(seasonId) {
  const events = SEASON_EVENTS.filter((e) => !e.internal && (seasonId == null || e.season_id === seasonId));
  const byUser = new Map();
  for (const e of events) {
    for (const s of latestPerUserForEvent(e.id)) {
      const acc = byUser.get(s.user_id) || {
        user_id: s.user_id, total_points: 0, extra_points: 0, events: new Set(), total_produced_blocks: 0,
      };
      acc.total_points += Number(s.total_points);
      acc.extra_points += Number(s.extra_points);
      acc.events.add(s.season_event_id);
      acc.total_produced_blocks += Number(s.event_total_produced_blocks) || 0;
      byUser.set(s.user_id, acc);
    }
  }
  const rows = [...byUser.values()].map((acc) => {
    const user = USERS.find((u) => u.id === acc.user_id);
    return {
      user_id: acc.user_id,
      total_points: acc.total_points.toFixed(2),
      extra_points: acc.extra_points.toFixed(2),
      events_participated: acc.events.size,
      total_produced_blocks: acc.total_produced_blocks,
      total_produced_blocks_last_event: acc.total_produced_blocks,
      is_non_podium: user.exclude_podium,
      email: user.email, telegram: user.telegram, discord: user.discord, display_name: user.display_name,
    };
  });
  rows.sort((a, b) => Number(b.total_points) - Number(a.total_points) || a.user_id - b.user_id);
  return rows;
}

// Mirrors mobile.js's own SEASON_LEADERBOARD_SQL (the extended aggregate
// that also sums vrf_total_won_slots) — used by the mobile GET
// /leaderboard endpoint's season scope.
function computeSeasonLeaderboardRows(seasonId) {
  // Code review fix mirrored here: display_leaderboard = false events are
  // excluded from the season-scope aggregate, same as SEASON_LEADERBOARD_SQL
  // in mobile.js now requires (previously only `!e.internal` was checked).
  const events = SEASON_EVENTS.filter((e) => !e.internal && e.display_leaderboard && e.season_id === seasonId);
  const byUser = new Map();
  for (const e of events) {
    for (const s of latestPerUserForEvent(e.id)) {
      const acc = byUser.get(s.user_id) || {
        user_id: s.user_id, total_points: 0, extra_points: 0, events: new Set(),
        total_produced_blocks: 0, vrf_total_won_slots: 0,
      };
      acc.total_points += Number(s.total_points);
      acc.extra_points += Number(s.extra_points);
      acc.events.add(s.season_event_id);
      acc.total_produced_blocks += Number(s.event_total_produced_blocks) || 0;
      acc.vrf_total_won_slots += Number(s.vrf_total_won_slots) || 0;
      byUser.set(s.user_id, acc);
    }
  }
  const rows = [...byUser.values()].map((acc) => {
    const user = USERS.find((u) => u.id === acc.user_id);
    return {
      user_id: acc.user_id,
      total_points: acc.total_points.toFixed(2),
      extra_points: acc.extra_points.toFixed(2),
      events_participated: acc.events.size,
      total_produced_blocks: acc.total_produced_blocks,
      vrf_total_won_slots: acc.vrf_total_won_slots,
      is_non_podium: user.exclude_podium,
      email: user.email, telegram: user.telegram, discord: user.discord, display_name: user.display_name,
    };
  });
  rows.sort((a, b) => Number(b.total_points) - Number(a.total_points) || a.user_id - b.user_id);
  return rows;
}

function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    // ── mobileTokenAuth's own lookup + bookkeeping bump ────────────────
    if (sql.startsWith('SELECT t.id, t.user_id, t.ability, t.expires_at, u.username FROM mobile_auth_tokens')) {
      const tok = TOKENS.find((t) => t.token_hash === params[0]);
      if (!tok) return { rows: [] };
      const user = USERS.find((u) => u.id === tok.user_id);
      return { rows: [{ id: tok.id, user_id: tok.user_id, ability: tok.ability, expires_at: tok.expires_at, username: user ? user.email : null }] };
    }
    if (sql.startsWith('UPDATE mobile_auth_tokens SET last_used_at')) return { rows: [] };

    // ── GET /me ─────────────────────────────────────────────────────────
    if (sql.includes('is_in_waitlist, github, x, password_set')) {
      const u = USERS.find((x) => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (sql.startsWith('SELECT 1 FROM onchain_accounts')) return { rows: [] }; // nobody is an operator in this fixture set

    // ── Terms gate ──────────────────────────────────────────────────────
    if (sql.includes('FROM terms_versions WHERE published_at IS NOT NULL')) {
      const sorted = [...TERMS_VERSIONS].sort((a, b) => b.published_at - a.published_at || b.id - a.id);
      return { rows: sorted.slice(0, 1) };
    }
    if (sql.includes('FROM user_terms_consents WHERE user_id')) {
      const row = USER_TERMS_CONSENTS.find((c) => c.user_id === params[0] && c.terms_version_id === params[1]);
      return { rows: row ? [{ status: row.status }] : [] };
    }

    // ── season_events single-row lookups (three distinct column lists) ──
    if (sql.includes('SELECT id, name, internal, display_leaderboard FROM season_events WHERE id = $1')) {
      const e = SEASON_EVENTS.find((x) => x.id === params[0]);
      return { rows: e ? [e] : [] };
    }
    if (sql.includes('SELECT id, name, season_id, internal FROM season_events WHERE id = $1')) {
      const e = SEASON_EVENTS.find((x) => x.id === params[0]);
      return { rows: e ? [e] : [] };
    }
    if (sql.includes('SELECT id, name, internal FROM season_events WHERE id = $1')) {
      const e = SEASON_EVENTS.find((x) => x.id === params[0]);
      return { rows: e ? [e] : [] };
    }

    // ── seasons single-row lookup (shared by /me/ranking, /me/breakdown, /leaderboard) ──
    if (sql.includes('SELECT id, name, internal FROM seasons WHERE id = $1')) {
      const s = SEASONS.find((x) => x.id === params[0]);
      return { rows: s ? [s] : [] };
    }

    // ── /me/ranking + /me/breakdown: single-event snapshot ──────────────
    if (sql.includes('vrf_total_won_slots, event_success_rate FROM leaderboard_snapshots')) {
      const [eventId, userId] = params;
      const snap = latestPerUserForEvent(eventId).find((s) => s.user_id === userId) || null;
      return { rows: snap ? [snap] : [] };
    }
    // ── /me/ranking: event-scope participant count ──────────────────────
    if (sql.includes('COUNT(DISTINCT user_id)::int AS c FROM leaderboard_snapshots')) {
      const count = latestPerUserForEvent(params[0]).length;
      return { rows: [{ c: count }] };
    }

    // ── standings.js's shared §4.10 aggregate (STANDINGS_SQL) ───────────
    if (sql.includes('last_event AS')) {
      return { rows: computeStandingsRows(params[0] ?? null) };
    }

    // ── token_allocation ─────────────────────────────────────────────────
    if (sql.includes('SELECT allocated_tokens FROM token_allocation')) {
      const [userId, seasonId] = params;
      const row = TOKEN_ALLOCATION.find((t) => t.user_id === userId && t.season_id === seasonId);
      return { rows: row ? [{ allocated_tokens: row.allocated_tokens }] : [] };
    }
    if (sql.includes('FROM token_allocation ta')) {
      const userId = params[0];
      const total = TOKEN_ALLOCATION
        .filter((t) => t.user_id === userId && SEASONS.find((s) => s.id === t.season_id && !s.internal))
        .reduce((acc, t) => acc + Number(t.allocated_tokens), 0);
      return { rows: [{ total: total.toFixed(8) }] };
    }

    // ── /me/breakdown: user identity for display_name ───────────────────
    if (sql.includes('SELECT discord, display_name, email, telegram FROM users WHERE id = $1')) {
      const u = USERS.find((x) => x.id === params[0]);
      return { rows: u ? [{ discord: u.discord, display_name: u.display_name, email: u.email, telegram: u.telegram }] : [] };
    }

    // ── /me/breakdown: challenge_progress (challenges+templates) ───────
    if (sql.includes('ct.metric_target FROM challenges c')) {
      const eventId = params[0];
      const rows = CHALLENGES
        .filter((c) => c.season_event_id === eventId && c.enabled)
        .sort((a, b) => a.display_order - b.display_order || a.id - b.id)
        .map((c) => {
          const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
          return {
            id: c.id, c_description: c.description, t_description: t.description, metric_target: t.metric_target,
          };
        });
      return { rows };
    }
    // ── /me/breakdown: earned_points sum ────────────────────────────────
    if (sql.includes('COALESCE(SUM(points), 0) AS earned')) {
      const [userId, challengeIds] = params;
      const byChallenge = new Map();
      for (const a of USER_ACTIVITIES) {
        if (a.user_id !== userId || !challengeIds.includes(a.challenge_id)) continue;
        byChallenge.set(a.challenge_id, (byChallenge.get(a.challenge_id) || 0) + Number(a.points));
      }
      return { rows: [...byChallenge.entries()].map(([challenge_id, earned]) => ({ challenge_id, earned: earned.toFixed(2) })) };
    }
    // ── /me/breakdown: activities list ──────────────────────────────────
    if (sql.includes('ct.kind AS activity_kind')) {
      const [userId, eventId] = params;
      const rows = USER_ACTIVITIES
        .filter((a) => a.user_id === userId && a.season_event_id === eventId)
        .sort((a, b) => b.activity_at - a.activity_at)
        .map((a) => {
          const c = CHALLENGES.find((cc) => cc.id === a.challenge_id);
          const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
          return { ...a, activity_kind: t.kind };
        });
      return { rows };
    }

    // ── /me/breakdown: season-scoped event list (internal excluded) ─────
    if (sql.includes('FROM season_events WHERE season_id = $1 AND internal = FALSE ORDER BY starts_at ASC')) {
      const rows = SEASON_EVENTS.filter((e) => e.season_id === params[0] && !e.internal);
      return { rows };
    }
    // ── /me/breakdown: global-scope season list ─────────────────────────
    if (sql.includes('FROM seasons WHERE internal = FALSE ORDER BY display_order')) {
      return { rows: SEASONS.filter((s) => !s.internal) };
    }

    // ── /event/points: latest-per-user totals for one event ─────────────
    if (sql.includes('SELECT DISTINCT ON (user_id) user_id, total_points FROM leaderboard_snapshots')) {
      const rows = latestPerUserForEvent(params[0]).map((s) => ({ user_id: s.user_id, total_points: s.total_points }));
      return { rows };
    }

    // ── mobile /leaderboard: public events-with-leaderboard list ────────
    if (sql.includes('display_leaderboard = TRUE ORDER BY starts_at DESC')) {
      const rows = SEASON_EVENTS
        .filter((e) => e.season_id === params[0] && !e.internal && e.display_leaderboard)
        .sort((a, b) => b.starts_at - a.starts_at);
      return { rows };
    }
    // ── mobile /leaderboard: event-scope rows ───────────────────────────
    if (sql.includes('ls.event_total_produced_blocks AS total_produced_blocks')) {
      const eventId = params[0];
      const rows = latestPerUserForEvent(eventId)
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((s) => {
          const u = USERS.find((x) => x.id === s.user_id);
          return {
            user_id: s.user_id, rank: s.rank, total_points: s.total_points, extra_points: s.extra_points,
            total_produced_blocks: s.event_total_produced_blocks, vrf_total_won_slots: s.vrf_total_won_slots,
            event_success_rate: s.event_success_rate, is_non_podium: u.exclude_podium,
            email: u.email, telegram: u.telegram, discord: u.discord, display_name: u.display_name,
          };
        });
      return { rows };
    }
    // ── mobile /leaderboard: season-scope rows (extended aggregate) ─────
    if (sql.includes('SUM(l.vrf_total_won_slots)')) {
      return { rows: computeSeasonLeaderboardRows(params[0]) };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

// ─── Test app wiring ──────────────────────────────────────────────────

function withApp(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const mobileModulePath = require.resolve('../src/routes/topochain/mobile');
  delete require.cache[mobileModulePath];
  try {
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(topochainMobileRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  });
}

function bearer(raw) {
  return { authorization: `Bearer ${raw}` };
}

function getJson(base, path, headers) {
  return fetch(`${base}${path}`, { headers });
}

const ALICE = bearer('alice-token');
const BOB = bearer('bob-token');
const CAROL = bearer('carol-token');
const DAVE = bearer('dave-token');

// ─── GET /me (SPEC 1748-1767) ───────────────────────────────────────────

test('GET /me: exact response shape, incl. level', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me', ALICE);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      success: true,
      data: {
        id: 1, email: 'alice@example.com', display_name: null, email_confirmed: true,
        is_in_waitlist: false, github: 'alicegh', x: 'aliceX', level: 'member',
        // Onboarding flow alignment: the platform-access + block-producer
        // ladder ships on /me (fixture user has none of it granted).
        has_platform_access: false, bp_requested: false, bp_released: false,
      },
    });
  });
});

test('GET /me: no Authorization -> 401', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me');
    assert.equal(res.status, 401);
  });
});

// ─── GET /me/ranking (SPEC 1769-1820) ───────────────────────────────────

test('me/ranking event scope: with a snapshot -> full shape, extra_points present, tokens hardcoded 0', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_event_id=100', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, {
      scope: 'event', season_event_id: 100, event_name: 'Sprint One',
      rank: 1, total_points: 200, total_tokens: 0, extra_points: 10,
      total_participants: 3,
      terms_accepted: true, terms_version_required: 'v1', terms_link: 'https://example.com/terms/v1',
    });
  });
});

test('me/ranking event scope: no snapshot for this user -> 200, rank null, zero totals, extra_points OMITTED', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_event_id=105', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.rank, null);
    assert.equal(body.data.total_points, 0);
    assert.equal(body.data.total_tokens, 0);
    assert.equal(body.data.total_participants, 0);
    assert.ok(!('extra_points' in body.data), 'extra_points must be absent, not zero');
  });
});

test('me/ranking: season_event_id that does not exist -> 422 validation envelope', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_event_id=999999', ALICE);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(body.details.season_event_id);
  });
});

test('me/ranking: event with display_leaderboard=false -> 404 "Event not found or has no leaderboard."', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_event_id=101', ALICE);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Event not found or has no leaderboard.' });
  });
});

test('me/ranking: internal event -> the same 404', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_event_id=102', ALICE);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Event not found or has no leaderboard.' });
  });
});

test('me/ranking season scope: terms accepted -> real total_tokens from token_allocation', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_id=10', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, {
      scope: 'season', season_id: 10, season_name: 'Season Alpha',
      rank: 1, total_points: 200, total_tokens: 500, extra_points: 10,
      total_participants: 3,
      terms_accepted: true, terms_version_required: 'v1', terms_link: 'https://example.com/terms/v1',
    });
  });
});

test('me/ranking season scope: terms NOT accepted -> total_tokens forced 0, rank/points unaffected', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_id=10', BOB);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.terms_accepted, false);
    assert.equal(body.data.total_tokens, 0, 'forced to 0 despite a real 300-token allocation row');
    assert.equal(body.data.rank, 2, 'bob shares rank 2 with excluded carol under the shared-rank rule');
    assert.equal(body.data.total_points, 100, 'points are never gated');
  });
});

test('me/ranking: season_id that does not exist -> 422', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_id=999999', ALICE);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.details.season_id);
  });
});

test('me/ranking: internal season -> 404 "Season not found."', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking?season_id=20', ALICE);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Season not found.' });
  });
});

test('me/ranking global scope: rank/points/events_participated from standings, total_tokens summed across seasons', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, {
      scope: 'global', rank: 1, total_points: 200, total_tokens: 500,
      events_participated: 1, total_produced_blocks: 20,
      // 4, not 3: erin (season 30's hidden-event snapshot, see fixtures
      // above) still counts here — services/topochain/standings.js's
      // shared aggregate has no display_leaderboard filter at all (a
      // pre-existing, deliberately-unchanged behavior; only the mobile
      // LEADERBOARD endpoint's OWN season-scope query was fixed).
      total_participants: 4,
      terms_accepted: true, terms_version_required: 'v1', terms_link: 'https://example.com/terms/v1',
    });
  });
});

test('me/ranking global scope: podium-excluded user shares a rank rather than skipping it', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking', CAROL);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.rank, 2, 'excluded user shares rank 2 (never consumes a podium slot)');
    assert.equal(body.data.total_points, 150);
  });
});

test('me/ranking global scope: a user with no data anywhere -> 200, rank null, zeroed totals, no tokens', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/ranking', DAVE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, {
      scope: 'global', rank: null, total_points: 0, total_tokens: 0,
      events_participated: 0, total_produced_blocks: 0, total_participants: 4, // see the note above
      terms_accepted: false, terms_version_required: 'v1', terms_link: 'https://example.com/terms/v1',
    });
  });
});

// ─── GET /me/breakdown (SPEC 1821-1865) ────────────────────────────────

test('me/breakdown event scope: full shape incl. challenge_progress + activities with renamed activity_kind', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/breakdown?season_event_id=100', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.scope, 'event');
    assert.equal(body.data.display_name, 'ali***@***.com', 'discord/display_name both absent -> masked email');
    assert.deepEqual(body.data.event, { id: 100, name: 'Sprint One' });
    assert.equal(body.data.total_points, 200);
    assert.equal(body.data.extra_points, 10);
    assert.equal(body.data.rank, 1);
    assert.equal(body.data.first_block_points, 5);
    assert.equal(body.data.top_3_points, 10);
    assert.equal(body.data.success_50_percent_points, 15);
    assert.equal(body.data.produced_blocks, 20);
    assert.equal(body.data.vrf_won_slots, 40);
    assert.equal(body.data.success_rate, 50);

    // challenge_progress: only the ENABLED challenge (id 1) appears —
    // challenge 2 is disabled and skipped entirely.
    assert.equal(body.data.challenge_progress.length, 1);
    assert.deepEqual(body.data.challenge_progress[0], {
      challenge_id: 1, state: 'none', current: null, target: 5,
      pending_points: 0, earned_points: 20, description: 'Report a bug (template)',
    });

    // activities: activity_sub_category -> activity_kind rename.
    assert.equal(body.data.activities.length, 1);
    assert.equal(body.data.activities[0].activity_kind, 'REPORT_BUG');
    assert.equal(body.data.activities[0].challenge_id, 1);
    assert.equal(body.data.activities[0].points, 20);
  });
});

test('me/breakdown: include_activity=false -> activities key entirely absent', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/breakdown?season_event_id=100&include_activity=false', ALICE);
    const body = await res.json();
    assert.ok(!('activities' in body.data), 'activities must be omitted, not an empty array');
    assert.ok(Array.isArray(body.data.challenge_progress), 'challenge_progress is unaffected by include_activity');
  });
});

test('me/breakdown event scope: no snapshot -> v4 zero-fills every key instead of omitting (SPEC 1862)', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/breakdown?season_event_id=105', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.total_points, 0);
    assert.equal(body.data.extra_points, 0);
    assert.equal(body.data.rank, null);
    assert.equal(body.data.first_block_points, 0, 'zero-filled, not absent');
    assert.equal(body.data.top_3_points, 0);
    assert.equal(body.data.success_50_percent_points, 0);
    assert.equal(body.data.produced_blocks, 0);
    assert.equal(body.data.vrf_won_slots, 0);
    assert.equal(body.data.success_rate, 0);
    // No challenges are enabled for event 105 in this fixture set.
    assert.deepEqual(body.data.challenge_progress, []);
  });
});

test('me/breakdown: no-leaderboard / internal events get the same 404s as /me/ranking', async () => {
  await withServer(async (base) => {
    const noLb = await getJson(base, '/api/v4/mobile/me/breakdown?season_event_id=101', ALICE);
    assert.equal(noLb.status, 404);
    const internal = await getJson(base, '/api/v4/mobile/me/breakdown?season_event_id=102', ALICE);
    assert.equal(internal.status, 404);
    const unknown = await getJson(base, '/api/v4/mobile/me/breakdown?season_event_id=999999', ALICE);
    assert.equal(unknown.status, 422);
  });
});

test('me/breakdown season scope: only event 100 (the one with a snapshot) is included — 101/102/103/105 are skipped', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/breakdown?season_id=10', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.scope, 'season');
    assert.equal(body.data.events.length, 1, 'events without a snapshot are skipped entirely');
    assert.equal(body.data.events[0].event.id, 100);
    // Season-scope event objects keep the three bonus keys (not omitted).
    assert.ok('first_block_points' in body.data.events[0]);
  });
});

test('me/breakdown global scope: nested seasons[].events[], bonus keys OMITTED entirely', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/me/breakdown', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.scope, 'global');
    assert.equal(body.data.seasons.length, 1, 'Hidden Season is internal and never appears');
    assert.equal(body.data.seasons[0].id, 10);
    assert.equal(body.data.seasons[0].events.length, 1);
    const eventObj = body.data.seasons[0].events[0];
    assert.ok(!('first_block_points' in eventObj), 'global scope omits the three bonus keys entirely');
    assert.ok(!('top_3_points' in eventObj));
    assert.ok(!('success_50_percent_points' in eventObj));
    assert.equal(eventObj.produced_blocks, 20, 'non-bonus keys are still present');
  });
});

// ─── GET /event/points (SPEC 1867-1893) ────────────────────────────────

test('event/points: totals + renamed keys (season_event_id, user_total_points)', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/event/points?season_event_id=100', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.season_event_id, 100);
    assert.equal(body.data.event_name, 'Sprint One');
    assert.equal(body.data.event_total_points, 450, '200 + 150 + 100');
    assert.equal(body.data.user_total_points, body.data.event_total_points, 'kept equal per the documented judgment call');
    assert.equal(body.data.total_participants, 3);
    assert.equal(body.data.total_points_per_user.length, 3);
    assert.deepEqual(body.data.total_points_per_user[0], { user_id: 1, total_points: 200 });
  });
});

test('event/points: pagination — per_page=1 slices total_points_per_user, meta reflects the full total', async () => {
  await withServer(async (base) => {
    const page1 = await getJson(base, '/api/v4/mobile/event/points?season_event_id=100&per_page=1&page=1', ALICE);
    const body1 = await page1.json();
    assert.equal(body1.data.total_points_per_user.length, 1);
    assert.deepEqual(body1.meta, { page: 1, per_page: 1, total: 3, total_pages: 3 });
    assert.equal(body1.data.total_points_per_user[0].user_id, 1, 'sorted by total_points DESC');

    const page2 = await getJson(base, '/api/v4/mobile/event/points?season_event_id=100&per_page=1&page=2', ALICE);
    const body2 = await page2.json();
    assert.equal(body2.data.total_points_per_user[0].user_id, 3, 'carol (150) is second');
  });
});

test('event/points: missing season_event_id -> 422', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/event/points', ALICE);
    assert.equal(res.status, 422);
  });
});

test('event/points: unknown season_event_id -> 422', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/event/points?season_event_id=999999', ALICE);
    assert.equal(res.status, 422);
  });
});

test('event/points: internal event -> 404 "Event not found."', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/event/points?season_event_id=102', ALICE);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Event not found.' });
  });
});

test('event/points: per_page out of range -> 422 (guards the source per_page=0 division-by-zero)', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/event/points?season_event_id=100&per_page=0', ALICE);
    assert.equal(res.status, 422);
  });
});

// ─── GET /leaderboard (mobile, SPEC 1895-1932) ─────────────────────────

test('mobile leaderboard event scope: stored rank, omits events_participated', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=10&season_event_id=100', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.season, { id: 10, name: 'Season Alpha' });
    assert.equal(body.data.leaderboard.length, 3);
    // Stored ranks: alice 1, carol 2, bob 3 (distinct from the season-scope
    // shared-rank result below).
    assert.deepEqual(body.data.leaderboard.map((r) => [r.user_id, r.rank]), [[1, 1], [3, 2], [2, 3]]);
    assert.ok(!('events_participated' in body.data.leaderboard[0]), 'event scope omits this key entirely');
    assert.equal(body.data.leaderboard[0].success_rate, 50, 'event scope reads the stored event_success_rate');
    assert.equal(body.data.leaderboard[1].is_non_podium, true, 'carol is podium-excluded');
    assert.deepEqual(body.data.pagination, { page: 1, per_page: 50, total: 3, total_pages: 1 });
  });
});

test('mobile leaderboard season scope: shared-rank rule, computed success_rate, events_participated present', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=10', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    // Season scope computes rank via the shared-rank rule: carol (excluded)
    // and bob end up sharing rank 2 (SPEC 959), unlike event scope's
    // distinct stored ranks 1/2/3.
    assert.deepEqual(body.data.leaderboard.map((r) => [r.user_id, r.rank]), [[1, 1], [3, 2], [2, 2]]);
    assert.ok(body.data.leaderboard.every((r) => 'events_participated' in r), 'season scope includes this key');
    assert.equal(body.data.leaderboard[0].events_participated, 1);
    // success_rate computed live from produced/won (alice: 20/40 = 50%).
    assert.equal(body.data.leaderboard[0].success_rate, 50);
  });
});

// Code review fix: season 30's only event (301) is public (internal:
// false) but hidden from the leaderboard (display_leaderboard: false),
// and DOES have a real snapshot for erin (1 point, event_total_produced
// _blocks 1, vrf_total_won_slots 2) — unlike event 101 in season 10,
// which has no snapshot rows at all and so never exercised this branch.
// Before the fix, SEASON_LEADERBOARD_SQL only checked `se.internal =
// FALSE`, so erin's hidden-event point would have leaked into season 30's
// aggregate even though the SAME endpoint's events[] list already hides
// event 301 — an internally inconsistent result. After the fix, season
// 30 has no qualifying (public AND on-leaderboard) events at all, so the
// season-scope leaderboard is empty.
test('mobile leaderboard season scope: a display_leaderboard=false event with REAL snapshot rows contributes nothing', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=30', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.events, [], 'the hidden event never appears in events[] either');
    assert.deepEqual(body.data.leaderboard, [], 'erin\'s hidden-event point does not leak into the season aggregate');
    assert.deepEqual(body.data.pagination, { page: 1, per_page: 50, total: 0, total_pages: 0 });
  });
});

test('mobile leaderboard: events[] lists only public events with a leaderboard; the season-type event is renamed', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=10', ALICE);
    const body = await res.json();
    const ids = body.data.events.map((e) => e.id).sort((a, b) => a - b);
    // 100 (regular, public, has LB), 103 (season-type, public, has LB),
    // 105 (regular, public, has LB) all appear; 101 (no LB) and 102
    // (internal) never do.
    assert.deepEqual(ids, [100, 103, 105]);
    const wrapUp = body.data.events.find((e) => e.id === 103);
    assert.equal(wrapUp.name, 'Season Alpha Global Challenges', 'season-type event renamed per SPEC 1932');
    const regular = body.data.events.find((e) => e.id === 100);
    assert.equal(regular.name, 'Sprint One', 'a regular event keeps its own name');
  });
});

test('mobile leaderboard: missing season_id -> 422', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard', ALICE);
    assert.equal(res.status, 422);
  });
});

test('mobile leaderboard: unknown season_id -> 422', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=999999', ALICE);
    assert.equal(res.status, 422);
  });
});

test('mobile leaderboard: internal season -> 404 "Season not found."', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=20', ALICE);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Season not found.' });
  });
});

test('mobile leaderboard: season_event_id belonging to a different season -> 422', async () => {
  await withServer(async (base) => {
    // Season 20 exists (internal, but the event lookup happens after the
    // season-internal 404 short-circuits) — use a season_event_id that
    // simply isn't part of season 10 to hit the mismatch branch directly.
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=10&season_event_id=999999', ALICE);
    assert.equal(res.status, 422);
  });
});

test('mobile leaderboard: pagination — per_page=1 slices the leaderboard array', async () => {
  await withServer(async (base) => {
    const res = await getJson(base, '/api/v4/mobile/leaderboard?season_id=10&season_event_id=100&per_page=1&page=2', ALICE);
    const body = await res.json();
    assert.equal(body.data.leaderboard.length, 1);
    assert.equal(body.data.leaderboard[0].user_id, 3, 'page 2 of a per_page=1 slice is the 2nd-ranked row');
    assert.deepEqual(body.data.pagination, { page: 2, per_page: 1, total: 3, total_pages: 3 });
  });
});
