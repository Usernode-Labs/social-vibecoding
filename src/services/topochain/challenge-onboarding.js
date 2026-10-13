'use strict';

// THE FIRST CHALLENGES: which of a season's challenges they are, and how far
// the viewer has got through them over a lifetime.
//
// The first ONBOARDING_LIMIT ONBOARDING challenges of the season, in the
// organiser's display order, are the First challenges (Join a community, Try
// an app, Vote on an app, Send feedback, as the admin sets them up; the NAMES
// are the admin's data, never this file's: whatever four come first is the
// list). Any ONBOARDING challenge after them is an ordinary PERSISTENT one
// (challengeCategory, below).
//
// They are ordinary challenges for everyone. Home's Challenges area lists
// them under their "First challenges" heading like any other card, and so do
// the Challenges tab and the native list. Until #4635 they were also a GATE:
// a new account (`users.getting_started_gate`) saw nothing else of the season
// until it had done the tour and every one of them, on a Getting started card
// on top of Home. Every new account gets a tour now, so the card and
// the gate went together: no list hides anything behind these any more.
//
// What is left here is the one thing that makes them different: their
// progress is LIFETIME. A credit on the same template in an earlier season
// counts, because the list is a one-time introduction, not something to
// repeat at a season boundary (loadOnboarding, below; Home's and the
// profile's done counts lay it over their own rule through
// routes/home-panels.js onboardingDoneExpr).
const ONBOARDING_LIMIT = 4;

// THE VIEWER'S BLOCK COUNT, AND THE ONLY PLACE IT LIVES. Block scores are
// written to leaderboard snapshots and never to the points ledger
// (services/topochain/snapshot-builder.js), so a `blocks_produced` challenge
// cannot be counted from `user_activities` the way every other metric is.
// This correlated subquery reads the viewer's newest snapshot for the event
// the challenge belongs to, and it is the ONE copy of that SQL: a query that
// already has a `c` row to correlate against embeds it (home-panels.js
// re-exports it as MY_BLOCKS_SQL for its own row query and profile.js's, and
// loadOnboarding below selects it as `blocks`), and the challenge lists,
// whose query carries no user parameter, run it through loadEventBlocks.
// $1 is the viewer's id.
const NEWEST_EVENT_BLOCKS_SQL = `(SELECT ls.event_total_produced_blocks FROM leaderboard_snapshots ls
              WHERE ls.user_id = $1 AND ls.season_event_id = c.season_event_id
              ORDER BY ls.snapshot_at DESC, ls.id DESC LIMIT 1)`;

