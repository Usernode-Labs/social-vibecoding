'use strict';

// Threads, stage 1 of #6019: every request, change, governance row and
// message about a piece of work is attached to one thread
// (src/db/schema.sql, "Threads"). The schema's triggers attach every new
// row; this attaches the rows that were there before, once.
//
// It is idempotent by its predicates: every statement touches only rows
// with no thread yet, and makes a numbered thread with ON CONFLICT DO
// NOTHING, so running it again, or after a run cut short, attaches what is
// left and changes nothing else. A `platform_settings` marker records a
// completed pass so later boots cost one lookup. Deleting the marker runs it
// again, which is safe.
//
// Messages are the large table, so they go in id ranges, set-based per
// range: a numbered thread is made for each request a message names first,
// then the messages are joined to it. Nothing here fails the boot: a step
// that throws is logged, the marker stays unset, and the next boot retries.

const log = require('./logger');

const MARKER_KEY = 'threads_backfilled_v1';
const MESSAGE_BATCH = 10000;
const SESSION_BATCH = 2000;

async function markerSet(pool) {
  const { rows } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [MARKER_KEY]);
  return rows.length > 0;
}

async function setMarker(pool) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description) VALUES ($1, 'true', $2)
     ON CONFLICT (key) DO NOTHING`,
    [
      MARKER_KEY,
      'Marker: every request, change, governance row and message that existed when threads arrived (#6019, stage 1) '
      + 'has been attached to its thread. Deleting it re-runs the pass on the next boot, which is safe: it only '
      + 'attaches rows that have no thread.',
    ]
  );
}

// Requests: one thread per request number.
async function attachRequests(pool) {
  await pool.query(
    `INSERT INTO threads (app_id, number)
     SELECT app_id, number FROM requests WHERE thread_id IS NULL
     ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING`
  );
  const { rowCount } = await pool.query(
    `UPDATE requests r SET thread_id = t.id
       FROM threads t
      WHERE r.thread_id IS NULL AND t.app_id = r.app_id AND t.number = r.number`
  );
  return rowCount;
}

// Governance rows: a request's twin and a proposal to close join a number's
// thread; any other kind gets a decision thread of its own (the schema's
// issue_thread_id, the same rule the trigger applies). A twin with no number
// and a proposal to close that names none have no thread to join, so they
// are left out rather than rewritten as unattached on every pass.
async function attachIssues(pool) {
  const { rowCount } = await pool.query(
    `UPDATE issues
        SET thread_id = issue_thread_id(app_id, kind, github_issue_number, payload, title)
      WHERE thread_id IS NULL AND app_id IS NOT NULL
        AND NOT (kind = 'general' AND github_issue_number IS NULL)
        AND NOT (kind = 'close_issue' AND COALESCE(payload ->> 'issueNumber', '') !~ '^[0-9]{1,9}$')`
  );
  return rowCount;
}

// Changes, in id ranges: the schema's session_thread_id, the trigger's rule.
// Each one that gets a thread carries its replies with it (the
// chat_sessions_carry_thread_messages trigger).
async function attachSessions(pool, { batch = SESSION_BATCH } = {}) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM chat_sessions');
  const max = Number(rows[0].max) || 0;
  let attached = 0;
  for (let lo = 0; lo <= max; lo += batch) {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions
          SET thread_id = session_thread_id(app_id, linked_issues, created_from_issue_number,
                                            pr_number, branch_name, pr_title)
        WHERE id > $1 AND id <= $2 AND thread_id IS NULL AND app_id IS NOT NULL
          AND (cardinality(COALESCE(linked_issues, '{}')) > 0
               OR created_from_issue_number IS NOT NULL OR pr_number IS NOT NULL)`,
      [lo, lo + batch]
    );
    attached += rowCount;
  }
  return attached;
}

// Messages, in id ranges. A request's discussion names its number: make the
// threads those numbers need first, then join. A change's and a governance
// row's discussion join the thread their row already has.
async function attachMessages(pool, { batch = MESSAGE_BATCH } = {}) {
  await pool.query(
    `INSERT INTO threads (app_id, number)
     SELECT DISTINCT app_id, thread_ref FROM chat_messages
      WHERE thread_type = 'issue' AND thread_id IS NULL AND app_id IS NOT NULL AND thread_ref > 0
     ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING`
  );
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM chat_messages');
  const max = Number(rows[0].max) || 0;
  let attached = 0;
  for (let lo = 0; lo <= max; lo += batch) {
    const range = [lo, lo + batch];
    const issue = await pool.query(
      `UPDATE chat_messages m SET thread_id = t.id
         FROM threads t
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'issue'
          AND t.app_id = m.app_id AND t.number = m.thread_ref`,
      range
    );
    const session = await pool.query(
      `UPDATE chat_messages m SET thread_id = s.thread_id
         FROM chat_sessions s
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'session'
          AND s.id = m.thread_ref AND s.app_id = m.app_id AND s.thread_id IS NOT NULL`,
      range
    );
    const governance = await pool.query(
      `UPDATE chat_messages m SET thread_id = i.thread_id
         FROM issues i
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'governance'
          AND i.id = m.thread_ref AND i.app_id = m.app_id AND i.thread_id IS NOT NULL`,
      range
    );
    attached += issue.rowCount + session.rowCount + governance.rowCount;
  }
  return attached;
}

/**
 * Attach every row that existed before threads did. Requests and governance
 * rows first, then changes, then messages, so each message's anchor already
 * has its thread. Returns the counts, or `{ skipped }`.
 */
async function backfill(pool, { batch = {} } = {}) {
  try {
    if (await markerSet(pool)) return { skipped: 'done' };
  } catch (err) {
    log.warn('threads', 'Backfill not run: the marker could not be read', { err: err.message });
    return { skipped: 'unavailable' };
  }
  const started = Date.now();
  const counts = {};
  try {
    counts.requests = await attachRequests(pool);
    counts.issues = await attachIssues(pool);
    counts.sessions = await attachSessions(pool, { batch: batch.sessions });
    counts.messages = await attachMessages(pool, { batch: batch.messages });
    await setMarker(pool);
  } catch (err) {
    log.error('threads', 'Backfill stopped; the next boot carries on from where it got to', {
      err: err.message, ...counts,
    });
    return { failed: true, ...counts };
  }
  log.info('threads', 'Threads backfilled', { ...counts, ms: Date.now() - started });
  return counts;
}

module.exports = {
  MARKER_KEY,
  MESSAGE_BATCH,
  SESSION_BATCH,
  attachRequests,
  attachIssues,
  attachSessions,
  attachMessages,
  backfill,
};
