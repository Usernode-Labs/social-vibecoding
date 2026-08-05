// The RANKED-USERS query — one definition, two surfaces.
//
// This is the ordering behind the Leaderboard screen's "Top users" tab
// (GET /api/leaderboard/users, src/routes/kudos.js) AND behind the home
// screen's Challenges widget, which spends its leftover desktop space on a
// LEADERBOARD section showing the top few builders plus the viewer's own rank
// (src/routes/home-panels.js). Rank is now a number the user sees in two
// places, so it cannot be computed two ways: a widget that says "#12" while
// the tab says "#14" is a bug with no obvious owner.
//
// Same shape, and the same reason, as src/services/contributors.js — which was
// extracted so "who counts as a contributor" could not drift between the public
// and the authed read.
//
// THE ROUTE'S SQL IS THIS FILE'S SQL. `slim: false` (the default) emits the
// same statement the endpoint ran before the extraction — same SELECT list,
// same joins, same LATERAL bodies, same ORDER BY; only the long explanatory
// SQL-comment blocks moved out into JS comments. That matters concretely:
// tests/leaderboard-users-fields.test.js and
// tests/leaderboard-users-issues.test.js assert on the query TEXT (the
// active_apps LATERAL's guards, the issues LATERAL's public-app scope), so a
// reformat of those clauses is a test failure there, by design.
'use strict';

// Weekly quota per giver, mirrored from src/routes/kudos.js (which owns it and
// passes its own value in). Only used to clamp the kudos_given map; the default
// keeps a caller that doesn't care from having to know about it.
const DEFAULT_WEEKLY_KUDOS_LIMIT = 5;