// Which of the viewer's credits count toward a challenge's progress, as a
// condition on `ua` (the ledger row) and `ct` (the challenge's template). A
// WEEKLY challenge counts this week's credits only, from Monday 00:00 UTC,
// the week the scorer caps by (challenge-rules.weekStartMs), so its progress
// starts again every Monday. Every other challenge counts all of them.
const COUNTS_THIS_WEEK_SQL = `(UPPER(TRIM(COALESCE(ct.category, ''))) <> 'WEEKLY'
                OR ua.activity_at >= date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

// Match the home panel's existing ledger-based progress rule. Numeric
// challenges require the target number of credits, not merely some points.
function resolveProgress({ metricKind, metricTarget, activityCount, blocks, completionRecorded = false }) {
  const count = Number(activityCount) || 0;
  const target = Number(metricTarget);
  const hasTarget = metricKind != null && Number.isFinite(target) && target > 0;
  if (!hasTarget) return { done: completionRecorded || count > 0, current: null, target: null };
  const raw = metricKind === 'blocks_produced' ? (Number(blocks) || 0) : count;
  return {
    done: completionRecorded || raw >= target || (target <= 1 && count > 0),
    current: completionRecorded ? target : Math.max(0, Math.min(raw, target)),
    target,
  };
}

// The first ONBOARDING_LIMIT ONBOARDING definitions in organiser display
// order are the introduction. The remaining definitions become persistent
// challenges. Select before considering progress or availability: finishing,
// disabling, or retiring a step must never promote an identity challenge into
// its place.
//
// `ids` are the First challenges' rows, in the list's order; `progress` is
// the viewer's lifetime answer for each, keyed by row id; `available` is the
// ids that can be done now (organiser-enabled, not marked over, inside their
// window), which is what Admin › Journey counts a newcomer's list out of.
function buildOnboarding(rows, now = Date.now()) {
  if (!rows.length) return null;
  const ordered = [...rows].sort((a, b) =>
    Number(a.display_order) - Number(b.display_order) || Number(a.id) - Number(b.id));
  const templates = new Set();
  const steps = ordered.filter((r) => {
    const key = Number(r.challenge_template_id);
    if (templates.has(key)) return false;
    templates.add(key);
    return true;
  }).slice(0, ONBOARDING_LIMIT);
  const progress = new Map(steps.map((r) => [Number(r.id), resolveProgress({
    metricKind: r.metric_type,
    metricTarget: r.metric_target,
    activityCount: r.activity_count,
    blocks: r.blocks,
    completionRecorded: r.completion_recorded === true,
  })]));
  const available = steps.filter((r) => r.enabled && !r.completed
    && (!r.schedule_start || Date.parse(r.schedule_start) <= now)
    && (!r.schedule_end || Date.parse(r.schedule_end) >= now));
  return {
    ids: steps.map((r) => Number(r.id)),
    progress,
    available: available.map((r) => Number(r.id)),
  };
}

// Always resolve the entire season, even when the caller is viewing one
// weekly event or has filtered completed challenges out of its own query.
// Credits on earlier instances of the same template count too: onboarding
// is a one-time introduction, not something to repeat at a season boundary.
// A read with no side effect, for any viewer (a signed-out one included,
// whose progress is all not-done).
async function loadOnboarding(pool, userId, { seasonId, eventId } = {}) {
  const scope = seasonId != null ? 'se.season_id = $2'
    : 'se.season_id = (SELECT season_id FROM season_events WHERE id = $2)';
  const { rows } = await pool.query(
    `/* challenge onboarding */
     SELECT c.id, c.season_event_id, c.challenge_template_id, c.display_order, c.enabled, c.completed,
            COALESCE(c.schedule_start, ct.schedule_start) AS schedule_start,
            COALESCE(c.schedule_end, ct.schedule_end) AS schedule_end,
            COALESCE(c.metric_type, ct.metric_type) AS metric_type,
            COALESCE(c.metric_target, ct.metric_target) AS metric_target,
            credit.activity_count,
            EXISTS (SELECT 1 FROM user_activities ua
               JOIN challenges credited ON credited.id = ua.challenge_id
              WHERE ua.user_id = $1
                AND credited.challenge_template_id = c.challenge_template_id
                AND ua.metadata->>'kind' = 'challenge_completion') AS completion_recorded,
            ${NEWEST_EVENT_BLOCKS_SQL} AS blocks
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       JOIN challenge_templates ct ON ct.id = c.challenge_template_id
       -- Every credit on the template, this season's row or an earlier one:
       -- how many, which is the progress.
       CROSS JOIN LATERAL (
         SELECT COUNT(*) AS activity_count
           FROM user_activities ua
           JOIN challenges credited ON credited.id = ua.challenge_id
          WHERE ua.user_id = $1
            AND credited.challenge_template_id = c.challenge_template_id
       ) credit
      WHERE ${scope} AND se.internal = FALSE
        AND UPPER(TRIM(ct.category)) = 'ONBOARDING'
      ORDER BY c.display_order ASC, c.id ASC`,
    [userId ?? null, seasonId ?? eventId]
  );
  return buildOnboarding(rows);
}

// The same value, for the callers that cannot correlate it: the challenge
// LISTS (routes/topochain/public.js and mobile.js) select their rows without
// a user parameter, and mobile's list can span a whole season, so the answer
// is per season event rather than per row. UNNEST gives the shared subquery
// exactly the one-column `c` it expects, so there is still one copy of it.
// Returns a Map of season_event_id -> blocks (null where the viewer has no
// snapshot on that event), and asks Postgres nothing for a signed-out viewer
// or a list with no block-production card on it.
async function loadEventBlocks(pool, userId, eventIds) {
  const ids = [...new Set((eventIds || []).map(Number).filter(Number.isFinite))];
  if (userId == null || !ids.length) return new Map();
  const { rows } = await pool.query(
    `/* challenge event blocks */
     SELECT c.season_event_id, ${NEWEST_EVENT_BLOCKS_SQL} AS blocks
       FROM UNNEST($2::bigint[]) AS c(season_event_id)`,
    [userId, ids]
  );
  return new Map(rows.map((r) => [Number(r.season_event_id),
    r.blocks == null ? null : Number(r.blocks)]));
}

function challengeCategory(id, category, onboarding) {
  if (onboarding && String(category).trim().toUpperCase() === 'ONBOARDING') {
    return onboarding.ids.includes(Number(id)) ? 'ONBOARDING' : 'PERSISTENT';
  }
  return category;
}

module.exports = {
  ONBOARDING_LIMIT, NEWEST_EVENT_BLOCKS_SQL, COUNTS_THIS_WEEK_SQL, resolveProgress, buildOnboarding,
  loadOnboarding, loadEventBlocks, challengeCategory,
};
