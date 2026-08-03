'use strict';

// The platform's ONE definition of "who contributed to this app", plus the
// ranked/counted read the app-details Contributors section renders (#919).
//
// Contributors for an app = the DISTINCT union of:
//   1. the creator (apps.created_by),
//   2. accepted members (app_collaborators status='member'),
//   3. authors of merged proposals (chat_sessions status='merged').
//
// This used to live inside src/routes/public-api.js, which is still the
// unauthenticated consumer (GET /api/public/apps, GET /api/public/apps/:slug
// /contributors) and re-exports `loadContributors` from here so its tests
// keep importing it from the route module. The authed per-app read
// (GET /api/apps/:slug/contributors) uses loadRankedContributors below.
// Keeping BOTH callers on the same CTE is the point: "who counts as a
// contributor" must not drift between the public API and the app-details
// page, and tests/app-contributors-route.test.js pins the shared identity.

// The three-source union, parameterized on $1 = int[] of app ids. Shared
// verbatim by both loaders so the definition exists exactly once.
const CONTRIBUTOR_IDS_CTE = `
  SELECT id AS app_id, created_by AS user_id
    FROM apps
   WHERE id = ANY($1::int[]) AND created_by IS NOT NULL
  UNION
  SELECT app_id, user_id
    FROM app_collaborators
   WHERE app_id = ANY($1::int[]) AND status = 'member'
  UNION
  SELECT app_id, user_id
    FROM chat_sessions
   WHERE app_id = ANY($1::int[]) AND status = 'merged' AND user_id IS NOT NULL`;

// Ranked-list bounds. The largest contributor set in production is 23
// (block-game-54d305), so the default returns every contributor for every
// app that exists today; the cap is a runaway guard, not a paging scheme.
const DEFAULT_RANKED_LIMIT = 50;
const MAX_RANKED_LIMIT = 100;

// One round-trip that resolves the contributor set for any number of app
// ids at once (avoids an N+1 across the apps list). The UNION dedups the
// (app_id, user_id) pairs across the three sources; the join to users drops
// any id that no longer resolves (created_by / user_id are ON DELETE SET
// NULL). Ordered by username for stable output.
async function loadContributors(pool, appIds) {
  if (!appIds.length) return new Map();
  const { rows } = await pool.query(
    `WITH contributor_ids AS (${CONTRIBUTOR_IDS_CTE}
     )
     SELECT c.app_id, u.id AS user_id, u.username,
            u.usernode_pubkey AS wallet_address
       FROM contributor_ids c
       JOIN users u ON u.id = c.user_id
      ORDER BY LOWER(u.username)`,
    [appIds]
  );
  const byApp = new Map();
  for (const r of rows) {
    if (!byApp.has(r.app_id)) byApp.set(r.app_id, []);
    byApp.get(r.app_id).push(r);
  }
  return byApp;
}

// Clamp a caller-supplied `limit` into [1, MAX_RANKED_LIMIT]; anything
// unparseable falls back to the default rather than erroring — a garbage
// query string shouldn't 400 a read-only list.
function clampRankedLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_RANKED_LIMIT;
  if (n < 1) return 1;
  if (n > MAX_RANKED_LIMIT) return MAX_RANKED_LIMIT;
  return n;
}

// The app-details Contributors section: the same three-source set for ONE
// app, with per-app merge and vote counts, ranked most-productive-first.
//
// Returns { items, total } — `total` is the full set size even when `items`
// is truncated by `limit`, so the UI's "Show all N contributors" is honest.
//
// The two aggregates are LEFT JOIN LATERAL scalars, NOT extra joins folded
// into one GROUP BY: the merged-session fan-out and the pr_votes fan-out
// would cross-multiply and corrupt each other's counts. Same reasoning (and
// same shape) as the kudos_given / awarded-bounty laterals documented in
// src/routes/kudos.js's /api/leaderboard/users query.
//
// Ranking: merges first (the headline number and the reason this reads as
// "top contributors"), then votes cast, then the creator ahead of others on
// a tie, then alphabetical. A member who has merged nothing still appears,
// last, at 0 — being on the roster IS being a contributor.
async function loadRankedContributors(pool, appId, opts = {}) {
  const limit = clampRankedLimit(opts.limit);
  const { rows } = await pool.query(
    `WITH contributor_ids AS (${CONTRIBUTOR_IDS_CTE}
     )
     SELECT u.id AS user_id,
            u.username,
            COALESCE(m.cnt, 0)::int AS merged_count,
            COALESCE(v.cnt, 0)::int AS votes_count,
            m.last_merged_at,
            (a.created_by = u.id) AS is_creator,
            EXISTS (
              SELECT 1 FROM app_collaborators ac
               WHERE ac.app_id = a.id AND ac.user_id = u.id AND ac.status = 'member'
            ) AS is_member,
            COUNT(*) OVER ()::int AS total
       FROM contributor_ids c
       JOIN users u ON u.id = c.user_id
       JOIN apps a ON a.id = c.app_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt, MAX(cs.merged_at) AS last_merged_at
           FROM chat_sessions cs
          WHERE cs.app_id = a.id AND cs.status = 'merged' AND cs.user_id = u.id
       ) m ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt
           FROM pr_votes pv
           JOIN chat_sessions cs ON cs.id = pv.session_id
          WHERE cs.app_id = a.id AND pv.user_id = u.id
       ) v ON true
      ORDER BY merged_count DESC,
               votes_count DESC,
               is_creator DESC,
               m.last_merged_at DESC NULLS LAST,
               LOWER(u.username) ASC
      LIMIT $2`,
    [[appId], limit]
  );
  // COUNT(*) OVER () rides every row, so the full set size survives the
  // LIMIT without a second query. No rows => an empty set, total 0.
  const total = rows.length ? rows[0].total : 0;
  return { items: rows.map(shapeRankedContributor), total };
}

