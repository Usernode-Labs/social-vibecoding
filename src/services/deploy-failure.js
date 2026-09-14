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
 *   stage  : 'database' | 'repo' | 'clone' | 'build' | 'start' |
 *            'healthcheck' | 'timeout' | 'other'
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

const { mentionsConnectionLimit, connectionExhaustionMessage } = require('../db/connection-census');

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

// child_process.execFile formats a rejection's message as
//   `Command failed: <the entire argv>\n<stderr>`
// and a `docker run` argv is every -e env var the container gets. That is
// kilobytes of command line in front of the one line that matters, so a
// 280-char reason was nothing but a truncated command and the daemon's
// actual complaint never reached the proposal author. Drop the command
// line and keep what the process said on stderr.
function stripCommandFailedPrefix(message) {
  const text = String(message || '');
  if (!/^Command failed:/.test(text)) return text;
  const nl = text.indexOf('\n');
  const tail = nl === -1 ? '' : pickReasonLine(text.slice(nl + 1));
  return tail || text;
}

// ─── Infrastructure vs the diff (#1771) ────────────────────────────────
//
// A preview whose container cannot get a Postgres connection dies exactly
// like a preview with a broken migration: non-zero exit, boot logs, a
// healthcheck that never passes. The difference is invisible at this layer
// unless something looks for it, and because nothing did, the proposal
// author was handed "[exited] error: sorry, too many clients already" as
// their own build's failure. It was not. Every OTHER proposal in the fleet
// was about to fail the same way for the same reason.
//
// So look for it. Every blob the boot path can hand us is a candidate,
// because which one carries Postgres's complaint depends on how the app
// exits: a crash on first query puts it in containerLogs, a `docker run`
// the daemon refused puts it on stderr, and a rejected execFile buries it
// in the message.
function bootFailureIsInfrastructure(err) {
  if (!err) return false;
  return err.infrastructure === true || mentionsConnectionLimit(err.containerLogs)
    || mentionsConnectionLimit(err.stderr)
    || mentionsConnectionLimit(err.message);
}

// Legacy shape: extract a concise, human-readable reason from a
// build/boot failure (docker.waitForHealthy attaches containerLogs /
// containerStatus to the thrown error). Kept byte-compatible with the
// old visuals.summarizeBootFailure for check_error_detail consumers.
function summarizeBootFailure(err) {
  // One exception to the byte-compatibility above, and it is the point of
  // #1771: when the boot logs show the shared Postgres refusing the
  // connection, the most specific error line is the WRONG answer. It is
  // true, it is about this container, and it still sends the author to
  // re-read a diff that was never involved. Say what happened instead.
  if (mentionsConnectionLimit(err?.containerLogs) || mentionsConnectionLimit(err?.stderr) || mentionsConnectionLimit(err?.message)) {
    return capReason(connectionExhaustionMessage(null, { where: 'started' }));
  }
  const logs = (err && err.containerLogs) ? String(err.containerLogs) : '';
  let reason = pickReasonLine(logs);
  // No container logs at all means the container never got far enough to
  // produce any — a `docker run` the daemon refused outright (a bad
  // --hostname, a name collision, an unsatisfiable resource limit). Its
  // explanation is on the rejection's stderr, nowhere else.
  if (!reason && err && err.stderr) reason = pickReasonLine(err.stderr);
  if (!reason) reason = (err && err.message) ? stripCommandFailedPrefix(err.message) : '';
  if (!reason) reason = 'staging preview failed to start';
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
      // Carried so the checks pipeline can record this as 'error' (retried,
      // escalated to the platform owner) rather than 'failing' (blamed on
      // the diff, sticky to the commit). Persisted records ignore it.
      infrastructure: bootFailureIsInfrastructure(err),
    };
  }
  if (err && err.buildFailed) {
    const log = truncateLog(err.buildLog || '');
    let reason;
    if (err.killed) {
      const seconds = Number.isFinite(err.buildTimeoutSeconds) && err.buildTimeoutSeconds > 0
        ? err.buildTimeoutSeconds : 300;
      reason = seconds % 60 === 0
        ? `Build timed out after ${seconds / 60} minute${seconds === 60 ? '' : 's'}`
        : `Build timed out after ${seconds} seconds`;
    } else {
      const line = pickReasonLine(log);
      reason = line ? `Build failed: ${line}` : `Build failed: ${err.message || 'unknown error'}`;
    }
    return { stage: 'build', reason: capReason(reason), log };
  }
  const stage = opts.stage
    || (err && err.repoFailed ? 'repo' : null)
    || (err && err.cloneFailed ? 'clone' : null)
    || 'other';
  // Clone timeouts / ENOENT-style failures carry no .stderr — fall back
  // to err.message, but prefer stderr when execFile captured any.
  const stderr = err && err.stderr ? truncateLog(err.stderr) : '';
  const message = (err && err.message) ? String(err.message) : 'deploy failed';
  // Same unwrapping as summarizeBootFailure: a rejected execFile puts its
  // entire argv in front of the real message, and `docker run`'s argv is
  // long enough to consume the whole 280-char budget on its own. Prefer the
  // process's own stderr line; failing that, drop the command line.
  const detail = pickReasonLine(stderr) || stripCommandFailedPrefix(message);
  const reason = capReason(
    stage === 'repo' ? `GitHub repo creation failed: ${detail}` : detail
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
  bootFailureIsInfrastructure,
  truncateLog,
  stripAnsi,
  MAX_REASON,
  MAX_LOG,
};
