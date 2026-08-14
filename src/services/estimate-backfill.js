'use strict';

/**
 * Orphan sweeper for the progress-estimate accuracy dataset (#892).
 *
 * THE GAP. Every estimator tick INSERTs a `progress_estimates` row with its
 * prediction, and the turn's actual outcome is backfilled by a single UPDATE
 * in runClaudeCodeTool's dispatch `finally` (src/routes/sessions.js). That
 * choke point only exists inside the live turn — so if the server restarts,
 * crashes, or is redeployed mid-run, the rows for that run keep
 * `actual_total_ms IS NULL` forever and can never be scored. Measured in
 * production: 482 rows across 100 distinct runs, about 10% of all runs,
 * going back to the first day the table existed, with the daily unresolved
 * rate holding steady at 10-13%.
 *
 * WHY IT MATTERS NOW. The dashboard's v1-vs-v2 comparison needs a clean
 * denominator: a permanently-drifting unresolved count makes "did the new
 * prompt help?" harder to answer than it needs to be, and the unresolved
 * tile stops being a data-health signal once it only ever goes up.
 *
 * SAFETY. Every UPDATE is guarded on `actual_total_ms IS NULL`, so it can
 * never race or overwrite the live backfill — whichever runs first wins and
 * the other is a no-op. Rows are only considered once they are two hours
 * old, comfortably past any turn still legitimately in flight. Swept rows
 * are marked `outcome = 'unknown'` rather than being guessed into one of the
 * real outcome values: we know how long the run went, not how it ended.
 */

// `getPool` is required lazily inside sweep() rather than at module load:
// this module is otherwise pure SQL-building, and a top-level require would
// drag the `pg` driver into every context that merely wants to read the
// sweeper's constants (its own unit tests among them).
const log = require('./logger');

const SWEEP_INTERVAL_MS = 30 * 60_000;   // every 30 minutes
const FIRST_SWEEP_DELAY_MS = 2 * 60_000; // let boot settle first
// Only rows older than this are eligible. A turn can legitimately run for
// well over an hour (the longest observed was 1h45m), so this is set past
// any plausible in-flight run rather than at the median.
const ORPHAN_AGE_HOURS = 2;
// Ceiling per pass, so a large historical backlog is worked through over
// several ticks instead of in one long transaction.
const MAX_RUNS_PER_SWEEP = 200;

/**
 * Resolve orphaned rows one run (progress_message_id) at a time.
 *
 * The turn's end is derived from the owning session: when `active_turn` is
 * clear the session's own last-updated stamp is the best available end time;
 * otherwise (a session whose active_turn was never cleared either) we fall
 * back to the last estimate tick for that run plus one estimator cadence,
 * which is an upper bound on when the run could still have been alive.
 */
async function sweepOnce(pool) {
  const { rows } = await pool.query(
    `WITH orphan AS (
       SELECT pe.progress_message_id                     AS pm,
              MIN(pe.session_id)                         AS session_id,
              MAX(pe.created_at)                         AS last_tick_at,
              MAX(pe.elapsed_ms)                         AS last_elapsed_ms,
              COUNT(*)::int                              AS ticks
         FROM progress_estimates pe
        WHERE pe.actual_total_ms IS NULL
          AND pe.progress_message_id IS NOT NULL
          AND pe.created_at < NOW() - ($1 || ' hours')::interval
        GROUP BY pe.progress_message_id
        ORDER BY MAX(pe.created_at)
        LIMIT $2
     )
     SELECT o.pm,
            o.ticks,
            -- The run's total wall clock. A clear active_turn means the
            -- session finished, so its last_activity_at is the closest thing
            -- to a real end stamp; otherwise bound it by the last tick plus
            -- one 60s estimator cadence.
            GREATEST(
              o.last_elapsed_ms + 60000,
              CASE
                WHEN cs.active_turn IS NULL AND cs.last_activity_at > o.last_tick_at
                  THEN o.last_elapsed_ms
                       + EXTRACT(EPOCH FROM (cs.last_activity_at - o.last_tick_at)) * 1000
                ELSE o.last_elapsed_ms + 60000
              END
            )::bigint AS total_ms
       FROM orphan o
       LEFT JOIN chat_sessions cs ON cs.id = o.session_id`,
    [String(ORPHAN_AGE_HOURS), MAX_RUNS_PER_SWEEP]
  );

  if (!rows.length) return { runs: 0, ticks: 0 };

  let ticks = 0;
  for (const r of rows) {
    // The `actual_total_ms IS NULL` guard is what makes this safe to run
    // beside the live backfill — never remove it.
    const res = await pool.query(
      `UPDATE progress_estimates
          SET actual_total_ms     = $1,
              actual_remaining_ms = $1 - elapsed_ms,
              outcome             = 'unknown',
              resolved_at         = NOW()
        WHERE progress_message_id = $2
          AND actual_total_ms IS NULL`,
      [Math.round(Number(r.total_ms) || 0), r.pm]
    );
    ticks += res.rowCount || 0;
  }
  return { runs: rows.length, ticks };
}

async function sweep(config) {
  const { getPool } = require('../db/pool');
  const pool = getPool(config);
  const { runs, ticks } = await sweepOnce(pool);
  if (runs) {
    log.info('estimate-backfill', 'Resolved orphaned progress estimates', { runs, ticks });
  }
  return { runs, ticks };
}

function start(config) {
  log.info('estimate-backfill', 'Starting', { intervalMs: SWEEP_INTERVAL_MS });
  setTimeout(() => {
    sweep(config).catch((err) => log.error('estimate-backfill', 'Initial sweep failed', { err: err.message }));
  }, FIRST_SWEEP_DELAY_MS).unref?.();
  setInterval(() => {
    sweep(config).catch((err) => log.error('estimate-backfill', 'Sweep failed', { err: err.message }));
  }, SWEEP_INTERVAL_MS).unref?.();
}

module.exports = {
  start,
  sweep,
  sweepOnce,
  SWEEP_INTERVAL_MS,
  ORPHAN_AGE_HOURS,
  MAX_RUNS_PER_SWEEP,
};
