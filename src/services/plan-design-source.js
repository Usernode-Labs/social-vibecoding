'use strict';

// Artifacts, stage 0 (docs/plans/artifacts.md): a plan made from a design
// stores which design it came from (chat_session_specs.design_thread_id and
// design_version, written by request-specs.js postRequestSpec when
// design-threads.js postDesignPlan posts it). The migration that added the
// two columns (src/db/migrations/plan-design-source.sql) filled the plans
// posted before it, once, from their own words.
//
// One gap is left that a migration cannot close: a release runs the build
// from before beside this one for some minutes, AFTER the migration ran, and
// a plan the older build posts in that window names its design only in its
// words, as plans always did. This fills those at boot, with the same
// expression, so the next deploy after a rollout puts them right.
//
// Safe to run on every boot:
//   - idempotent: only rows still empty are written, and a row is written
//     with what its own words say, so a second run changes nothing;
//   - bounded: plans of the last `days` only, at most `limit` rows, and only
//     plans on a request a design thread of their author filed or posted on
//     (the threads are found first; the plans through the index on
//     chat_sessions (app_id, created_from_issue_number, user_id), the same
//     triple postRequestSpec finds a plan's record by);
//   - a design's only: a plain page is never posted as a plan;
//   - never fails a boot: an error is logged, and the rows wait for the next.
//
// A plan reached only through chat_sessions.linked_issues is not looked for:
// postRequestSpec makes every plan's record with created_from_issue_number
// set to its request, and linked_issues holding that one number, and nothing
// else writes a plan's record.

const log = require('./logger');

// The words a plan made from a design says its after side in (planHtml):
// "after is version 4 of the design" or "after is version 2, a mockup". At
// most six digits, so the cast cannot overflow.
const VERSION_WORDS = String.raw`\mafter is version ([0-9]{1,6})(?:, a mockup| of the design)\M`;

const FILL_SQL = `
  UPDATE chat_session_specs s
     SET design_thread_id = found.thread_id,
         design_version = found.version
    FROM (
      SELECT DISTINCT ON (sp.id) sp.id, t.id AS thread_id,
             substring(sp.content_html from '${VERSION_WORDS}')::int AS version
        FROM private_threads t
        JOIN design_threads d ON d.private_thread_id = t.id AND d.kind = 'design'
        JOIN chat_sessions cs ON cs.app_id = t.app_id AND cs.created_from_issue_number = t.result_ref
                             AND cs.user_id = t.user_id AND cs.source = 'request_spec'
        JOIN chat_session_specs sp ON sp.session_id = cs.id
       WHERE t.state IN ('filed', 'posted')
         AND t.updated_at > NOW() - make_interval(days => $1::int)
         AND sp.created_at > NOW() - make_interval(days => $1::int)
         AND sp.design_version IS NULL
         AND sp.content_html IS NOT NULL
         AND substring(sp.content_html from '${VERSION_WORDS}') IS NOT NULL
       ORDER BY sp.id, t.updated_at DESC, t.id DESC
       LIMIT $2::int
    ) found
   WHERE s.id = found.id
     AND s.design_version IS NULL
     AND found.version > 0`;

/**
 * Fill the design a recent plan came from, where the plan was posted by a
 * build that did not store it. Resolves the number of plans filled; never
 * rejects.
 */
async function backfill(pool, { days = 7, limit = 200 } = {}) {
  try {
    const { rowCount } = await pool.query(FILL_SQL, [Math.max(1, Math.round(days)), Math.max(1, Math.round(limit))]);
    if (rowCount) log.info('db', 'Plans posted by an older build now name the design they came from', { plans: rowCount });
    return rowCount || 0;
  } catch (err) {
    log.warn('db', 'Could not name the designs of recent plans', { err: err.message });
    return 0;
  }
}

module.exports = { VERSION_WORDS, FILL_SQL, backfill };
