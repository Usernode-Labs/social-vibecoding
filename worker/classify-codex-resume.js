'use strict';

// Decide whether a failed `codex exec resume` is safe to retry as a fresh
// thread. Codex JSONL contains model messages and command output, so searching
// the raw stream for an error phrase can mistake ordinary turn output for a
// resume failure and repeat paid work. Fail closed unless the pinned JSONL
// contract contains only terminal error events and at least one of those
// errors explicitly reports that the saved thread is unavailable.

const fs = require('node:fs');

const MISSING_THREAD_RE = /(?:thread|session) not found|local rollout unavailable/i;
// Codex 0.146.0 reports a missing local rollout before its JSONL writer starts,
// so this one pinned CLI diagnostic is necessarily plain stderr. Keep the
// match anchored and narrow; arbitrary raw text containing a trigger phrase
// is not trusted.
const MISSING_LOCAL_ROLLOUT_LINE_RE = /^Error:\s+thread\/resume:\s+thread\/resume failed:\s+no rollout found for thread id [a-z0-9_-]+ \(code -32600\)$/i;
const BENIGN_PATH_WARNING_RE = /^WARNING:\s+proceeding, even though we could not create PATH aliases:/;
const TERMINAL_ERROR_TYPES = new Set(['error', 'turn.failed']);

function errorMessage(event) {
  if (event?.message != null) return String(event.message);
  if (event?.error?.message != null) return String(event.error.message);
  return '';
}

function classifyResumeJsonl(text) {
  let sawMissingThreadError = false;
  let sawMissingLocalRolloutDiagnostic = false;
  let sawConflictingError = false;
  let sawStructuredActivity = false;
  let sawUntrustedRawDiagnostic = false;

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (MISSING_LOCAL_ROLLOUT_LINE_RE.test(line.trim())) {
        sawMissingLocalRolloutDiagnostic = true;
      } else if (!BENIGN_PATH_WARNING_RE.test(line.trim())) {
        sawUntrustedRawDiagnostic = true;
      }
      // Other stderr diagnostics are never sufficient to authorize another
      // paid request because their provenance is ambiguous.
      continue;
    }

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      sawStructuredActivity = true;
      continue;
    }

    if (!TERMINAL_ERROR_TYPES.has(event.type)) {
      // This includes thread.started, turn.started, and every item event. A
      // resumed thread that emitted any of them was available and may already
      // have performed tool or external side effects.
      sawStructuredActivity = true;
      continue;
    }

    if (MISSING_THREAD_RE.test(errorMessage(event))) {
      sawMissingThreadError = true;
    } else {
      sawConflictingError = true;
    }
  }

  const sawSafeMissingThreadSignal = sawMissingThreadError || sawMissingLocalRolloutDiagnostic;
  const unsafeStream = sawConflictingError || sawStructuredActivity || sawUntrustedRawDiagnostic;
  return {
    retryFresh: sawSafeMissingThreadSignal && !unsafeStream,
    reason: sawSafeMissingThreadSignal
      ? (unsafeStream ? 'unsafe_mixed_stream' : 'thread_missing')
      : 'not_thread_missing',
  };
}

function classifyResumeFile(filePath) {
  return classifyResumeJsonl(fs.readFileSync(filePath, 'utf8'));
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) process.exit(2);
  try {
    process.exit(classifyResumeFile(filePath).retryFresh ? 0 : 1);
  } catch {
    process.exit(2);
  }
}

module.exports = { classifyResumeJsonl, classifyResumeFile };
