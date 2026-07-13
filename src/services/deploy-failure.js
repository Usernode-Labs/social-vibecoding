'use strict';

/**
 * Shared classifier for build/deploy failures (issue #416).
 *
 * Every production deploy path (createApp / finalizeDeploy /
 * rebuildProduction) funnels its caught error through classify() to get
 * a persistable `apps.last_failure` record:
 *
 *   { stage, reason, log, at, sha }
 *
 *   stage  : 'clone' | 'build' | 'start' | 'healthcheck' | 'timeout' | 'other'
 *   reason : concise human-readable line, <= 280 chars (same budget as
 *            chat_sessions.check_error_detail)
 *   log    : raw tail of the docker build output / container boot logs,
 *            ANSI-stripped, capped at 16 kB
 *   at     : ISO timestamp of the failure
 *   sha    : commit the failed deploy was building, when known
 *
 * The error-line extraction here is the former
 * visuals.summarizeBootFailure — moved so both the proposal-checks path
 * (staging) and the production deploy path share one implementation.
 * visuals.js re-exports summarizeBootFailure from this module, so the
 * legacy string shape is unchanged for existing consumers.
 */

const MAX_REASON = 280;
const MAX_LOG = 16 * 1024;

// Matches the "most specific error line" heuristic used by the staging
// checks pipeline — the app's own crash message beats generic wrapper text.
const ERR_LINE_RE = /(^error\b|Error:|errno|ECONNREFUSED|EADDRINUSE|panic|Unhandled|SQLSTATE|syntax error|does not exist|no unique or exclusion constraint|relation .* does not exist|cannot |failed)/i;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

// ANSI-strip + keep only the last MAX_LOG bytes. Used at capture time
// (docker.buildImage) and defensively again at persist time.
function truncateLog(s, max = MAX_LOG) {
  const clean = stripAnsi(s).trim();
  return clean.length > max ? clean.slice(-max) : clean;
}

function capReason(reason) {
  const r = String(reason || '').trim();
  return r.length > MAX_REASON ? `${r.slice(0, MAX_REASON - 1)}…` : r;
}

// Last error-looking line of a log blob (falls back to the last
// non-empty line). Empty string when the blob is empty.
function pickReasonLine(logs) {
  const lines = String(logs || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERR_LINE_RE.test(lines[i])) return lines[i];
  }
  return lines.length ? lines[lines.length - 1] : '';
}

// Legacy shape: extract a concise, human-readable reason from a
// build/boot failure (docker.waitForHealthy attaches containerLogs /
// containerStatus to the thrown error). Kept byte-compatible with the
// old visuals.summarizeBootFailure for check_error_detail consumers.
function summarizeBootFailure(err) {
  const logs = (err && err.containerLogs) ? String(err.containerLogs) : '';
  let reason = pickReasonLine(logs);
  if (!reason) reason = (err && err.message) ? String(err.message) : 'staging preview failed to start';
  if (err && err.containerStatus) reason = `[${err.containerStatus}] ${reason}`;
  return capReason(reason);
}

// Map a caught deploy error onto { stage, reason, log }. `opts.stage`
// lets a call site that knows better (e.g. the git-clone wrapper) force
// the stage for errors that carry no marker of their own.
function classify(err, opts = {}) {
  if (err && err.healthcheckFailed) {
    return {
      stage: 'healthcheck',
      reason: summarizeBootFailure(err),
      log: truncateLog(err.containerLogs || ''),
    };
  }
  if (err && err.buildFailed) {
    const log = truncateLog(err.buildLog || '');
    let reason;
    if (err.killed) {
      reason = 'Build timed out after 5 minutes';
    } else {
      const line = pickReasonLine(log);
      reason = line ? `Build failed: ${line}` : `Build failed: ${err.message || 'unknown error'}`;
    }
    return { stage: 'build', reason: capReason(reason), log };
  }
  const stage = opts.stage || (err && err.cloneFailed ? 'clone' : 'other');
  // Clone timeouts / ENOENT-style failures carry no .stderr — fall back
  // to err.message, but prefer stderr when execFile captured any.
  const stderr = err && err.stderr ? truncateLog(err.stderr) : '';
  const reason = capReason(
    (err && err.message) ? String(err.message) : 'deploy failed'
  );
  return { stage, reason, log: stderr };
}

// Full apps.last_failure record for a caught deploy error.
function record(err, opts = {}) {
  const { stage, reason, log } = classify(err, opts);
  return {
    stage,
    reason,
    log,
    at: new Date().toISOString(),
    sha: opts.sha || null,
  };
}

// Synthetic record for failures that never produced an error object
// (creation watchdog, boot sweep, kickoff catches). Callers persist it
// with a COALESCE guard so it never clobbers a real captured failure.
function syntheticRecord(stage, reason) {
  return {
    stage,
    reason: capReason(reason),
    log: '',
    at: new Date().toISOString(),
    sha: null,
  };
}

module.exports = {
  classify,
  record,
  syntheticRecord,
  summarizeBootFailure,
  truncateLog,
  stripAnsi,
  MAX_REASON,
  MAX_LOG,
};
