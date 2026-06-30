// Append-only, fire-and-forget capture for the admin /debug view.
//
// Records a verbose, step-by-step trace of every PR merge attempt and
// every automatic conflict-resolution attempt into the merge_debug_runs /
// merge_debug_steps tables (schema.sql). It is the merge-pipeline sibling
// of services/events.js: a missed debug row must NEVER break or slow down
// the merge it describes, so every primitive here swallows its own errors
// and the hot path does not depend on a write succeeding.
//
// Secret hygiene: every `message` and `detail` is run through the logger's
// SENSITIVE_PATTERNS scrubber before it touches the DB, so a token that
// slips into an error string (e.g. a credentialed git URL in an Octokit
// error) is redacted the same way the /status ring buffer redacts it.
//
// Threading model: startRun() returns a numeric runId (the row's BIGSERIAL
// id). Callers thread that id into step()/endRun() and — for the resolver →
// checkAndMerge re-entry — down through the options objects as `debugRunId`
// so a conflict-resolution sync and its retried merge land in ONE run.

const { getPool } = require('../db/pool');
const log = require('./logger');

// Per-run monotonic step counter. seq is assigned synchronously here
// BEFORE the async INSERT, so ordering-by-seq is correct regardless of the
// order the fire-and-forget inserts actually land in. Entries are dropped
// on endRun(); a process restart abandons the run (and its counter) anyway.
const _seq = new Map(); // runId -> next seq (int)

function nextSeq(runId) {
  const n = _seq.get(runId) || 0;
  _seq.set(runId, n + 1);
  return n;
}

function resolvePool(poolOrConfig) {
  if (poolOrConfig && typeof poolOrConfig.query === 'function') return poolOrConfig;
  return getPool(poolOrConfig);
}

// Start a run. Returns a Promise<number|null> — the new run's id, or null
// if the insert failed (callers treat null as "debug capture is off" and
// simply pass it to step()/endRun(), which no-op on a null runId). Cheap
// single INSERT; the two top-level entry points (checkAndMerge and the
// resolver's per-PR resolve) await it once to obtain the id to thread.
async function startRun(poolOrConfig, { appId, sessionId, prNumber, kind, trigger } = {}) {
  try {
    const pool = resolvePool(poolOrConfig);
    const { rows } = await pool.query(
      `INSERT INTO merge_debug_runs (app_id, session_id, pr_number, kind, trigger, status)
       VALUES ($1, $2, $3, $4, $5, 'running')
       RETURNING id`,
      [
        appId ?? null,
        sessionId ?? null,
        prNumber ?? null,
        kind || 'merge',
        trigger || null,
      ]
    );
    const runId = rows[0]?.id != null ? Number(rows[0].id) : null;
    if (runId != null) _seq.set(runId, 0);
    return runId;
  } catch (err) {
    log.debug('merge-debug', 'startRun failed', { err: err && err.message });
    return null;
  }
}

// Append one step to a run. Fire-and-forget: returns a promise that always
// resolves. A null/undefined runId is a no-op (so call sites need no guard).
function step(poolOrConfig, runId, { phase, level, message, detail } = {}) {
  try {
    if (runId == null) return Promise.resolve();
    const pool = resolvePool(poolOrConfig);
    const seq = nextSeq(runId);
    const safeMessage = message == null ? null : log.redactString(String(message));
    const safeDetail = detail == null ? {} : log.redactDeep(detail);
    const lvl = level === 'warn' || level === 'error' ? level : 'info';
    const result = pool.query(
      `INSERT INTO merge_debug_steps (run_id, seq, phase, level, message, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [runId, seq, phase || null, lvl, safeMessage, JSON.stringify(safeDetail || {})]
    );
    if (result && typeof result.then === 'function') {
      return result.then(() => {}).catch((err) => {
        log.debug('merge-debug', 'step failed', { runId, err: err.message });
      });
    }
    return Promise.resolve();
  } catch (err) {
    log.debug('merge-debug', 'step skipped', { runId, err: err && err.message });
    return Promise.resolve();
  }
}

// Stamp a terminal status + summary on a run and release its seq counter.
// Fire-and-forget; always resolves.
function endRun(poolOrConfig, runId, { status, summary } = {}) {
  try {
    if (runId == null) return Promise.resolve();
    const pool = resolvePool(poolOrConfig);
    const safeSummary = summary == null ? null : log.redactString(String(summary));
    const result = pool.query(
      `UPDATE merge_debug_runs
          SET status = COALESCE($2, status), summary = COALESCE($3, summary), ended_at = NOW()
        WHERE id = $1`,
      [runId, status || null, safeSummary]
    );
    const done = () => { _seq.delete(runId); };
    if (result && typeof result.then === 'function') {
      return result.then(done).catch((err) => {
        done();
        log.debug('merge-debug', 'endRun failed', { runId, err: err.message });
      });
    }
    done();
    return Promise.resolve();
  } catch (err) {
    _seq.delete(runId);
    log.debug('merge-debug', 'endRun skipped', { runId, err: err && err.message });
    return Promise.resolve();
  }
}

// Retention sweep — delete runs older than `days` (steps cascade). Bounds
// table growth on a busy platform. Best-effort; logs the row count. Called
// at boot and on a slow timer from server.js.
async function pruneOldRuns(poolOrConfig, days = 30) {
  try {
    const pool = resolvePool(poolOrConfig);
    const n = Math.max(1, parseInt(days, 10) || 30);
    const { rowCount } = await pool.query(
      `DELETE FROM merge_debug_runs WHERE started_at < NOW() - ($1 || ' days')::interval`,
      [String(n)]
    );
    if (rowCount) log.info('merge-debug', 'Pruned old merge-debug runs', { deleted: rowCount, olderThanDays: n });
    return rowCount || 0;
  } catch (err) {
    log.warn('merge-debug', 'pruneOldRuns failed', { err: err.message });
    return 0;
  }
}

module.exports = { startRun, step, endRun, pruneOldRuns };
