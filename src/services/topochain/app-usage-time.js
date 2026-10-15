'use strict';

// Resolve the first qualifying moment from the original engaged intervals,
// independently of when they were delivered or the scorer happened to run.
// Old daily seconds still contribute, but cannot supply an invented hour.
// The sweep integrates simultaneous intervals for the minutes measure, whose
// existing rule sums use across apps, rather than ordering their upload times.
const APP_USAGE_TIMES_SQL = `
  WITH daily AS (
    SELECT aa.id, aa.user_id, aa.app_id, aa.date, aa.seconds_spent,
           CASE WHEN $5::boolean THEN aa.app_id ELSE 0 END AS unit_id,
           GREATEST(aa.seconds_spent - FLOOR(COALESCE(used.milliseconds, 0) / 1000), 0) * 1000 AS missing_ms
      FROM app_activity aa
      JOIN apps a ON a.id = aa.app_id
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (i.ended_at - i.started_at)) * 1000) AS milliseconds
          FROM app_usage_intervals i
         WHERE i.user_id = aa.user_id AND i.app_id = aa.app_id AND i.date = aa.date
      ) used ON TRUE
     WHERE aa.date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
       AND aa.date <= ($2::timestamptz AT TIME ZONE 'UTC')::date
       AND aa.user_id = ANY($6::integer[])
       AND ($4::boolean OR a.created_by IS DISTINCT FROM aa.user_id)
       AND (NOT $5::boolean OR aa.app_id = ANY($7::integer[]))
  ), pieces AS (
    SELECT d.user_id, d.unit_id, d.date, i.id,
           GREATEST(i.started_at, $1::timestamptz) AS started_at,
           LEAST(i.ended_at, $2::timestamptz) AS ended_at,
           EXTRACT(EPOCH FROM (LEAST(i.ended_at, $2::timestamptz)
             - GREATEST(i.started_at, $1::timestamptz))) * 1000 AS milliseconds,
           FALSE AS day_only
      FROM daily d JOIN app_usage_intervals i
        ON i.user_id = d.user_id AND i.app_id = d.app_id AND i.date = d.date
     WHERE i.ended_at > $1::timestamptz AND i.started_at < $2::timestamptz
    UNION ALL
    SELECT d.user_id, d.unit_id, d.date, -d.id::bigint,
           (d.date::timestamp + INTERVAL '1 day') AT TIME ZONE 'UTC',
           (d.date::timestamp + INTERVAL '1 day') AT TIME ZONE 'UTC',
           d.missing_ms, TRUE
      FROM daily d WHERE d.missing_ms > 0
  ), edges AS (
    SELECT user_id, unit_id, started_at AS at, 1 AS rate_change, 0::numeric AS missing_ms
      FROM pieces WHERE NOT day_only
    UNION ALL
    SELECT user_id, unit_id, ended_at, -1, 0::numeric FROM pieces WHERE NOT day_only
    UNION ALL
    SELECT user_id, unit_id, ended_at, 0, milliseconds FROM pieces WHERE day_only
  ), points AS (
    SELECT user_id, unit_id, at, SUM(rate_change) AS rate_change, SUM(missing_ms) AS missing_ms
      FROM edges GROUP BY user_id, unit_id, at
  ), spans AS (
    SELECT p.*,
           LEAD(at) OVER (PARTITION BY user_id, unit_id ORDER BY at) AS next_at,
           SUM(rate_change) OVER (PARTITION BY user_id, unit_id ORDER BY at) AS rate
      FROM points p
  ), weights AS (
    SELECT s.*, missing_ms + COALESCE(EXTRACT(EPOCH FROM (next_at - at)) * 1000 * rate, 0) AS milliseconds
      FROM spans s
  ), running AS (
    SELECT w.*, SUM(milliseconds) OVER (PARTITION BY user_id, unit_id ORDER BY at) AS cumulative_ms
      FROM weights w
  ), crossing AS (
    SELECT DISTINCT ON (user_id, unit_id) user_id, unit_id,
           CASE WHEN $3::bigint * 1000 - (cumulative_ms - milliseconds) <= missing_ms
             THEN at
             ELSE at + (($3::bigint * 1000 - (cumulative_ms - milliseconds) - missing_ms)
               / NULLIF(rate, 0))::double precision * INTERVAL '1 millisecond' END AS crossed_at,
           CASE WHEN $3::bigint * 1000 - (cumulative_ms - milliseconds) <= missing_ms
             THEN (at - INTERVAL '1 millisecond') AT TIME ZONE 'UTC'
             ELSE at AT TIME ZONE 'UTC' END AS source_day,
           $3::bigint * 1000 - (cumulative_ms - milliseconds) <= missing_ms AS day_only
      FROM running WHERE milliseconds > 0 AND cumulative_ms >= $3::bigint * 1000
     ORDER BY user_id, unit_id, at
  ), resolved AS (
    SELECT c.*, day_only OR EXISTS (SELECT 1 FROM daily d
      WHERE d.user_id = c.user_id AND d.unit_id = c.unit_id
        AND d.date = c.source_day::date AND d.missing_ms > 0) AS unknown_day
      FROM crossing c
  )
  SELECT units.user_id, units.unit_id AS app_id,
         CASE WHEN resolved.unknown_day
           THEN (resolved.source_day::date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'UTC'
           ELSE resolved.crossed_at END AS activity_at,
         CASE WHEN resolved.crossed_at IS NULL THEN NULL
           WHEN resolved.unknown_day THEN 'day' ELSE 'instant' END AS timestamp_precision
    FROM (SELECT DISTINCT user_id, unit_id FROM daily) units
    LEFT JOIN resolved USING (user_id, unit_id)
`;

async function appUsageTimes(pool, candidates, window, { seconds, perApp, ownApps = false }) {
  if (!candidates.length) return new Map();
  const { rows } = await pool.query(APP_USAGE_TIMES_SQL, [
    window.startMs == null ? '1970-01-01T00:00:00.000Z' : new Date(window.startMs).toISOString(),
    window.endMs == null ? new Date().toISOString() : new Date(window.endMs).toISOString(),
    seconds, ownApps, perApp,
    [...new Set(candidates.map((r) => Number(r.user_id)))],
    perApp ? [...new Set(candidates.map((r) => Number(r.app_id)))] : [],
  ]);
  return new Map(rows.map((r) => [`${r.user_id}:${perApp ? r.app_id : 0}`, r]));
}

module.exports = { appUsageTimes, APP_USAGE_TIMES_SQL };
