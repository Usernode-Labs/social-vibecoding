'use strict';

/**
 * How long a process the release replaced keeps finishing its work
 * (docs/plans/draining-releases.md). server.js cleanup() asks `untilIdle`
 * once it has stopped leading and refuses anything new: it resolves when the
 * process holds nothing, at the drain deadline, or when too many newer
 * processes are draining too, whichever comes first, and says every
 * REPORT_EVERY_MS what is still running.
 */

const log = require('./logger');

const POLL_MS = 1000;
const SUPERSEDE_EVERY_MS = 10 * 1000;
const REPORT_EVERY_MS = 60 * 1000;
// Releases faster than work finishes: at most this many processes of a role
// drain beside the one serving, the oldest handing its work over first.
const DEFAULT_DRAINING_MAX = 2;

function drainingMax(env = process.env) {
  const raw = env.PLATFORM_DRAINING_MAX;
  if (raw == null || String(raw).trim() === '') return DEFAULT_DRAINING_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DRAINING_MAX;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Waits until `idle()` is true, `deadline` (epoch ms) passes, or
 * `superseded()` (asked every `supersedeEveryMs`) resolves true. Never
 * rejects. Resolves { reason: 'idle' | 'deadline' | 'superseded', waitedMs }.
 */
async function untilIdle({
  deadline,
  idle,
  superseded = async () => false,
  describe = () => ({}),
  pollMs = POLL_MS,
  supersedeEveryMs = SUPERSEDE_EVERY_MS,
  reportEveryMs = REPORT_EVERY_MS,
  now = Date.now,
  sleep = realSleep,
}) {
  const started = now();
  let askedAt = started;
  let reportedAt = started;
  const done = (reason) => ({ reason, waitedMs: now() - started });
  for (;;) {
    let isIdle = false;
    try { isIdle = !!idle(); } catch { isIdle = false; }
    if (isIdle) return done('idle');
    if (now() >= deadline) return done('deadline');
    if (now() - askedAt >= supersedeEveryMs) {
      askedAt = now();
      let yes = false;
      try { yes = !!(await superseded()); } catch { yes = false; }
      if (yes) return done('superseded');
    }
    if (now() - reportedAt >= reportEveryMs) {
      reportedAt = now();
      let what = {};
      try { what = describe() || {}; } catch { what = {}; }
      log.info('drain', 'Still finishing work before exiting', { ...what, leftMs: Math.max(0, deadline - now()) });
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

module.exports = {
  POLL_MS,
  SUPERSEDE_EVERY_MS,
  REPORT_EVERY_MS,
  DEFAULT_DRAINING_MAX,
  drainingMax,
  untilIdle,
};
