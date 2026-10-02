'use strict';

// Chronological analytics funnels. Mature conversion and in-progress counts
// are separate, and opening-reporting boundaries are explicit. A first client
// receipt does not prove complete client coverage, so the UI never calls a
// missing dapp receipt abandonment. Historical opening backfills are excluded:
// observed app opens carry source=app_tab, while live PR opens carry prNumber.

const OBSERVATION_WINDOW_DAYS = 30;
const COHORT_DAYS = Object.freeze({
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
});

const DAPP_FUNNEL_SQL = `
WITH coverage AS (
  SELECT MIN(created_at) AS coverage_started_at
    FROM events
   WHERE event_type = 'dapp_opened'
     AND metadata->>'source' = 'app_tab'
     AND created_at <= $1::timestamptz
), cohort_users AS (
  SELECT u.id AS user_id, u.is_admin, u.created_at AS entered_at,
         c.coverage_started_at,
         u.created_at + ($3::int * INTERVAL '1 day') AS deadline
    FROM users u
    CROSS JOIN coverage c
   WHERE u.created_at <= $1::timestamptz
     AND ($2::timestamptz IS NULL OR u.created_at >= $2::timestamptz)
     AND ($4::boolean OR NOT u.is_admin)
), journeys AS (
  SELECT b.*, opened.opened_at, returned.returned_at,
         engaged.engaged_at, creator.creator_at,
         engaged_any.engaged_any_at, creator_any.creator_any_at
    FROM cohort_users b
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS opened_at
        FROM events e
       WHERE e.user_id = b.user_id
         AND e.event_type = 'dapp_opened'
         AND e.metadata->>'source' = 'app_tab'
         AND e.created_at > b.entered_at
         AND e.created_at <= $1::timestamptz
         AND e.created_at <= b.deadline
    ) opened ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS returned_at
        FROM events e
       WHERE e.user_id = b.user_id
         AND e.event_type = 'dapp_opened'
         AND e.metadata->>'source' = 'app_tab'
         AND e.created_at > opened.opened_at
         AND (e.created_at AT TIME ZONE 'UTC')::date
             > (opened.opened_at AT TIME ZONE 'UTC')::date
         AND e.created_at <= $1::timestamptz
         AND e.created_at <= b.deadline
    ) returned ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS engaged_at
        FROM events e
       WHERE e.user_id = b.user_id
         AND e.event_type IN (
           'chat_message_sent', 'pr_vote_cast', 'kudos_given', 'app_favorited'
         )
         AND (e.event_type <> 'app_favorited'
           OR e.metadata->>'source' = 'user_favorite_toggle')
         AND e.created_at > returned.returned_at
         AND e.created_at <= $1::timestamptz
         AND e.created_at <= b.deadline
    ) engaged ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS creator_at
        FROM events e
       WHERE e.user_id = b.user_id
         AND e.event_type = 'app_created'
         AND e.created_at > engaged.engaged_at
         AND e.created_at <= $1::timestamptz
         AND e.created_at <= b.deadline
    ) creator ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS engaged_any_at
        FROM events e
       WHERE e.user_id = b.user_id
         AND e.event_type IN (
           'chat_message_sent', 'pr_vote_cast', 'kudos_given', 'app_favorited'
         )
         AND (e.event_type <> 'app_favorited'
           OR e.metadata->>'source' = 'user_favorite_toggle')
         AND e.created_at > b.entered_at
         AND e.created_at <= $1::timestamptz
         AND e.created_at <= b.deadline
    ) engaged_any ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS creator_any_at
        FROM events e
       WHERE e.user_id = b.user_id
         AND e.event_type = 'app_created'
         AND e.created_at > b.entered_at
         AND e.created_at <= $1::timestamptz
         AND e.created_at <= b.deadline
    ) creator_any ON TRUE
)
SELECT
  (SELECT coverage_started_at FROM coverage) AS coverage_started_at,
  COUNT(*) FILTER (WHERE NOT is_admin)::int AS cohort_size,
  COUNT(*) FILTER (WHERE is_admin)::int AS cohort_size_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND NOT is_admin
  )::int AS maturing,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND is_admin
  )::int AS maturing_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND (coverage_started_at IS NULL OR entered_at < coverage_started_at)
      AND NOT is_admin
  )::int AS unknown_coverage,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND (coverage_started_at IS NULL OR entered_at < coverage_started_at)
      AND is_admin
  )::int AS unknown_coverage_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND NOT is_admin
  )::int AS signed_up,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND is_admin
  )::int AS signed_up_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND opened_at IS NOT NULL AND NOT is_admin
  )::int AS opened_dapp,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND opened_at IS NOT NULL AND is_admin
  )::int AS opened_dapp_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND returned_at IS NOT NULL AND NOT is_admin
  )::int AS returned,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND returned_at IS NOT NULL AND is_admin
  )::int AS returned_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND engaged_at IS NOT NULL AND NOT is_admin
  )::int AS engaged,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND engaged_at IS NOT NULL AND is_admin
  )::int AS engaged_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND creator_at IS NOT NULL AND NOT is_admin
  )::int AS creators,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND creator_at IS NOT NULL AND is_admin
  )::int AS creators_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND NOT is_admin
  )::int AS signed_up_provisional,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND is_admin
  )::int AS signed_up_provisional_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND opened_at IS NOT NULL AND NOT is_admin
  )::int AS opened_dapp_provisional,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND opened_at IS NOT NULL AND is_admin
  )::int AS opened_dapp_provisional_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND returned_at IS NOT NULL AND NOT is_admin
  )::int AS returned_provisional,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND returned_at IS NOT NULL AND is_admin
  )::int AS returned_provisional_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND engaged_at IS NOT NULL AND NOT is_admin
  )::int AS engaged_provisional,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND engaged_at IS NOT NULL AND is_admin
  )::int AS engaged_provisional_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND creator_at IS NOT NULL AND NOT is_admin
  )::int AS creators_provisional,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND creator_at IS NOT NULL AND is_admin
  )::int AS creators_provisional_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND NOT is_admin
  )::int AS reach_signed_up,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND opened_at IS NOT NULL AND NOT is_admin
  )::int AS reach_opened_dapp,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND returned_at IS NOT NULL AND NOT is_admin
  )::int AS reach_returned,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND engaged_any_at IS NOT NULL AND NOT is_admin
  )::int AS reach_engaged,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND creator_any_at IS NOT NULL AND NOT is_admin
  )::int AS reach_creators,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND is_admin
  )::int AS reach_signed_up_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND opened_at IS NOT NULL AND is_admin
  )::int AS reach_opened_dapp_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND returned_at IS NOT NULL AND is_admin
  )::int AS reach_returned_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND engaged_any_at IS NOT NULL AND is_admin
  )::int AS reach_engaged_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND creator_any_at IS NOT NULL AND is_admin
  )::int AS reach_creators_admin
FROM journeys`;