// Wire shape for one ranked row. Deliberately drops `usernode_pubkey` and
// the `total`/`last_merged_at` internals: the public API opts wallet
// addresses in for outside integrations, but this is a UI payload for the
// app-details page and has no use for an on-chain address.
function shapeRankedContributor(row) {
  return {
    user_id: row.user_id,
    username: row.username,
    merged_count: row.merged_count || 0,
    votes_count: row.votes_count || 0,
    is_creator: !!row.is_creator,
    is_member: !!row.is_member,
  };
}

// Project a contributor row to its PUBLIC-API wire shape. wallet_address is
// included by default; `includeWallets === false` drops the key entirely.
function shapeContributor(row, includeWallets) {
  const out = { user_id: row.user_id, username: row.username };
  if (includeWallets) out.wallet_address = row.wallet_address ?? null;
  return out;
}

// ── Staging mock data (#919) ────────────────────────────────────────────
//
// `chat_sessions` is tagged `staging:private` (src/db/schema.sql) and the
// clone scrub TRUNCATEs it with CASCADE, which takes `pr_votes` with it. So
// in EVERY staging preview every app has zero merged proposals and zero
// votes: the Contributors section would show only the surviving
// creator/member rows, all at "0 merged", and the ranking, the count badge
// and the "Show all" toggle would never be exercised in a PR review.
//
// Per the platform's "Staging mock data" convention this is REQUEST-TIME
// demo injection: gated on IS_STAGING && ?demo=1, read-path only (nothing
// is written to the staging DB), and a strict no-op in production. The rows
// REPLACE the real ones rather than topping them up, so the screenshot
// capture is deterministic regardless of which cloned app the
// ?shot=browse-detail deep link happens to drill into.
//
// Seven rows so the list overflows the 5-row fold and the toggle renders.
// The tail is deliberate coverage: a votes-only contributor and a bare
// member exercise the muted "0 merged" pill and the no-meta-line row.
const DEMO_CONTRIBUTORS = [
  { user_id: 990201, username: 'staging-demo-lead', merged_count: 14, votes_count: 41, is_creator: true, is_member: true },
  { user_id: 990202, username: 'staging-demo-builder', merged_count: 9, votes_count: 33, is_creator: false, is_member: true },
  { user_id: 990203, username: 'staging-demo-shipper', merged_count: 6, votes_count: 12, is_creator: false, is_member: false },
  { user_id: 990204, username: 'staging-demo-tinkerer', merged_count: 3, votes_count: 28, is_creator: false, is_member: false },
  { user_id: 990205, username: 'staging-demo-newcomer', merged_count: 1, votes_count: 2, is_creator: false, is_member: false },
  { user_id: 990206, username: 'staging-demo-reviewer', merged_count: 0, votes_count: 19, is_creator: false, is_member: false },
  { user_id: 990207, username: 'staging-demo-lurker', merged_count: 0, votes_count: 0, is_creator: false, is_member: true },
];

// The demo payload, or null when this request isn't a staging demo request.
// Reads USERNODE_ENV at call time (not module load) so tests can flip it.
function demoRankedContributors(req) {
  if (process.env.USERNODE_ENV !== 'staging') return null;
  if (req?.query?.demo !== '1') return null;
  const items = DEMO_CONTRIBUTORS.map((c) => ({ ...c }));
  return { items, total: items.length };
}

module.exports = {
  loadContributors,
  loadRankedContributors,
  shapeContributor,
  shapeRankedContributor,
  clampRankedLimit,
  demoRankedContributors,
  CONTRIBUTOR_IDS_CTE,
  DEFAULT_RANKED_LIMIT,
  MAX_RANKED_LIMIT,
  DEMO_CONTRIBUTORS,
};