// Compute the Monday-00:00-UTC date that contains the given Date.
// Mirror of Postgres's `date_trunc('week', t AT TIME ZONE 'UTC')::DATE`
// for that same instant. JS getUTCDay() returns 0..6 with Sunday=0; we
// shift so Monday=0 and subtract that many days from the UTC date.
//
// Returned as a `YYYY-MM-DD` string so it slots straight into pg DATE
// parameters without timezone-edge surprises (pg would otherwise
// re-interpret a JS Date in the connection's TZ).
//
// Lives here rather than in kudos.js so the service has no dependency on the
// route (which depends on IT). kudos.js re-exports it, so every existing
// importer — src/routes/issues.js, tests/kudos.test.js — is unaffected.
function weekStartUtc(date = new Date()) {
  const utcMidnight = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const day = utcMidnight.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - daysSinceMonday);
  const y = utcMidnight.getUTCFullYear();
  const m = String(utcMidnight.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcMidnight.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Every user, ranked by kudos received on their MERGED PRs (highest first),
// then PRs merged, then total kudos, then recency, then username. Rooted at
// `users` with LEFT JOINs so a user with zero kudos still gets a row and a
// rank.
//
// Options:
//   window   'all' (default) | 'week' — scopes the kudos / bounty / issue
//            aggregates to the current Monday-00:00-UTC week bucket.
//   limit    null (default) = every user. The LIMIT is applied AFTER the
//            aggregation, so an unlimited call costs the same as limit=20 —
//            which is what makes ranking the viewer against the whole board
//            affordable for the home widget.
//   slim     true drops the three DISPLAY-ONLY LATERALs (kudos_given,
//            issues_created, active_apps). None of them appears in the
//            ORDER BY, so a slim call ranks IDENTICALLY — it just doesn't pay
//            for columns the caller won't render. The endpoint never uses it;
//            the widget always does.
//
// Returns the raw rows in ranked order. Shaping (`fields` projection,
// zero/null filtering) stays with the endpoint that owns those params.
async function rankedUsers(pool, opts = {}) {
  const windowArg = opts.window === 'week' ? 'week' : 'all';
  const hasLimit = opts.limit !== null && opts.limit !== undefined;
  const slim = !!opts.slim;
  const weeklyKudosLimit = Number.isFinite(opts.weeklyKudosLimit)
    ? opts.weeklyKudosLimit : DEFAULT_WEEKLY_KUDOS_LIMIT;

  const weekStart = opts.weekStart || weekStartUtc();
  const params = [];
  // Window filter lives in the kudos LEFT JOIN's ON clause (not a
  // WHERE) so users/sessions are preserved even when they have no
  // kudos in the window — only the kudos aggregates get scoped.
  let kudosWindow = '';
  // The `kudos_given` LATERAL (below) reuses the same week_start
  // param when scoping to the current week, so capture its index.
  let givenWindow = '';
  // The awarded-bounty LATERAL (below) scopes by awarded_at, bucketed to
  // the same Monday-00:00-UTC week as weekStartUtc(), reusing the param.
  let bountyWindow = '';
  // The issues-created LATERAL (below) scopes by created_at, bucketed to
  // the same Monday-00:00-UTC week as weekStartUtc(), reusing the param.
  let issuesWindow = '';
  if (windowArg === 'week') {
    params.push(weekStart);
    kudosWindow = `AND pk.week_start = $${params.length}`;
    givenWindow = `AND gk.week_start = $${params.length}`;
    bountyWindow = `AND date_trunc('week', ib.awarded_at AT TIME ZONE 'UTC')::date = $${params.length}`;
    issuesWindow = `AND date_trunc('week', i.created_at AT TIME ZONE 'UTC')::date = $${params.length}`;
  }
  let limitClause = '';
  if (hasLimit) {
    params.push(opts.limit);
    limitClause = `LIMIT $${params.length}`;
  }

  // The three display-only blocks. In slim mode each collapses to nothing and
  // its SELECT alias is dropped — the ORDER BY never touches them, so the
  // ranking is unchanged.
  const givenSelect = slim ? '' : `
                kg.kudos_given,`;
  const issuesSelect = slim ? '' : `
                COALESCE(ic.cnt, 0)::int AS issues_created,`;
  const activeAppsSelect = slim ? '' : `,
                aa.active_apps`;
  // `kudos_given` is a GIVEN-side metric (rows where the user is the
  // giver), orthogonal to every other column here (all RECEIVED-side,
  // keyed off the user's authored sessions). Folding it into the main
  // GROUP BY would cross-multiply the two fan-outs and corrupt the
  // received counts, so it's computed in an independent LEFT JOIN
  // LATERAL that builds a {week_start: count} JSON map per user.
  // Counts are clamped to the weekly quota with LEAST(..., WEEKLY_KUDOS_LIMIT)
  // so the documented give-time race (overshoot by ≤1) never surfaces
  // a value above the cap. Uses idx_pr_kudos_giver_week. COALESCE
  // turns the no-rows case (jsonb_object_agg → NULL) into '{}'.
  const givenLateral = slim ? '' : `
           LEFT JOIN LATERAL (
             SELECT COALESCE(
                      jsonb_object_agg(g.week_start::text, g.c),
                      '{}'::jsonb
                    ) AS kudos_given
               FROM (
                 SELECT gk.week_start,
                        LEAST(COUNT(*), ${weeklyKudosLimit})::int AS c
                   FROM pr_kudos gk
                   WHERE gk.giver_user_id = u.id ${givenWindow}
                   GROUP BY gk.week_start
               ) g
           ) kg ON true`;
  const issuesLateral = slim ? '' : `
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS cnt
               FROM issues i
              WHERE i.created_by = u.id ${issuesWindow}
                AND EXISTS (SELECT 1 FROM apps ap
                            WHERE ap.id = i.app_id AND ap.view_visibility = 'public')
           ) ic ON true`;
  // The apps the user is CURRENTLY active on — a pure ACTIVITY signal
  // (the "active user"/"tested" definition), deliberately decoupled
  // from collab-eligibility. Uses the activity half of
  // src/services/active-users.js (hasQualifyingActivity); keep the
  // 60s bar / 10-day window in sync if either moves:
  //   * non-self-hosted apps only (the self-app never accrues its own
  //     app_activity rows). Private-VIEW apps ARE included — a user's
  //     own activity on a private-view app is not private data about
  //     anyone else, and the leaderboard should reflect all the apps
  //     they use, not just the public-view ones.
  //   * EVER qualified: some app_activity row with seconds_spent >= 60;
  //   * visited recently: an app_activity row within the last 10 days.
  // NO collab-membership gate: a user who spent >=60s/day on an app has
  // "tested" it whether or not they're a member collaborator. Collab-
  // eligibility is a SEPARATE concern, enforced at the vote layer
  // (appAccess 'collab') and folded into the vote-majority denominator
  // (active-users.js getActiveUserStats = activity ∩ eligibility) — not
  // here, where it would hide collab-private apps (e.g. goalio) from
  // their own testers.
  // Intrinsically 10-day-windowed, so it is NOT scoped by the window arg.
  // COALESCE to an empty array so "active on nothing" is [] not null.
  const activeAppsLateral = slim ? '' : `
          LEFT JOIN LATERAL (
            SELECT COALESCE(
                     jsonb_agg(
                       jsonb_build_object('slug', ap.slug, 'name', ap.name)
                       ORDER BY ap.name, ap.slug
                     ),
                     '[]'::jsonb
                   ) AS active_apps
              FROM apps ap
             WHERE ap.self_hosted = FALSE
               AND EXISTS (
                 SELECT 1 FROM app_activity r
                  WHERE r.app_id = ap.id AND r.user_id = u.id
                    AND r.date >= CURRENT_DATE - 10
               )
               AND EXISTS (
                 SELECT 1 FROM app_activity q
                  WHERE q.app_id = ap.id AND q.user_id = u.id
                    AND q.seconds_spent >= 60
               )
           ) aa ON true`;
  const groupBy = slim
    ? 'GROUP BY u.id, u.username, u.usernode_pubkey, ab.received, ab.last_at'
    : 'GROUP BY u.id, u.username, u.usernode_pubkey, kg.kudos_given, ab.received, ab.last_at, ic.cnt, aa.active_apps';

  const { rows } = await pool.query(
    // `ab` (awarded bounties) is RECEIVED-side credit that resolves on
    // merge: a bounty awarded to a user IS kudos on a merged PR. It's
    // computed in its own LATERAL (one scalar per user) so it can't
    // cross-multiply the pk fan-out, then ADDED into kudos_received and
    // kudos_received_prs_merged (every awarded bounty is merged credit).
    // prs_kudosed / kudos_received_prs_unmerged stay pr_kudos-only by
    // design (a bounty is never unmerged credit). last_kudos_at folds in
    // the most recent award so recency tiebreaks stay correct.
    `SELECT u.id AS user_id,
                u.username,
                (COUNT(pk.id) + COALESCE(ab.received, 0))::int AS kudos_received,
                COUNT(DISTINCT pk.session_id)::int AS prs_kudosed,
                (COUNT(pk.id) FILTER (WHERE cs.status = 'merged') + COALESCE(ab.received, 0))::int AS kudos_received_prs_merged,
                COUNT(pk.id) FILTER (WHERE cs.status <> 'merged')::int AS kudos_received_prs_unmerged,
                COUNT(DISTINCT cs.id) FILTER (WHERE cs.status = 'merged')::int AS prs_merged,
                GREATEST(MAX(pk.created_at), ab.last_at) AS last_kudos_at,${givenSelect}${issuesSelect}
                u.usernode_pubkey AS address${activeAppsSelect}
           FROM users u
           LEFT JOIN chat_sessions cs ON cs.user_id = u.id
             AND EXISTS (SELECT 1 FROM apps ap
                         WHERE ap.id = cs.app_id AND ap.view_visibility = 'public')
           LEFT JOIN pr_kudos pk ON pk.session_id = cs.id ${kudosWindow}${givenLateral}
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS received, MAX(ib.awarded_at) AS last_at
               FROM issue_bounties ib
              WHERE ib.awarded_user_id = u.id AND ib.status = 'awarded' ${bountyWindow}
                AND EXISTS (SELECT 1 FROM apps ap
                            WHERE ap.id = ib.app_id AND ap.view_visibility = 'public')
           ) ab ON true${issuesLateral}${activeAppsLateral}
           ${groupBy}
           ORDER BY kudos_received_prs_merged DESC,
                    prs_merged DESC,
                    kudos_received DESC,
                    last_kudos_at DESC NULLS LAST,
                    u.username ASC
           ${limitClause}`,
    params
  );
  return rows;
}

module.exports = {
  rankedUsers,
  weekStartUtc,
  DEFAULT_WEEKLY_KUDOS_LIMIT,
};