const PROPOSAL_FUNNEL_SQL = `
WITH coverage AS (
  SELECT MIN(created_at) AS coverage_started_at
    FROM events
   WHERE event_type = 'pr_opened'
     AND metadata ? 'prNumber'
     AND created_at <= $1::timestamptz
), cohort_sessions AS (
  SELECT cs.id AS session_id, cs.user_id, u.is_admin,
         cs.created_at AS entered_at,
         cs.created_at + ($3::int * INTERVAL '1 day') AS deadline,
         cs.pr_number, cs.status, cs.promoted_at AS recorded_promoted_at,
         cs.merged_at AS recorded_merged_at, c.coverage_started_at,
         (cs.pr_number IS NOT NULL) AS has_pr_state,
         (cs.promoted_at IS NOT NULL
           OR cs.status IN ('promoted', 'merging', 'merged')
           OR EXISTS (
             SELECT 1 FROM events pe
              WHERE pe.session_id = cs.id AND pe.event_type = 'pr_promoted'
           )) AS has_promotion_state,
         (cs.merged_at IS NOT NULL OR cs.status = 'merged'
           OR EXISTS (
             SELECT 1 FROM events me
              WHERE me.session_id = cs.id AND me.event_type = 'pr_merged'
           )) AS has_merge_state
    FROM chat_sessions cs
    JOIN users u ON u.id = cs.user_id
    CROSS JOIN coverage c
   WHERE cs.created_at <= $1::timestamptz
     AND ($2::timestamptz IS NULL OR cs.created_at >= $2::timestamptz)
     AND ($4::boolean OR NOT u.is_admin)
), opened AS (
  SELECT b.*, op.opened_recorded_at,
         promo_any.promoted_independent_at,
         vote_any.vote_independent_at,
         merge_any.merged_independent_at
    FROM cohort_sessions b
    LEFT JOIN LATERAL (
      SELECT MIN(e.created_at) AS opened_recorded_at
        FROM events e
       WHERE e.session_id = b.session_id
         AND e.event_type = 'pr_opened'
         AND e.metadata ? 'prNumber'
         AND e.created_at > b.entered_at
         AND e.created_at <= $1::timestamptz
    ) op ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(candidate.at) AS promoted_independent_at
        FROM (
          SELECT b.recorded_promoted_at AS at
          UNION ALL
          SELECT e.created_at FROM events e
           WHERE e.session_id = b.session_id AND e.event_type = 'pr_promoted'
        ) candidate
       WHERE candidate.at > b.entered_at
         AND candidate.at <= $1::timestamptz
    ) promo_any ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(candidate.at) AS vote_independent_at
        FROM (
          SELECT pv.created_at AS at FROM pr_votes pv
           WHERE pv.session_id = b.session_id
          UNION ALL
          SELECT e.created_at FROM events e
           WHERE e.session_id = b.session_id AND e.event_type = 'pr_vote_cast'
        ) candidate
       WHERE candidate.at > b.entered_at
         AND candidate.at <= $1::timestamptz
    ) vote_any ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(candidate.at) AS merged_independent_at
        FROM (
          SELECT b.recorded_merged_at AS at
          UNION ALL
          SELECT e.created_at FROM events e
           WHERE e.session_id = b.session_id
             AND e.event_type = 'pr_merged'
             AND e.metadata ? 'prNumber'
        ) candidate
       WHERE candidate.at > b.entered_at
         AND candidate.at <= $1::timestamptz
    ) merge_any ON TRUE
), promoted AS (
  SELECT o.*, ordered.promoted_recorded_at
    FROM opened o
    LEFT JOIN LATERAL (
      SELECT MIN(candidate.at) AS promoted_recorded_at
        FROM (
          SELECT o.recorded_promoted_at AS at
          UNION ALL
          SELECT e.created_at FROM events e
           WHERE e.session_id = o.session_id AND e.event_type = 'pr_promoted'
        ) candidate
       WHERE candidate.at > o.opened_recorded_at
         AND candidate.at <= $1::timestamptz
    ) ordered ON TRUE
), completed AS (
  SELECT p.*, voted.voted_recorded_at, merged.merged_recorded_at
    FROM promoted p
    LEFT JOIN LATERAL (
      SELECT MIN(candidate.at) AS voted_recorded_at
        FROM (
          SELECT pv.created_at AS at FROM pr_votes pv
           WHERE pv.session_id = p.session_id
          UNION ALL
          SELECT e.created_at FROM events e
           WHERE e.session_id = p.session_id AND e.event_type = 'pr_vote_cast'
        ) candidate
       WHERE candidate.at > p.promoted_recorded_at
         AND candidate.at <= $1::timestamptz
    ) voted ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(candidate.at) AS merged_recorded_at
        FROM (
          SELECT p.recorded_merged_at AS at
          UNION ALL
          SELECT e.created_at FROM events e
           WHERE e.session_id = p.session_id
             AND e.event_type = 'pr_merged'
             AND e.metadata ? 'prNumber'
        ) candidate
       WHERE candidate.at > p.promoted_recorded_at
         AND candidate.at <= $1::timestamptz
    ) merged ON TRUE
), classified AS (
  SELECT c.*,
         (opened_recorded_at IS NOT NULL AND opened_recorded_at <= deadline) AS opened_in_window,
         (opened_recorded_at IS NOT NULL AND opened_recorded_at <= deadline
           AND promoted_recorded_at IS NOT NULL AND promoted_recorded_at <= deadline) AS promoted_in_window,
         (opened_recorded_at IS NOT NULL AND opened_recorded_at <= deadline
           AND promoted_recorded_at IS NOT NULL AND promoted_recorded_at <= deadline
           AND voted_recorded_at IS NOT NULL AND voted_recorded_at <= deadline) AS voted_in_window,
         (opened_recorded_at IS NOT NULL AND opened_recorded_at <= deadline
           AND promoted_recorded_at IS NOT NULL AND promoted_recorded_at <= deadline
           AND merged_recorded_at IS NOT NULL AND merged_recorded_at <= deadline) AS merged_in_window,
         ((has_pr_state OR has_promotion_state OR has_merge_state)
           AND opened_recorded_at IS NULL) AS opening_unknown,
         ((has_promotion_state OR has_merge_state)
           AND opened_recorded_at IS NOT NULL
           AND promoted_recorded_at IS NULL) AS promotion_bypassed,
         (has_merge_state
           AND promoted_recorded_at IS NOT NULL
           AND merged_recorded_at IS NULL) AS merge_time_unknown
    FROM completed c
), measured AS (
  SELECT c.*,
         (entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
           AND entered_at >= coverage_started_at) AS tracked_mature,
         NOT (opening_unknown OR promotion_bypassed OR merge_time_unknown) AS sequence_measurable
    FROM classified c
)
SELECT
  (SELECT coverage_started_at FROM coverage) AS coverage_started_at,
  COUNT(*) FILTER (WHERE NOT is_admin)::int AS cohort_size,
  COUNT(*) FILTER (WHERE is_admin)::int AS cohort_size_admin,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND NOT is_admin
  )::int AS maturing,
  COUNT(*) FILTER (
    WHERE entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND is_admin
  )::int AS maturing_admin,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND (coverage_started_at IS NULL OR entered_at < coverage_started_at)
      AND NOT is_admin
  )::int AS unknown_coverage,
  COUNT(*) FILTER (
    WHERE entered_at <= $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND (coverage_started_at IS NULL OR entered_at < coverage_started_at)
      AND is_admin
  )::int AS unknown_coverage_admin,
  COUNT(*) FILTER (WHERE tracked_mature AND NOT sequence_measurable AND NOT is_admin)::int AS excluded,
  COUNT(*) FILTER (WHERE tracked_mature AND NOT sequence_measurable AND is_admin)::int AS excluded_admin,
  COUNT(*) FILTER (WHERE tracked_mature AND opening_unknown AND NOT is_admin)::int AS opening_unknown,
  COUNT(*) FILTER (WHERE tracked_mature AND opening_unknown AND is_admin)::int AS opening_unknown_admin,
  COUNT(*) FILTER (WHERE tracked_mature AND promotion_bypassed AND NOT is_admin)::int AS promotion_bypassed,
  COUNT(*) FILTER (WHERE tracked_mature AND promotion_bypassed AND is_admin)::int AS promotion_bypassed_admin,
  COUNT(*) FILTER (WHERE tracked_mature AND merge_time_unknown AND NOT is_admin)::int AS merge_time_unknown,
  COUNT(*) FILTER (WHERE tracked_mature AND merge_time_unknown AND is_admin)::int AS merge_time_unknown_admin,
  COUNT(*) FILTER (WHERE tracked_mature AND sequence_measurable AND NOT is_admin)::int AS started,
  COUNT(*) FILTER (WHERE tracked_mature AND sequence_measurable AND is_admin)::int AS started_admin,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND opened_in_window AND NOT is_admin
  )::int AS produced_pr,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND opened_in_window AND is_admin
  )::int AS produced_pr_admin,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND promoted_in_window AND NOT is_admin
  )::int AS promoted,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND promoted_in_window AND is_admin
  )::int AS promoted_admin,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND voted_in_window AND NOT is_admin
  )::int AS received_vote,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND voted_in_window AND is_admin
  )::int AS received_vote_admin,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND merged_in_window AND NOT is_admin
  )::int AS merged,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND merged_in_window AND is_admin
  )::int AS merged_admin,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND merged_in_window
      AND NOT voted_in_window AND NOT is_admin
  )::int AS merged_without_vote,
  COUNT(*) FILTER (
    WHERE tracked_mature AND sequence_measurable AND merged_in_window
      AND NOT voted_in_window AND is_admin
  )::int AS merged_without_vote_admin,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable AND NOT is_admin
  )::int AS started_provisional,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable AND is_admin
  )::int AS started_provisional_admin,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND opened_in_window AND NOT is_admin
  )::int AS produced_pr_provisional,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND opened_in_window AND is_admin
  )::int AS produced_pr_provisional_admin,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND promoted_in_window AND NOT is_admin
  )::int AS promoted_provisional,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND promoted_in_window AND is_admin
  )::int AS promoted_provisional_admin,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND voted_in_window AND NOT is_admin
  )::int AS received_vote_provisional,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND voted_in_window AND is_admin
  )::int AS received_vote_provisional_admin,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND merged_in_window AND NOT is_admin
  )::int AS merged_provisional,
  COUNT(*) FILTER (
    WHERE NOT tracked_mature
      AND entered_at > $1::timestamptz - ($3::int * INTERVAL '1 day')
      AND entered_at >= coverage_started_at AND sequence_measurable
      AND merged_in_window AND is_admin
  )::int AS merged_provisional_admin,
  COUNT(DISTINCT user_id) FILTER (WHERE tracked_mature AND NOT is_admin)::int AS reach_started,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND opened_recorded_at <= deadline AND NOT is_admin
  )::int AS reach_produced_pr,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND promoted_independent_at <= deadline AND NOT is_admin
  )::int AS reach_promoted,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND vote_independent_at <= deadline AND NOT is_admin
  )::int AS reach_received_vote,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND merged_independent_at <= deadline AND NOT is_admin
  )::int AS reach_merged,
  COUNT(DISTINCT user_id) FILTER (WHERE tracked_mature AND is_admin)::int AS reach_started_admin,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND opened_recorded_at <= deadline AND is_admin
  )::int AS reach_produced_pr_admin,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND promoted_independent_at <= deadline AND is_admin
  )::int AS reach_promoted_admin,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND vote_independent_at <= deadline AND is_admin
  )::int AS reach_received_vote_admin,
  COUNT(DISTINCT user_id) FILTER (
    WHERE tracked_mature AND merged_independent_at <= deadline AND is_admin
  )::int AS reach_merged_admin
FROM measured`;

function cohortStart(cohort, now) {
  const days = COHORT_DAYS[cohort];
  return days ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : null;
}

function ints(row, keys) {
  const out = {};
  for (const key of keys) out[key] = Number(row?.[key]) || 0;
  return out;
}

function coverage(row, extra = {}) {
  const startsAt = row?.coverage_started_at || null;
  return {
    status: startsAt ? 'observed_receipts' : 'awaiting_events',
    startsAt,
    observationWindowDays: OBSERVATION_WINDOW_DAYS,
    ...ints(row, [
      'cohort_size', 'cohort_size_admin', 'maturing', 'maturing_admin',
      'unknown_coverage', 'unknown_coverage_admin',
    ]),
    ...extra,
  };
}

async function fetchFunnels(pool, {
  cohort = 'all', includeAdmins = false, now = new Date(),
} = {}) {
  const normalizedCohort = Object.hasOwn(COHORT_DAYS, cohort) ? cohort : 'all';
  const asOf = now instanceof Date ? now : new Date(now);
  const params = [asOf, cohortStart(normalizedCohort, asOf), OBSERVATION_WINDOW_DAYS, !!includeAdmins];
  const [dappResult, proposalResult] = await Promise.all([
    pool.query(DAPP_FUNNEL_SQL, params),
    pool.query(PROPOSAL_FUNNEL_SQL, params),
  ]);
  const dapp = dappResult.rows[0] || {};
  const proposal = proposalResult.rows[0] || {};

  return {
    cohort: normalizedCohort,
    asOf: asOf.toISOString(),
    definitions: {
      dappUsage: {
        subject: 'user', cohortEntry: 'signup', observationWindowDays: OBSERVATION_WINDOW_DAYS,
        order: ['signup', 'app open', 'later-day return', 'social engagement', 'project creation'],
        coverageNote: 'Opening coverage is client-dependent; a missing opening receipt is not measured abandonment.',
      },
      prSessions: {
        subject: 'dev session', cohortEntry: 'session start', observationWindowDays: OBSERVATION_WINDOW_DAYS,
        order: ['session start', 'PR opened', 'promotion', 'merge'],
        optional: ['vote after promotion'],
      },
      prUsers: {
        subject: 'builder', ordered: false,
        note: 'Independent milestone reach; not a conversion funnel.',
      },
    },
    dappUsage: {
      ...ints(dapp, [
        'signed_up', 'signed_up_admin', 'opened_dapp', 'opened_dapp_admin',
        'returned', 'returned_admin', 'engaged', 'engaged_admin',
        'creators', 'creators_admin',
      ]),
      coverage: coverage(dapp, {
        eligible: Number(dapp.signed_up) || 0,
        eligible_admin: Number(dapp.signed_up_admin) || 0,
      }),
      provisional: ints(dapp, [
        'signed_up_provisional', 'signed_up_provisional_admin',
        'opened_dapp_provisional', 'opened_dapp_provisional_admin',
        'returned_provisional', 'returned_provisional_admin',
        'engaged_provisional', 'engaged_provisional_admin',
        'creators_provisional', 'creators_provisional_admin',
      ]),
    },
    dappReach: {
      signed_up: Number(dapp.reach_signed_up) || 0,
      signed_up_admin: Number(dapp.reach_signed_up_admin) || 0,
      opened_dapp: Number(dapp.reach_opened_dapp) || 0,
      opened_dapp_admin: Number(dapp.reach_opened_dapp_admin) || 0,
      returned: Number(dapp.reach_returned) || 0,
      returned_admin: Number(dapp.reach_returned_admin) || 0,
      engaged: Number(dapp.reach_engaged) || 0,
      engaged_admin: Number(dapp.reach_engaged_admin) || 0,
      creators: Number(dapp.reach_creators) || 0,
      creators_admin: Number(dapp.reach_creators_admin) || 0,
    },
    prSessions: {
      ...ints(proposal, [
        'started', 'started_admin', 'produced_pr', 'produced_pr_admin',
        'promoted', 'promoted_admin', 'received_vote', 'received_vote_admin',
        'merged', 'merged_admin', 'merged_without_vote', 'merged_without_vote_admin',
      ]),
      coverage: coverage(proposal, {
        eligible: Number(proposal.started) || 0,
        eligible_admin: Number(proposal.started_admin) || 0,
        ...ints(proposal, [
          'excluded', 'excluded_admin', 'opening_unknown', 'opening_unknown_admin',
          'promotion_bypassed', 'promotion_bypassed_admin',
          'merge_time_unknown', 'merge_time_unknown_admin',
        ]),
      }),
      provisional: ints(proposal, [
        'started_provisional', 'started_provisional_admin',
        'produced_pr_provisional', 'produced_pr_provisional_admin',
        'promoted_provisional', 'promoted_provisional_admin',
        'received_vote_provisional', 'received_vote_provisional_admin',
        'merged_provisional', 'merged_provisional_admin',
      ]),
    },
    prUsers: {
      started: Number(proposal.reach_started) || 0,
      started_admin: Number(proposal.reach_started_admin) || 0,
      produced_pr: Number(proposal.reach_produced_pr) || 0,
      produced_pr_admin: Number(proposal.reach_produced_pr_admin) || 0,
      promoted: Number(proposal.reach_promoted) || 0,
      promoted_admin: Number(proposal.reach_promoted_admin) || 0,
      received_vote: Number(proposal.reach_received_vote) || 0,
      received_vote_admin: Number(proposal.reach_received_vote_admin) || 0,
      merged: Number(proposal.reach_merged) || 0,
      merged_admin: Number(proposal.reach_merged_admin) || 0,
    },
  };
}

module.exports = {
  OBSERVATION_WINDOW_DAYS,
  DAPP_FUNNEL_SQL,
  PROPOSAL_FUNNEL_SQL,
  cohortStart,
  fetchFunnels,
};
